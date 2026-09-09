// "Jobs" — a real job site's address, geocoded once, so a radius ad
// (routes/ads.js) can target the immediate area around it. Deliberately
// not a CRM — see migrations/1757100000000_jobs_and_geocode_usage.js.
const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../auth');
const { checkAndIncrementCounter } = require('../lib/usage');
const { geocodeAddress } = require('../lib/googlePlaces');
const { qualifiesForPermits } = require('../lib/realEstateAccess');

const router = express.Router();

async function requireJobsEligibleTenant(req, res) {
  const tenantRes = await query('SELECT industry, company_name FROM tenants WHERE id = $1', [req.tenantId]);
  if (!tenantRes.rows.length) {
    res.status(404).json({ error: { message: 'Tenant not found.' } });
    return null;
  }
  if (!qualifiesForPermits({ industry: tenantRes.rows[0].industry, companyName: tenantRes.rows[0].company_name })) {
    res.status(403).json({ error: { message: 'This feature is only available for real estate, home services, or construction accounts.' } });
    return null;
  }
  return tenantRes.rows[0];
}

router.post('/api/jobs', requireAuth, async (req, res) => {
  try {
    const tenant = await requireJobsEligibleTenant(req, res);
    if (!tenant) return;

    const rawAddress = String(req.body?.address || '').trim();
    if (!rawAddress) {
      return res.status(400).json({ error: { message: 'An address is required.' } });
    }
    const label = req.body?.label ? String(req.body.label).trim().slice(0, 120) : null;
    const startedAt = req.body?.startedAt || null;
    const completedAt = req.body?.completedAt || null;

    if (!process.env.GOOGLE_PLACES_API_KEY) {
      return res.status(503).json({ error: { message: 'Job-site geocoding is not configured on this server yet (missing GOOGLE_PLACES_API_KEY).' } });
    }

    const usage = await checkAndIncrementCounter(req.tenantId, { capColumn: 'monthly_job_geocode_cap', counterColumn: 'job_geocode_count' });
    if (!usage.allowed) {
      return res.status(429).json({ error: { message: `Monthly job-site limit reached (${usage.used}/${usage.cap}). Upgrade your plan for more.` } });
    }

    const geocoded = await geocodeAddress(rawAddress);
    if (!geocoded) {
      return res.status(422).json({ error: { message: `Couldn't find a location for "${rawAddress}" — check the address and try again.` } });
    }

    const result = await query(
      `INSERT INTO jobs (tenant_id, label, raw_address, formatted_address, zip, latitude, longitude, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [req.tenantId, label, rawAddress, geocoded.formattedAddress, geocoded.zip, geocoded.lat, geocoded.lng, startedAt, completedAt]
    );

    res.json({ job: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to add job site: ' + err.message } });
  }
});

router.get('/api/jobs', requireAuth, async (req, res) => {
  try {
    const result = await query('SELECT * FROM jobs WHERE tenant_id = $1 ORDER BY created_at DESC', [req.tenantId]);
    res.json({ jobs: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load job sites: ' + err.message } });
  }
});

router.delete('/api/jobs/:id', requireAuth, async (req, res) => {
  try {
    const result = await query('DELETE FROM jobs WHERE id = $1 AND tenant_id = $2 RETURNING id', [req.params.id, req.tenantId]);
    if (!result.rows.length) {
      return res.status(404).json({ error: { message: 'Job site not found.' } });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to delete job site: ' + err.message } });
  }
});

module.exports = router;
