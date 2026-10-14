// Lead intake for Eagle I CRM (lib/crmIntake.js): the settings the team sees,
// and the public website inquiry form at /crm/f/<key>.
//
// The /api/crm/* routes sit behind routes/crm.js's sign-in and "company has
// the CRM" check (mounted after it). The form's own routes need no login.
const express = require('express');
const path = require('path');
const { requireAuth } = require('../auth');
const intake = require('../lib/crmIntake');
const team = require('../lib/crmTeam');

const router = express.Router();
const baseUrlOf = (req) => `${req.protocol}://${req.get('host')}`;

function fail(res, err, what) {
  const status = err.status || 500;
  res.status(status).json({ error: { message: status === 500 ? `${what}: ${err.message}` : err.message } });
}

router.get('/api/crm/intake', requireAuth, async (req, res) => {
  try { res.json(intake.intakeInfo(await intake.getIntakeKey(req.tenantId), baseUrlOf(req))); } catch (err) { fail(res, err, 'Failed to load lead intake'); }
});

router.post('/api/crm/intake/rotate', requireAuth, async (req, res) => {
  if (!team.isManager(req.crmUser && req.crmUser.role)) return res.status(403).json({ error: { message: 'Only the owner or an admin can change this.' } });
  try { res.json(intake.intakeInfo(await intake.rotateIntakeKey(req.tenantId), baseUrlOf(req))); } catch (err) { fail(res, err, 'Failed to make a new link'); }
});

// Per-address limit on the public form, on top of the per-company limit in lib/crmIntake.js.
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 3600000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 6;
}

router.get('/crm/f/:key', (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  res.sendFile(path.join(__dirname, '..', 'public', 'crm-form.html'));
});

router.get('/api/crm-public/forms/:key', async (req, res) => {
  try {
    const t = await intake.tenantByKey(req.params.key);
    if (!t) return res.status(404).json({ error: { message: 'This form is no longer active.' } });
    res.json({ companyName: t.company_name });
  } catch (err) { fail(res, err, 'Failed to load the form'); }
});

router.post('/api/crm-public/forms/:key', async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: { message: 'Too many requests. Please try again later.' } });
  try { await intake.submitForm({ key: req.params.key, body: req.body, baseUrl: baseUrlOf(req) }); res.json({ ok: true }); }
  catch (err) { fail(res, err, 'Failed to send'); }
});

module.exports = router;
