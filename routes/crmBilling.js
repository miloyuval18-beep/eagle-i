// Plans and billing for Eagle I CRM (lib/crmBilling.js). Sits behind
// routes/crm.js's sign-in and "company has the CRM" check (mounted after it);
// these routes work even while the CRM is read-only.
const express = require('express');
const { requireAuth } = require('../auth');
const billing = require('../lib/crmBilling');
const team = require('../lib/crmTeam');

const router = express.Router();
const baseUrlOf = (req) => `${req.protocol}://${req.get('host')}`;
const wrap = (what, fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) { const st = err.status || 500; res.status(st).json({ error: { message: st === 500 ? `${what}: ${err.message}` : err.message } }); }
};
const managersOnly = (req, res) => { if (team.isManager(req.crmUser && req.crmUser.role)) return false; res.status(403).json({ error: { message: 'Only the owner or an admin can change the plan.' } }); return true; };

router.get('/api/crm/billing', requireAuth, wrap('Failed to load your plan', async (req, res) => res.json(await billing.overview(req.tenantId))));
router.post('/api/crm/billing/checkout', requireAuth, wrap('Failed to open checkout', async (req, res) => {
  if (managersOnly(req, res)) return;
  const b = req.body || {};
  res.json(await billing.checkout({ tenantId: req.tenantId, plan: b.plan, interval: b.interval, baseUrl: baseUrlOf(req), email: req.crmUser && req.crmUser.email }));
}));
router.post('/api/crm/billing/portal', requireAuth, wrap('Failed to open billing', async (req, res) => {
  if (managersOnly(req, res)) return;
  res.json(await billing.portal({ tenantId: req.tenantId, baseUrl: baseUrlOf(req) }));
}));

module.exports = router;
