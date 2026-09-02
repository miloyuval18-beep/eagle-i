// Real Houston building-permit data for real-estate/home-services tenants —
// see lib/houstonPermits.js for where this actually comes from and its
// real limitations (no owner name field; weekly, not live).
const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../auth');
const { getRecentPermits } = require('../lib/houstonPermits');
const { HOUSTON_HIGH_VALUE_ZIPS, getHighValueZipInfo } = require('../lib/houstonZipValues');
const { getRealHcadZipStatsForZips } = require('../lib/hcadZipValues');
const { getZipRegion } = require('../lib/houstonZipRegions');
const { buildPermitLetter } = require('../lib/permitMailer');

const router = express.Router();
const REAL_ESTATE_INDUSTRIES = new Set(['home_services', 'real_estate']);

router.get('/api/permits/high-value-areas', requireAuth, async (req, res) => {
  try {
    const tenantRes = await query('SELECT industry FROM tenants WHERE id = $1', [req.tenantId]);
    if (!tenantRes.rows.length) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    if (!REAL_ESTATE_INDUSTRIES.has(tenantRes.rows[0].industry)) {
      return res.status(403).json({ error: { message: 'This feature is only available for real estate / home services accounts.' } });
    }

    const forceRefresh = req.query.refresh === 'true';
    const { records, fetchedAt, failures } = await getRecentPermits({ weeksBack: 4, forceRefresh });

    const byZip = new Map();
    for (const rec of records) {
      if (!byZip.has(rec.zip)) byZip.set(rec.zip, []);
      byZip.get(rec.zip).push(rec);
    }

    const hcadByZip = await getRealHcadZipStatsForZips([...byZip.keys()]);

    const areas = [...byZip.entries()].map(([zip, permits]) => {
      const zipInfo = getHighValueZipInfo(zip);
      const hcad = hcadByZip.get(zip) || null;
      return {
        zip,
        // Broad area label for grouping/filtering — covers every zip the
        // permit reports touch, not just the curated high-value list (see
        // lib/houstonZipRegions.js). Falls back to the zip itself when even
        // that broader list has no entry, so grouping never drops a permit.
        region: getZipRegion(zip) || (zipInfo ? zipInfo.neighborhood : null) || `Zip ${zip}`,
        neighborhood: zipInfo ? zipInfo.neighborhood : null,
        approxMedianValue: zipInfo ? zipInfo.approxMedianValue : null,
        highValue: !!zipInfo,
        // Single best-available value estimate for this zip, for "top N by
        // value" selection on the Permits page — same preference order as
        // the sort below (real HCAD data first, then the curated estimate,
        // 0 when neither is known so those permits simply rank last).
        estValue: hcad ? hcad.avgMarketValue : (zipInfo ? zipInfo.approxMedianValue : 0),
        hcad, // real HCAD appraisal-district data, when the import has covered this zip — see lib/hcadZipValues.js
        permitCount: permits.length,
        permits: permits
          .sort((a, b) => (b.permitDate || '').localeCompare(a.permitDate || ''))
          .slice(0, 25) // cap per zip so one busy zip doesn't dwarf the response
      };
    });

    // Real HCAD data ranks first when present (it's the most trustworthy
    // signal); the curated high-value list is the fallback ranking signal
    // for zips HCAD import hasn't covered yet; permit volume breaks ties.
    areas.sort((a, b) => {
      if (!!a.hcad !== !!b.hcad) return a.hcad ? -1 : 1;
      if (a.hcad) return b.hcad.avgMarketValue - a.hcad.avgMarketValue;
      if (a.highValue !== b.highValue) return a.highValue ? -1 : 1;
      if (a.highValue) return b.approxMedianValue - a.approxMedianValue;
      return b.permitCount - a.permitCount;
    });

    res.json({
      areas,
      totalPermits: records.length,
      fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null,
      sourceFailures: failures && failures.length ? failures : undefined,
      trackedHighValueZipCount: HOUSTON_HIGH_VALUE_ZIPS.length
    });
  } catch (err) {
    res.status(502).json({ error: { message: 'Failed to load permit data: ' + err.message } });
  }
});

// Caps how much text a single field can carry into a letter — the client
// is expected to send back exactly the permit rows it just received from
// the endpoint above, but this is still user-reachable input, so keep
// individual fields bounded regardless of what's actually sent.
const MAX_FIELD_LEN = 300;
function cleanField(v) {
  return String(v == null ? '' : v).slice(0, MAX_FIELD_LEN);
}

// Builds one personalized letter per selected permit — see
// lib/permitMailer.js for why this is a deterministic template rather than
// an AI call (a batch here can be up to 200 letters). The client already
// has the full permit + area data from GET /api/permits/high-value-areas
// above (same pattern already used by the CSV export), so it sends back
// exactly the rows the tenant selected rather than re-fetching permits by
// some id — permits have no stable id in the source data. The tenant's own
// business-profile fields are read fresh from the database here, not
// trusted from the client, so a letter always reflects what's actually
// saved on the account.
router.post('/api/permits/mailer-letters', requireAuth, async (req, res) => {
  try {
    const tenantRes = await query('SELECT company_name, industry FROM tenants WHERE id = $1', [req.tenantId]);
    if (!tenantRes.rows.length) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    if (!REAL_ESTATE_INDUSTRIES.has(tenantRes.rows[0].industry)) {
      return res.status(403).json({ error: { message: 'This feature is only available for real estate / home services accounts.' } });
    }

    const permits = Array.isArray(req.body.permits) ? req.body.permits : [];
    if (!permits.length) return res.status(400).json({ error: { message: 'No permits selected.' } });
    if (permits.length > 200) return res.status(400).json({ error: { message: 'Select 200 permits or fewer at a time.' } });

    const profileRes = await query(
      'SELECT founder_name, phone, email, services, differentiators FROM business_profile WHERE tenant_id = $1',
      [req.tenantId]
    );
    const profile = profileRes.rows[0] || {};
    const tenant = {
      name: tenantRes.rows[0].company_name,
      founder: profile.founder_name,
      phone: profile.phone,
      email: profile.email,
      services: profile.services,
      unique: profile.differentiators
    };

    const letters = permits.map(p => {
      const zip = cleanField(p && p.zip).replace(/[^0-9]/g, '').slice(0, 5);
      const zipInfo = getHighValueZipInfo(zip);
      const region = getZipRegion(zip) || (zipInfo ? zipInfo.neighborhood : null) || (zip ? `Zip ${zip}` : '');
      const permit = {
        address: cleanField(p && p.address),
        permitType: cleanField(p && p.permitType),
        permitDate: cleanField(p && p.permitDate),
        projectNo: cleanField(p && p.projectNo)
      };
      const letter = buildPermitLetter({ permit, area: { zip, region }, tenant });
      return { ...letter, permitType: permit.permitType, permitDate: permit.permitDate, projectNo: permit.projectNo, region };
    });

    res.json({
      letters,
      tenant: { name: tenant.name, founder: tenant.founder, phone: tenant.phone, email: tenant.email }
    });
  } catch (err) {
    res.status(502).json({ error: { message: 'Failed to build mailer letters: ' + err.message } });
  }
});

module.exports = router;
