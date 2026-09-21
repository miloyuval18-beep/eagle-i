// One API for every verified-vendor category (see lib/vendorDirectories.js):
// list with filters + ranking, location facets, one-vendor contact lookup,
// and the guarded bulk-email flow. The panel in index.html is generated
// from GET /api/vendor-directory/catalog, so adding a category means
// adding it to the registry — no new route or UI copy.
const express = require('express');
const { requireAuth } = require('../auth');
const { checkAndIncrementPlacesUsage } = require('../lib/usage');
const { searchNearbyCompetitors } = require('../lib/googlePlaces');
const { findContactEmail } = require('../lib/vendorContactFinder');
const { stripLegalSuffix, isLikelySameBusiness } = require('../lib/placesMatch');
const dir = require('../lib/vendorDirectories');
const outreach = require('../lib/vendorOutreach');

const router = express.Router();

router.get('/api/vendor-directory/catalog', requireAuth, (req, res) => {
  res.json({ sections: dir.getCatalog(), sorts: dir.SORTS });
});

function parseFilters(q) {
  return {
    search: (q.search || '').toString().slice(0, 80),
    locations: (q.locations || '').toString().split('|').map(s => s.trim()).filter(Boolean).slice(0, 60),
    contact: ['has_email', 'unchecked', 'no_email'].includes(q.contact) ? q.contact : '',
    minRating: [3.5, 4, 4.5].includes(Number(q.minRating)) ? Number(q.minRating) : null,
    hideEmailed: q.hideEmailed === '1' || q.hideEmailed === 'true'
  };
}

router.get('/api/vendor-directory/:source/:category/facets', requireAuth, async (req, res) => {
  try {
    res.json(await dir.getFacets({ source: req.params.source, category: req.params.category }));
  } catch (err) {
    const bad = /^Unknown/.test(err.message);
    res.status(bad ? 404 : 500).json({ error: { message: bad ? err.message : 'Failed to load filters: ' + err.message } });
  }
});

// limit goes up to 200 so "Top N" can select across the whole filtered set
// (the biggest Top-N option), not just the page the user has scrolled to.
router.get('/api/vendor-directory/:source/:category', requireAuth, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 40, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  try {
    const { total, rows, sort } = await dir.listDirectory({
      source: req.params.source, category: req.params.category,
      filters: parseFilters(req.query), sort: (req.query.sort || '').toString(),
      limit, offset, tenantId: req.tenantId
    });
    res.json({ total, sort, rows, hasMore: offset + rows.length < total });
  } catch (err) {
    const bad = /^Unknown/.test(err.message);
    res.status(bad ? 404 : 500).json({ error: { message: bad ? err.message : 'Failed to load vendors: ' + err.message } });
  }
});

// Google lookup for one vendor: find its listing, phone, website, rating,
// and a published email. Cached forever once done (refresh=true to redo), so
// each business is paid for at most once. Places returns its best guess even
// when that's a different business, so a result is only used when its name
// and location agree with the government record (lib/placesMatch.js).
router.post('/api/vendor-directory/:source/:id/find-contact', requireAuth, async (req, res) => {
  const sourceKey = req.params.source;
  const id = parseInt(req.params.id, 10);
  if (!dir.SOURCES[sourceKey]) return res.status(404).json({ error: { message: 'Unknown source.' } });
  if (!Number.isFinite(id)) return res.status(400).json({ error: { message: 'Invalid id.' } });

  try {
    const row = await dir.getRowForLookup(sourceKey, id);
    if (!row) return res.status(404).json({ error: { message: 'Not found.' } });

    if (row.contact_checked_at && req.query.refresh !== 'true') {
      return res.json({
        website: row.website, phone: dir.formatPhone(row.phone), email: row.contact_email,
        address: row.places_formatted_address, matchedName: row.places_matched_name,
        rating: row.google_rating !== null ? Number(row.google_rating) : null,
        reviewCount: row.google_review_count,
        legacyUnverified: !!(row.contact_email && !row.places_matched_name),
        source: 'cache'
      });
    }
    if (!row.name) return res.json({ website: null, email: null, address: null, source: 'live', reason: 'No business name on file.' });
    if (!process.env.GOOGLE_PLACES_API_KEY) {
      return res.status(503).json({ error: { message: 'Lookup is not configured on this server yet (missing GOOGLE_PLACES_API_KEY).' } });
    }

    const usage = await checkAndIncrementPlacesUsage(req.tenantId);
    if (!usage.allowed) {
      return res.status(429).json({ error: { message: `Monthly lookup limit reached (${usage.used}/${usage.cap}). Upgrade your plan for more.`, code: 'lookup_cap' } });
    }

    const results = await searchNearbyCompetitors({ services: stripLegalSuffix(row.name), serviceArea: row.area, resultCount: 1 });
    const top = results[0];
    const agrees = (name) => top && isLikelySameBusiness({
      recordName: name, recordCity: row.city, recordZip: row.zip,
      matchedName: top.name, matchedAddress: top.address, allowedCities: dir.METRO_CITIES
    });
    const match = top && (agrees(row.name) || (row.alt_name && agrees(row.alt_name))) ? top : null;

    let email = null;
    if (match && match.website) {
      const contact = await findContactEmail(match.website);
      email = contact.email || null;
    }
    await dir.saveContact(sourceKey, id, {
      website: match?.website, phone: match?.phone, contactEmail: email, address: match?.address,
      matchedName: match?.name, rating: match?.rating, reviewCount: match?.reviewCount
    });

    res.json({
      website: match?.website || null, phone: match?.phone ? dir.formatPhone(match.phone) : dir.formatPhone(row.phone), email,
      address: match?.address || null, matchedName: match?.name || null,
      rating: match?.rating ?? null, reviewCount: match?.reviewCount ?? null, source: 'live',
      reason: match
        ? (email ? null : 'No published email found on their website.')
        : (top
            ? `Closest Google result was "${top.name}" (${top.address || 'no address'}), which doesn't look like the same business — not used.`
            : 'No matching business found on Google.')
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Contact lookup failed: ' + err.message } });
  }
});

// ---- Bulk outreach ---------------------------------------------------
// Bulk send is deliberately a two-step flow the UI gates behind a human
// review: PREVIEW says exactly who would and wouldn't be emailed (and why),
// SEND re-runs the same screening server-side — never trusting the preview —
// and enforces the daily cap. Nothing here sends on its own.

router.get('/api/vendors/outreach-bulk/status', requireAuth, async (req, res) => {
  try {
    const ctx = await outreach.getSenderContext(req.tenantId);
    if (!ctx) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    const used = await outreach.sentInLast24h(req.tenantId);
    res.json({
      dailyCap: outreach.BULK_DAILY_CAP, sentLast24h: used, remaining: Math.max(0, outreach.BULK_DAILY_CAP - used),
      hasAddress: (ctx.profile.address || '').trim().length >= 8,
      configured: !!process.env.RESEND_API_KEY
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load send limits: ' + err.message } });
  }
});

router.post('/api/vendors/outreach-bulk/preview', requireAuth, async (req, res) => {
  const recipients = (req.body && req.body.recipients) || [];
  if (!Array.isArray(recipients) || recipients.length > 500) {
    return res.status(400).json({ error: { message: 'recipients must be a list of at most 500.' } });
  }
  try {
    const { sendable, skipped } = await outreach.screenRecipients(req.tenantId, recipients);
    const used = await outreach.sentInLast24h(req.tenantId);
    res.json({ sendable, skipped, dailyCap: outreach.BULK_DAILY_CAP, remaining: Math.max(0, outreach.BULK_DAILY_CAP - used) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Preview failed: ' + err.message } });
  }
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// At most 25 per call — the client sends a large batch as several calls, so
// no single request runs long enough to hit a proxy timeout.
router.post('/api/vendors/outreach-bulk/send', requireAuth, async (req, res) => {
  const { recipients, message } = req.body || {};
  if (!Array.isArray(recipients) || !recipients.length || recipients.length > 25) {
    return res.status(400).json({ error: { message: 'Send between 1 and 25 recipients per request.' } });
  }
  if (!message || !String(message).trim()) return res.status(400).json({ error: { message: 'Message text is required.' } });
  if (!process.env.RESEND_API_KEY) {
    return res.status(503).json({ error: { message: 'Outreach emails are not configured on this server yet (missing RESEND_API_KEY).' } });
  }
  try {
    const ctx = await outreach.getSenderContext(req.tenantId);
    if (!ctx) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    // A physical postal address is required in commercial email (CAN-SPAM),
    // and this is where it comes from — refuse rather than send without it.
    if ((ctx.profile.address || '').trim().length < 8) {
      return res.status(400).json({ error: { message: 'Add your business address in your profile before sending bulk email — it is required in the footer of commercial email.', code: 'address_required' } });
    }
    const { sendable, skipped } = await outreach.screenRecipients(req.tenantId, recipients);
    const used = await outreach.sentInLast24h(req.tenantId);
    const remaining = Math.max(0, outreach.BULK_DAILY_CAP - used);
    const toSend = sendable.slice(0, remaining);
    const capped = sendable.slice(remaining).map(r => ({ ...r, reason: 'daily_cap' }));

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const results = [...skipped, ...capped].map(r => ({ email: r.email, name: r.name, status: 'skipped', reason: r.reason }));
    for (let i = 0; i < toSend.length; i++) {
      if (i > 0) await sleep(outreach.SEND_SPACING_MS);
      const r = toSend[i];
      const out = await outreach.sendOutreach({ tenantId: req.tenantId, ctx, baseUrl, toEmail: r.email, vendorName: r.name, message: String(message) });
      results.push(out.ok
        ? { email: r.email, name: r.name, status: 'sent' }
        : { email: r.email, name: r.name, status: out.reason === 'opted_out' ? 'skipped' : 'failed', reason: out.reason, error: out.error });
    }
    res.json({
      results,
      sent: results.filter(r => r.status === 'sent').length,
      failed: results.filter(r => r.status === 'failed').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      remaining: Math.max(0, remaining - toSend.length)
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Bulk send failed: ' + err.message } });
  }
});

module.exports = router;
