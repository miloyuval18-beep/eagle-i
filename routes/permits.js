// Real Houston building-permit data for real-estate/home-services tenants —
// see lib/houstonPermits.js for where this actually comes from and its
// real limitations (no owner name field; weekly, not live).
const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../auth');
const { getRecentPermits } = require('../lib/houstonPermits');
const { HOUSTON_HIGH_VALUE_ZIPS, getHighValueZipInfo } = require('../lib/houstonZipValues');
const { getRealHcadZipStatsForZips } = require('../lib/hcadZipValues');

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
        neighborhood: zipInfo ? zipInfo.neighborhood : null,
        approxMedianValue: zipInfo ? zipInfo.approxMedianValue : null,
        highValue: !!zipInfo,
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

module.exports = router;
