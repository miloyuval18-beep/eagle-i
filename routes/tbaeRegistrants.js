// Real, TBAE-verified architects and Registered Interior Designers in the
// Houston area — see migrations/..._tbae_registrants.js and
// scripts/importTbaeRoster.js for the data source. Distinct from the
// generic Places-based vendor search (routes/onboarding.js's
// GET /api/vendors/places): every result here is a currently-Active,
// state-registered professional, not just a business Places happens to
// return for a text search.
const express = require('express');
const { requireAuth } = require('../auth');
const { checkAndIncrementPlacesUsage } = require('../lib/usage');
const { searchNearbyCompetitors } = require('../lib/googlePlaces');
const { findContactEmail } = require('../lib/vendorContactFinder');
const { getHoustonAreaRegistrants, getRegistrantById, saveContactInfo } = require('../lib/tbaeRegistrants');

const router = express.Router();
const VALID_PROFESSIONS = new Set(['architect', 'interior_designer']);

// Same emailed-status pattern as routes/onboarding.js's markEmailedVendors,
// inlined here rather than shared since the two tables (vendor_outreach)
// join differ only in which name they match on.
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

router.get('/api/tbae/registrants', requireAuth, async (req, res) => {
  const profession = (req.query.profession || '').trim();
  if (!VALID_PROFESSIONS.has(profession)) {
    return res.status(400).json({ error: { message: 'profession must be "architect" or "interior_designer".' } });
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 40, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const search = (req.query.search || '').toString();

  try {
    const { total, registrants } = await getHoustonAreaRegistrants({ profession, search, limit, offset });
    res.json({
      total,
      registrants: await markEmailed(req.tenantId, registrants),
      hasMore: offset + registrants.length < total
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load TBAE registrants: ' + err.message } });
  }
});

// Looks up one registrant's real business listing via Places (by firm
// name + city, same Places API already used for vendor search — costs
// one Places lookup against this tenant's monthly quota), then attempts a
// published contact email off that website. Cached indefinitely on the
// registrant row once found — a firm's own listing doesn't change often,
// so this isn't re-run on every page view like the plain vendor cache is.
router.post('/api/tbae/registrants/:id/find-contact', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: { message: 'Invalid registrant id.' } });

  try {
    const registrant = await getRegistrantById(id);
    if (!registrant) return res.status(404).json({ error: { message: 'Registrant not found.' } });

    const forceRefresh = req.query.refresh === 'true';
    if (registrant.contact_checked_at && !forceRefresh) {
      return res.json({
        website: registrant.website,
        phone: registrant.phone,
        email: registrant.contact_email,
        address: registrant.places_formatted_address,
        source: 'cache'
      });
    }

    if (!registrant.firm_name) {
      return res.json({ website: null, phone: null, email: null, address: null, reason: 'No firm on file for this registrant — they opted out of publishing it.' });
    }
    if (!process.env.GOOGLE_PLACES_API_KEY) {
      return res.status(503).json({ error: { message: 'Firm lookup is not configured on this server yet (missing GOOGLE_PLACES_API_KEY).' } });
    }

    const usage = await checkAndIncrementPlacesUsage(req.tenantId);
    if (!usage.allowed) {
      return res.status(429).json({ error: { message: `Monthly lookup limit reached (${usage.used}/${usage.cap}). Upgrade your plan for more.` } });
    }

    const results = await searchNearbyCompetitors({
      services: registrant.firm_name,
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
      phone: match?.phone || null,
      contactEmail: email,
      placesFormattedAddress: match?.address || null
    });

    res.json({
      website: match?.website || null,
      phone: match?.phone || null,
      email,
      address: match?.address || null,
      source: 'live',
      reason: match ? (email ? null : 'No published email found on their website — type one manually, then send.') : 'No matching business found on Google for this firm.'
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Contact lookup failed: ' + err.message } });
  }
});

module.exports = router;
