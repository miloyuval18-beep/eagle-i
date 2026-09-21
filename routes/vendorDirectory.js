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
const { verifyEmail } = require('../lib/emailVerification');
const tpl = require('../lib/outreachTemplate');
const followUps = require('../lib/followUps');
const letters = require('../lib/vendorLetters');
const { query } = require('../db');

const router = express.Router();

router.get('/api/vendor-directory/catalog', requireAuth, (req, res) => {
  res.json({ sections: dir.getCatalog(), sorts: dir.SORTS });
});

function parseFilters(q) {
  return {
    search: (q.search || '').toString().slice(0, 80),
    locations: (q.locations || '').toString().split('|').map(s => s.trim()).filter(Boolean).slice(0, 60),
    contact: ['has_email', 'verified', 'unchecked', 'no_email', 'mailable'].includes(q.contact) ? q.contact : '',
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
        ...(row.email_check_status === 'invalid' ? { email: null } : {}),
        emailStatus: row.email_check_status || null,
        emailNote: dir.emailNote(row),
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

    let email = null, verification = null, droppedReason = null;
    if (match && match.website) {
      const contact = await findContactEmail(match.website);
      email = contact.email || null;
    }
    // The Google match was validated above, so the site check isn't needed —
    // but an address whose domain can't receive mail is never kept as usable.
    if (email) {
      verification = await verifyEmail({ email, website: match.website, businessName: row.name, checkSite: false });
      if (verification.status === 'invalid') { droppedReason = `Found ${email} on their website, but ${verification.reason} — not used.`; email = null; verification = null; }
    }
    await dir.saveContact(sourceKey, id, {
      website: match?.website, phone: match?.phone, contactEmail: email, address: match?.address,
      matchedName: match?.name, rating: match?.rating, reviewCount: match?.reviewCount,
      emailStatus: verification && verification.status, emailReason: verification && verification.reason
    });

    res.json({
      website: match?.website || null, phone: match?.phone ? dir.formatPhone(match.phone) : dir.formatPhone(row.phone), email,
      address: match?.address || null, matchedName: match?.name || null,
      rating: match?.rating ?? null, reviewCount: match?.reviewCount ?? null, source: 'live',
      emailStatus: verification ? verification.status : null,
      emailNote: email ? dir.emailNote({ contact_email: email, email_check_status: verification.status, email_check_reason: verification.reason }) : null,
      reason: match
        ? (email ? null : (droppedReason || 'No published email found on their website.'))
        : (top
            ? `Closest Google result was "${top.name}" (${top.address || 'no address'}), which doesn't look like the same business — not used.`
            : 'No matching business found on Google.')
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Contact lookup failed: ' + err.message } });
  }
});

// ---- Outreach message template ----------------------------------------
// The message is built from a per-tenant template (lib/outreachTemplate.js)
// filled with this tenant's profile and the category being emailed. {name}
// is left open here and filled per recipient when it is sent.

async function loadTemplateContext(tenantId) {
  const t = await query('SELECT company_name FROM tenants WHERE id = $1', [tenantId]);
  if (!t.rows.length) return null;
  const p = await query('SELECT founder_name, phone, email, site, service_area, linkedin_url, outreach_settings FROM business_profile WHERE tenant_id = $1', [tenantId]);
  const profile = p.rows[0] || {};
  return { tenant: t.rows[0], profile, settings: profile.outreach_settings || {} };
}

function resolveCategory(sourceKey, categoryKey) {
  const source = dir.SOURCES[sourceKey];
  const category = source && source.categories[categoryKey];
  return source && category ? { source, category } : null;
}

const templateResponse = (ctx, source, category) => {
  const vars = tpl.buildVariables({ ...ctx, source, category });
  const message = tpl.renderTemplate(tpl.templateFor(ctx.settings, source.intent), vars);
  return {
    intent: source.intent,
    message,
    letterMessage: tpl.letterize(message, ctx.profile), // same wording, adapted for paper
    followUp: {
      message: tpl.renderTemplate(tpl.followUpFor(ctx.settings, source.intent), vars),
      days: followUps.DEFAULT_DAYS,
      hasCustom: !!(ctx.settings.followups && ctx.settings.followups[source.intent])
    },
    settings: {
      linkedin: ctx.profile.linkedin_url || '', // from the company profile (Account Settings)
      blurb: ctx.settings.blurb || '',
      defaultBlurb: `${ctx.tenant.company_name} serves ${(ctx.profile.service_area || '').trim() || 'the Houston area'}.`,
      hasCustomTemplate: !!(ctx.settings.templates && ctx.settings.templates[source.intent])
    }
  };
};

router.get('/api/vendors/outreach-template', requireAuth, async (req, res) => {
  const found = resolveCategory(req.query.source, req.query.category);
  if (!found) return res.status(404).json({ error: { message: 'Unknown category.' } });
  try {
    const ctx = await loadTemplateContext(req.tenantId);
    if (!ctx) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    res.json(templateResponse(ctx, found.source, found.category));
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load the message: ' + err.message } });
  }
});

// Saves the company blurb and/or the message as this tenant's default
// wording for this relationship type. (The LinkedIn link is not saved here —
// it lives on the company profile.)
router.put('/api/vendors/outreach-template', requireAuth, async (req, res) => {
  const { source: sourceKey, category: categoryKey, message, followupMessage, blurb, saveTemplate, resetTemplate } = req.body || {};
  const found = resolveCategory(sourceKey, categoryKey);
  if (!found) return res.status(404).json({ error: { message: 'Unknown category.' } });

  if (blurb !== undefined && String(blurb).length > 600) {
    return res.status(400).json({ error: { message: 'The company description is limited to 600 characters.' } });
  }
  if (saveTemplate && (!message || String(message).length > tpl.MAX_TEMPLATE_CHARS)) {
    return res.status(400).json({ error: { message: `Message must be 1–${tpl.MAX_TEMPLATE_CHARS} characters.` } });
  }

  try {
    const ctx = await loadTemplateContext(req.tenantId);
    if (!ctx) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    const settings = { ...ctx.settings, templates: { ...(ctx.settings.templates || {}) }, followups: { ...(ctx.settings.followups || {}) } };

    // Turn the edited message back into a template using the values as they
    // were when it was rendered, BEFORE applying any new LinkedIn/blurb.
    if (saveTemplate) {
      const vars = tpl.buildVariables({ ...ctx, source: found.source, category: found.category });
      settings.templates[found.source.intent] = tpl.templatize(String(message), vars);
      if (followupMessage && String(followupMessage).length <= tpl.MAX_TEMPLATE_CHARS) {
        settings.followups[found.source.intent] = tpl.templatize(String(followupMessage), vars);
      }
    }
    if (resetTemplate) { delete settings.templates[found.source.intent]; delete settings.followups[found.source.intent]; }
    if (blurb !== undefined) settings.blurb = String(blurb).trim();

    await query('UPDATE business_profile SET outreach_settings = $1 WHERE tenant_id = $2', [JSON.stringify(settings), req.tenantId]);
    res.json(templateResponse({ ...ctx, settings }, found.source, found.category));
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to save: ' + err.message } });
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
  const { recipients, message, followUp } = req.body || {};
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
    // {name} is the only token allowed to be open; anything else still in the
    // text (e.g. a hand-typed {linkedin}) would be sent to real people as-is.
    const leftover = String(message).replace(/\{name\}/g, '').match(/\{[a-z_]+\}/);
    if (leftover) {
      return res.status(400).json({ error: { message: `The message still contains ${leftover[0]}. Remove it or fill it in before sending.`, code: 'unresolved_token' } });
    }
    // First occurrence of an address wins, matching how screening keeps the first.
    // The follow-up wording is held to the same rules as the message, since it
    // is sent to real people later without another look.
    const fu = followUp && followUp.enabled ? { message: String(followUp.message || '').trim(), days: followUps.clampDays(followUp.days) } : null;
    if (fu) {
      if (!fu.message || fu.message.length > tpl.MAX_TEMPLATE_CHARS) {
        return res.status(400).json({ error: { message: 'The follow-up message is empty or too long.', code: 'bad_followup' } });
      }
      const fuLeft = fu.message.replace(/\{name\}/g, '').match(/\{[a-z_]+\}/);
      if (fuLeft) return res.status(400).json({ error: { message: `The follow-up still contains ${fuLeft[0]}. Remove it or fill it in before sending.`, code: 'unresolved_token' } });
    }
    const greetingFor = new Map();
    for (const r of recipients) {
      const key = outreach.normEmail(r && r.email);
      if (!greetingFor.has(key)) greetingFor.set(key, (r && r.greeting) || tpl.friendlyGreeting(r && r.name, null));
    }
    const { sendable, skipped } = await outreach.screenRecipients(req.tenantId, recipients);
    const used = await outreach.sentInLast24h(req.tenantId);
    const remaining = Math.max(0, outreach.BULK_DAILY_CAP - used);
    const toSend = sendable.slice(0, remaining);
    const capped = sendable.slice(remaining).map(r => ({ ...r, reason: 'daily_cap' }));

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    let followUpsScheduled = 0;
    const results = [...skipped, ...capped].map(r => ({ email: r.email, name: r.name, status: 'skipped', reason: r.reason }));
    for (let i = 0; i < toSend.length; i++) {
      if (i > 0) await sleep(outreach.SEND_SPACING_MS);
      const r = toSend[i];
      const out = await outreach.sendOutreach({ tenantId: req.tenantId, ctx, baseUrl, toEmail: r.email, vendorName: r.name, message: tpl.fillName(String(message), greetingFor.get(r.email)) });
      if (out.ok && fu) {
        try {
          await followUps.scheduleFollowUp({
            tenantId: req.tenantId, outreachId: out.outreachId, toEmail: r.email, vendorName: r.name,
            message: tpl.fillName(fu.message, greetingFor.get(r.email)), days: fu.days, baseUrl
          });
          followUpsScheduled++;
        } catch (err) { console.error('[followUps] scheduling failed:', err.message); }
      }
      results.push(out.ok
        ? { email: r.email, name: r.name, status: 'sent' }
        : { email: r.email, name: r.name, status: out.reason === 'opted_out' ? 'skipped' : 'failed', reason: out.reason, error: out.error });
    }
    res.json({
      results,
      sent: results.filter(r => r.status === 'sent').length,
      failed: results.filter(r => r.status === 'failed').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      remaining: Math.max(0, remaining - toSend.length),
      followUpsScheduled, followUpDays: fu ? fu.days : null
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Bulk send failed: ' + err.message } });
  }
});

// ---- Mailed letters -----------------------------------------------------
// Builds the letters for the selected businesses (see lib/vendorLetters.js).
// Nothing is sent: the browser turns the result into a PDF the user prints and
// mails. Recording the batch is what lets the panel show "lettered" later.
router.post('/api/vendor-directory/:source/mailer-letters', requireAuth, async (req, res) => {
  const { category, ids, message, includeWithEmail, includeRecentlyLettered } = req.body || {};
  if (!Array.isArray(ids) || !ids.length || ids.length > letters.MAX_LETTERS) {
    return res.status(400).json({ error: { message: `Select between 1 and ${letters.MAX_LETTERS} businesses.` } });
  }
  if (!message || !String(message).trim() || String(message).length > tpl.MAX_TEMPLATE_CHARS) {
    return res.status(400).json({ error: { message: 'The letter text is empty or too long.' } });
  }
  const leftover = String(message).replace(/\{name\}/g, '').match(/\{[a-z_]+\}/);
  if (leftover) return res.status(400).json({ error: { message: `The letter still contains ${leftover[0]}. Remove it or fill it in first.`, code: 'unresolved_token' } });
  if (!resolveCategory(req.params.source, category)) return res.status(404).json({ error: { message: 'Unknown category.' } });

  try {
    const ctx = await outreach.getSenderContext(req.tenantId);
    if (!ctx) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    // A letter needs a return address, the same way the email footer does.
    if ((ctx.profile.address || '').trim().length < 8) {
      return res.status(400).json({ error: { message: 'Add your business address in your profile first — it goes at the top of each letter.', code: 'address_required' } });
    }
    const built = await letters.buildLetters({
      tenantId: req.tenantId, sourceKey: req.params.source, categoryKey: category, ids, message: String(message),
      includeWithEmail: !!includeWithEmail, includeRecentlyLettered: !!includeRecentlyLettered
    });
    const t = await loadTemplateContext(req.tenantId);
    res.json({
      ...built,
      sender: {
        company: ctx.companyName, founder: ctx.profile.founder_name || '', phone: ctx.profile.phone || '',
        email: ctx.profile.email || '', address: ctx.profile.address || '', site: tpl.cleanSite(t && t.profile.site)
      }
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to prepare letters: ' + err.message } });
  }
});

// ---- Scheduled follow-ups ---------------------------------------------
router.get('/api/vendors/followups', requireAuth, async (req, res) => {
  try {
    res.json(await followUps.listFollowUps(req.tenantId));
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load follow-ups: ' + err.message } });
  }
});
router.post('/api/vendors/followups/cancel-all', requireAuth, async (req, res) => {
  try {
    res.json({ cancelled: await followUps.cancelAll(req.tenantId) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to cancel: ' + err.message } });
  }
});
router.post('/api/vendors/followups/:id/cancel', requireAuth, async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: { message: 'Invalid id.' } });
  try {
    const n = await followUps.cancelOne(req.tenantId, req.params.id);
    if (!n) return res.status(404).json({ error: { message: 'That follow-up is no longer pending.' } });
    res.json({ cancelled: n });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to cancel: ' + err.message } });
  }
});

module.exports = router;
