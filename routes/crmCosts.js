// Job costing and the accountant's export (lib/crmCosts.js). Mounted after
// routes/crm.js, so every route here needs a signed-in person at a company
// that has the CRM. The export and deleting costs are for the owner and admins.
const express = require('express');
const { requireAuth } = require('../auth');
const costs = require('../lib/crmCosts');
const team = require('../lib/crmTeam');
const { query } = require('../db');

const router = express.Router();

function fail(res, err, what) {
  const status = err.status || 500;
  if (/invalid input syntax for type uuid/.test(err.message || '')) return res.status(404).json({ error: { message: 'Not found.' } });
  res.status(status).json({ error: { message: status === 500 ? `${what}: ${err.message}` : err.message } });
}
const manager = (req) => team.isManager(req.crmUser && req.crmUser.role);
const wrap = (what, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, what); } };
async function ownDeal(req, res) {
  const r = await query('SELECT id FROM crm_deals WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]).catch(() => ({ rows: [] }));
  if (!r.rows.length) { res.status(404).json({ error: { message: 'Deal not found.' } }); return false; }
  return true;
}

router.get('/api/crm/costing', requireAuth, wrap('Failed to load job costing', async (req, res) => res.json({ jobs: await costs.overview(req.tenantId) })));

router.get('/api/crm/deals/:id/costs', requireAuth, wrap('Failed to load costs', async (req, res) => {
  if (!(await ownDeal(req, res))) return;
  res.json({ summary: await costs.summary(req.tenantId, req.params.id), costs: await costs.listCosts(req.tenantId, req.params.id), categories: costs.CATEGORIES });
}));

router.post('/api/crm/deals/:id/costs', requireAuth, wrap('Failed to add the cost', async (req, res) => {
  const b = req.body || {};
  res.json({ ok: true, cost: await costs.addCost({ tenantId: req.tenantId, dealId: req.params.id, category: b.category, description: b.description, amount: b.amount, costDate: b.costDate, vendorId: b.vendorId || null, vendorName: b.vendorName, hours: b.hours, rate: b.rate, source: b.category === 'labor' && b.hours ? 'labor' : 'manual', userId: req.userId }) });
}));

router.post('/api/crm/deals/:id/receipts', requireAuth, wrap('Failed to add the receipt', async (req, res) => {
  if (!(await ownDeal(req, res))) return;
  const b = req.body || {};
  res.json({ ok: true, ...(await costs.addReceipt({ tenantId: req.tenantId, dealId: req.params.id, filename: b.filename, dataBase64: b.dataBase64, userId: req.userId, overrides: b.overrides || {} })) });
}));

router.delete('/api/crm/costs/:costId', requireAuth, wrap('Failed to delete the cost', async (req, res) => {
  if (!manager(req)) return res.status(403).json({ error: { message: 'Only the owner or an admin can delete costs.' } });
  if (!(await costs.deleteCost({ tenantId: req.tenantId, id: req.params.costId }))) return res.status(404).json({ error: { message: 'Cost not found.' } });
  res.json({ ok: true });
}));

router.get('/api/crm/export', requireAuth, wrap('Failed to export', async (req, res) => {
  if (!manager(req)) return res.status(403).json({ error: { message: 'Only the owner or an admin can export.' } });
  const { kind, from, to } = req.query;
  const body = await costs.exportCsv({ tenantId: req.tenantId, kind, from, to });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="eagle-i-${kind}-${from}-to-${to}.csv"`, 'Cache-Control': 'no-store' });
  res.send(body);
}));

module.exports = router;
