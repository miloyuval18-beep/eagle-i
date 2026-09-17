// Real, TDI-verified escrow officers (title company professionals) in
// the Houston area — see migrations/..._tdi_registrants.js. Honest
// limitation baked into this route's own reason strings: TDI's data has
// no business name or phone at all, so find-contact can only search
// Places by the licensee's own personal name — expect a lower hit rate
// than every other verified-vendor panel in this app.
const express = require('express');
const { requireAuth } = require('../auth');
const { checkAndIncrementPlacesUsage } = require('../lib/usage');
const { searchNearbyCompetitors } = require('../lib/googlePlaces');
const { findContactEmail } = require('../lib/vendorContactFinder');
const { getHoustonAreaRegistrants, getRegistrantById, saveContactInfo } = require('../lib/tdiRegistrants');

const router = express.Router();

const { query } = require('../db');
async function markEmailed(tenantId, registrants) {
  if (!registrants.length) return registrants;
  const sentRes = await query(
    `SELECT DISTINCT LOWER(vendor_name) AS name FROM vendor_outreach WHERE tenant_id = $1 AND status = 'sent'`,
    [tenantId]
  );
  const emailedNames = new Set(sentRes.rows.map(r => r.name));
  return registrants.map(r => ({ ...r, emailed: emailedNames.has(String(r.displayName || '').toLowerCase()) }));
}

router.get('/api/tdi/registrants', requireAuth, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 40, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const search = (req.query.search || '').toString();

  try {
    const { total, registrants } = await getHoustonAreaRegistrants({ search, limit, offset });
    res.json({
      total,
      registrants: await markEmailed(req.tenantId, registrants),
      hasMore: offset + registrants.length < total
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load TDI registrants: ' + err.message } });
  }
});

router.post('/api/tdi/registrants/:id/find-contact', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: { message: 'Invalid registrant id.' } });

  try {
    const registrant = await getRegistrantById(id);
    if (!registrant) return res.status(404).json({ error: { message: 'Registrant not found.' } });

    const forceRefresh = req.query.refresh === 'true';
    if (registrant.contact_checked_at && !forceRefresh) {
      return res.json({
        website: registrant.website,
        email: registrant.contact_email,
        address: registrant.places_formatted_address,
        source: 'cache'
      });
    }

    if (!registrant.name) {
      return res.json({ website: null, email: null, address: null, reason: 'No name on file for this registrant.' });
    }
    if (!process.env.GOOGLE_PLACES_API_KEY) {
      return res.status(503).json({ error: { message: 'Lookup is not configured on this server yet (missing GOOGLE_PLACES_API_KEY).' } });
    }

    const usage = await checkAndIncrementPlacesUsage(req.tenantId);
    if (!usage.allowed) {
      return res.status(429).json({ error: { message: `Monthly lookup limit reached (${usage.used}/${usage.cap}). Upgrade your plan for more.` } });
    }

    const results = await searchNearbyCompetitors({
      services: registrant.name,
      serviceArea: `${registrant.city || 'Houston'}, TX`,
      resultCount: 1
    });
    const match = results[0];

    let email = null;
    if (match && match.website) {
      const contact = await findContactEmail(match.website);
      email = contact.email || null;
    }

    await saveContactInfo(id, {
      website: match?.website || null,
      contactEmail: email,
      placesFormattedAddress: match?.address || null
    });

    res.json({
      website: match?.website || null,
      email,
      address: match?.address || null,
      source: 'live',
      reason: match ? (email ? null : 'No published email found on their website.') : 'No matching business found on Google for this name — TDI gives no business name or phone to search with, just a licensed individual.'
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Contact lookup failed: ' + err.message } });
  }
});

module.exports = router;
