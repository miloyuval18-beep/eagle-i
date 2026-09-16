// Real, TDLR-verified electricians and HVAC (A/C) contractors in the
// Houston area — see migrations/..._tdlr_registrants.js and
// scripts/importTdlrRegistrants.js for the data source. Structurally
// identical to routes/tbaeRegistrants.js; the main difference is TDLR's
// data already includes a real phone number directly from the state, so
// find-contact here only needs Places for a website (to then check for a
// published email), not for the phone itself.
const express = require('express');
const { requireAuth } = require('../auth');
const { checkAndIncrementPlacesUsage } = require('../lib/usage');
const { searchNearbyCompetitors } = require('../lib/googlePlaces');
const { findContactEmail } = require('../lib/vendorContactFinder');
const { getHoustonAreaRegistrants, getRegistrantById, saveContactInfo } = require('../lib/tdlrRegistrants');

const router = express.Router();
const VALID_LICENSE_TYPES = new Set(['Electrical Contractor', 'A/C Contractor']);

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

router.get('/api/tdlr/registrants', requireAuth, async (req, res) => {
  const licenseType = (req.query.licenseType || '').trim();
  if (!VALID_LICENSE_TYPES.has(licenseType)) {
    return res.status(400).json({ error: { message: 'licenseType must be "Electrical Contractor" or "A/C Contractor".' } });
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 40, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const search = (req.query.search || '').toString();

  try {
    const { total, registrants } = await getHoustonAreaRegistrants({ licenseType, search, limit, offset });
    res.json({
      total,
      registrants: await markEmailed(req.tenantId, registrants),
      hasMore: offset + registrants.length < total
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load TDLR registrants: ' + err.message } });
  }
});

// Looks up one registrant's real business listing via Places (by
// business name + city, same as routes/tbaeRegistrants.js's find-contact)
// to find a website worth checking for a published email — the phone
// number itself is already real, straight from TDLR's own data, no
// Places call needed for that part.
router.post('/api/tdlr/registrants/:id/find-contact', requireAuth, async (req, res) => {
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

    if (!registrant.business_name) {
      return res.json({ website: null, email: null, address: null, reason: 'No business name on file for this registrant.' });
    }
    if (!process.env.GOOGLE_PLACES_API_KEY) {
      return res.status(503).json({ error: { message: 'Firm lookup is not configured on this server yet (missing GOOGLE_PLACES_API_KEY).' } });
    }

    const usage = await checkAndIncrementPlacesUsage(req.tenantId);
    if (!usage.allowed) {
      return res.status(429).json({ error: { message: `Monthly lookup limit reached (${usage.used}/${usage.cap}). Upgrade your plan for more.` } });
    }

    const results = await searchNearbyCompetitors({
      services: registrant.business_name,
      serviceArea: `${registrant.business_city || 'Houston'}, TX`,
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
      reason: match ? (email ? null : 'No published email found on their website — the phone number above is already real, straight from TDLR.') : 'No matching business found on Google for this firm.'
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Contact lookup failed: ' + err.message } });
  }
});

module.exports = router;
