// Houston-area specialty-trade businesses (roofing, painting, flooring,
// ...) from the Comptroller's active sales-tax permit data — see
// migrations/..._comptroller_trades.js. NOT a license list; the panel's
// copy and badges say so. find-contact searches Places by business name
// plus the street address the source already gives us (far more precise
// than a bare name), and saves phone, Google rating/review count (the
// quality signal offered instead of a license), and the listing name it
// matched to so the human sees it at confirm time.
const express = require('express');
const { requireAuth } = require('../auth');
const { checkAndIncrementPlacesUsage } = require('../lib/usage');
const { searchNearbyCompetitors } = require('../lib/googlePlaces');
const { findContactEmail } = require('../lib/vendorContactFinder');
const { stripLegalSuffix, isLikelySameBusiness } = require('../lib/placesMatch');
const { TRADES, getHoustonAreaTrades, getRegistrantById, saveContactInfo } = require('../lib/comptrollerTrades');

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

router.get('/api/comptroller-trades', requireAuth, async (req, res) => {
  const trade = (req.query.trade || '').trim();
  if (!TRADES[trade]) {
    return res.status(400).json({ error: { message: `trade must be one of: ${Object.keys(TRADES).join(', ')}.` } });
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 40, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const search = (req.query.search || '').toString();

  try {
    const { total, registrants } = await getHoustonAreaTrades({ trade, search, limit, offset });
    res.json({
      total,
      registrants: await markEmailed(req.tenantId, registrants),
      hasMore: offset + registrants.length < total
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load trade businesses: ' + err.message } });
  }
});

router.post('/api/comptroller-trades/:id/find-contact', requireAuth, async (req, res) => {
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
        matchedName: registrant.places_matched_name,
        rating: registrant.google_rating !== null ? Number(registrant.google_rating) : null,
        reviewCount: registrant.google_review_count,
        source: 'cache'
      });
    }

    const searchName = registrant.outlet_name || registrant.taxpayer_name;
    if (!searchName) {
      return res.json({ website: null, email: null, address: null, reason: 'No business name on file for this registrant.' });
    }
    if (!process.env.GOOGLE_PLACES_API_KEY) {
      return res.status(503).json({ error: { message: 'Lookup is not configured on this server yet (missing GOOGLE_PLACES_API_KEY).' } });
    }

    const usage = await checkAndIncrementPlacesUsage(req.tenantId);
    if (!usage.allowed) {
      return res.status(429).json({ error: { message: `Monthly lookup limit reached (${usage.used}/${usage.cap}). Upgrade your plan for more.` } });
    }

    const results = await searchNearbyCompetitors({
      services: stripLegalSuffix(searchName),
      serviceArea: [registrant.outlet_address, registrant.outlet_city || 'Houston', 'TX'].filter(Boolean).join(', '),
      resultCount: 1
    });
    const top = results[0];
    // Places always returns its best guess; only accept it when name and
    // location actually agree with the Comptroller record (a sister business
    // at the same address is checked against the trade name, then the legal
    // name, so either can vouch for the match).
    const agrees = (name) => top && isLikelySameBusiness({
      recordName: name, recordCity: registrant.outlet_city, recordZip: registrant.outlet_zip,
      matchedName: top.name, matchedAddress: top.address
    });
    const match = top && (agrees(searchName) || agrees(registrant.taxpayer_name)) ? top : null;

    let email = null;
    if (match && match.website) {
      const contact = await findContactEmail(match.website);
      email = contact.email || null;
    }

    await saveContactInfo(id, {
      website: match?.website || null,
      phone: match?.phone || null,
      contactEmail: email,
      placesFormattedAddress: match?.address || null,
      matchedName: match?.name || null,
      rating: match?.rating,
      reviewCount: match?.reviewCount
    });

    res.json({
      website: match?.website || null,
      phone: match?.phone || null,
      email,
      address: match?.address || null,
      matchedName: match?.name || null,
      rating: match?.rating ?? null,
      reviewCount: match?.reviewCount ?? null,
      source: 'live',
      reason: match
        ? (email ? null : 'No published email found on their website.')
        : (top
            ? `Closest Google result was "${top.name}" (${top.address || 'no address'}), which doesn't look like the same business — not used.`
            : 'No matching business found on Google for this name and address.')
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Contact lookup failed: ' + err.message } });
  }
});

module.exports = router;
