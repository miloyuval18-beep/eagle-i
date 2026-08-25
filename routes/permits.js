// Real Houston building-permit data for real-estate/home-services tenants —
// see lib/houstonPermits.js for where this actually comes from and its
// real limitations (no owner name field; weekly, not live).
const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../auth');
const { getRecentPermits } = require('../lib/houstonPermits');
const { HOUSTON_HIGH_VALUE_ZIPS, getHighValueZipInfo } = require('../lib/houstonZipValues');

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

    const areas = [...byZip.entries()].map(([zip, permits]) => {
      const zipInfo = getHighValueZipInfo(zip);
      return {
        zip,
        neighborhood: zipInfo ? zipInfo.neighborhood : null,
        approxMedianValue: zipInfo ? zipInfo.approxMedianValue : null,
        highValue: !!zipInfo,
        permitCount: permits.length,
        permits: permits
          .sort((a, b) => (b.permitDate || '').localeCompare(a.permitDate || ''))
          .slice(0, 25) // cap per zip so one busy zip doesn't dwarf the response
      };
    });

    // High-value tracked zips first (richest first), then everything else
    // by permit volume — so the list is useful even for zips outside the
    // curated reference table, just clearly unlabeled as "high value."
    areas.sort((a, b) => {
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
