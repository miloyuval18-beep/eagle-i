// Running the job (lib/crmJobs.js): schedule, daily logs, subs and vendors,
// purchase orders, change orders and selections.
//
// /api/crm/* routes sit behind routes/crm.js's sign-in and "company has the
// CRM" check (mounted after it). The homeowner answers change orders and
// picks selections through their portal token, no login.
const express = require('express');
const { requireAuth } = require('../auth');
const jobs = require('../lib/crmJobs');
const team = require('../lib/crmTeam');
const { query } = require('../db');

const router = express.Router();
const baseUrlOf = (req) => `${req.protocol}://${req.get('host')}`;

function fail(res, err, what) {
  const status = err.status || 500;
  if (/invalid input syntax for type uuid/.test(err.message || '')) return res.status(404).json({ error: { message: 'Not found.' } });
  if (/RESEND_API_KEY/.test(err.message || '')) return res.status(503).json({ error: { message: 'Email sending is not set up on the server yet.' } });
  res.status(status).json({ error: { message: status === 500 ? `${what}: ${err.message}` : err.message } });
}
const manager = (req) => team.isManager(req.crmUser && req.crmUser.role);
async function ownDeal(req, res) {
  const r = await query('SELECT id FROM crm_deals WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]).catch(() => ({ rows: [] }));
  if (!r.rows.length) { res.status(404).json({ error: { message: 'Deal not found.' } }); return false; }
  return true;
}
const wrap = (what, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, what); } };

router.get('/api/crm/jobs', requireAuth, wrap('Failed to load jobs', async (req, res) => res.json({ jobs: await jobs.listJobs(req.tenantId) })));

router.get('/api/crm/deals/:id/job', requireAuth, wrap('Failed to load the job', async (req, res) => {
  if (!(await ownDeal(req, res))) return;
  const [schedule, logs, pos, cos, selections, vendors] = await Promise.all([
    jobs.listSchedule(req.tenantId, req.params.id), jobs.listLogs(req.tenantId, req.params.id), jobs.listPOs(req.tenantId, req.params.id),
    jobs.listCOs(req.tenantId, req.params.id), jobs.listSelections(req.tenantId, req.params.id), jobs.listVendors(req.tenantId)]);
  res.json({ schedule, logs, pos, cos, selections, vendors });
}));

// schedule
router.post('/api/crm/deals/:id/schedule/from-template', requireAuth, wrap('Failed to lay out the schedule', async (req, res) => {
  if (!(await ownDeal(req, res))) return;
  res.json({ ok: true, ...(await jobs.createScheduleFromTemplate({ tenantId: req.tenantId, dealId: req.params.id, startDate: (req.body || {}).startDate })) });
}));
router.post('/api/crm/deals/:id/schedule/save-template', requireAuth, wrap('Failed to save the template', async (req, res) => {
  if (!team.can(req.crmUser, 'settings')) return res.status(403).json({ error: { message: team.denyText('settings') } });
  res.json({ ok: true, ...(await jobs.saveTemplateFromJob({ tenantId: req.tenantId, dealId: req.params.id })) });
}));
router.post('/api/crm/deals/:id/schedule', requireAuth, wrap('Failed to add the phase', async (req, res) => {
  if (!(await ownDeal(req, res))) return;
  res.json({ ok: true, item: await jobs.saveItem({ tenantId: req.tenantId, dealId: req.params.id, body: req.body, userId: req.userId }) });
}));
router.patch('/api/crm/schedule/:itemId', requireAuth, wrap('Failed to save the phase', async (req, res) => {
  res.json({ ok: true, item: await jobs.saveItem({ tenantId: req.tenantId, id: req.params.itemId, body: req.body, userId: req.userId }) });
}));
router.delete('/api/crm/schedule/:itemId', requireAuth, wrap('Failed to delete the phase', async (req, res) => {
  const r = await require('../lib/crmTrash').around({ tenantId: req.tenantId, kind: 'phase', id: req.params.itemId, userId: req.userId }, () => jobs.deleteItem({ tenantId: req.tenantId, id: req.params.itemId }));
  if (!r.ok) return res.status(404).json({ error: { message: 'Phase not found.' } });
  res.json({ ok: true, undo: r.undo });
}));

// daily logs
router.post('/api/crm/deals/:id/logs', requireAuth, wrap('Failed to save the log', async (req, res) => {
  const b = req.body || {};
  res.json({ ok: true, log: await jobs.addLog({ tenantId: req.tenantId, dealId: req.params.id, body: b.body, crew: b.crew, logDate: b.logDate, shared: !!b.shared, userId: req.userId }) });
}));

// subs & vendors
router.get('/api/crm/vendors', requireAuth, wrap('Failed to load vendors', async (req, res) => res.json({ vendors: await jobs.listVendors(req.tenantId) })));
router.post('/api/crm/vendors', requireAuth, wrap('Failed to save the vendor', async (req, res) => res.json({ ok: true, vendor: await jobs.saveVendor({ tenantId: req.tenantId, body: req.body }) })));
router.patch('/api/crm/vendors/:vendorId', requireAuth, wrap('Failed to save the vendor', async (req, res) => res.json({ ok: true, vendor: await jobs.saveVendor({ tenantId: req.tenantId, id: req.params.vendorId, body: req.body }) })));
router.delete('/api/crm/vendors/:vendorId', requireAuth, wrap('Failed to remove the vendor', async (req, res) => {
  if (!team.can(req.crmUser, 'subs')) return res.status(403).json({ error: { message: team.denyText('subs') } });
  const r = await require('../lib/crmTrash').around({ tenantId: req.tenantId, kind: 'vendor', id: req.params.vendorId, userId: req.userId }, () => jobs.archiveVendor({ tenantId: req.tenantId, id: req.params.vendorId }));
  if (!r.ok) return res.status(404).json({ error: { message: 'Vendor not found.' } });
  res.json({ ok: true, undo: r.undo });
}));

// purchase orders
router.post('/api/crm/deals/:id/pos', requireAuth, wrap('Failed to create the purchase order', async (req, res) => {
  const b = req.body || {};
  res.json({ ok: true, po: await jobs.createPO({ tenantId: req.tenantId, dealId: req.params.id, vendorId: b.vendorId || null, title: b.title, lines: b.lines, category: b.category, neededBy: b.neededBy, note: b.note, userId: req.userId }) });
}));
router.post('/api/crm/pos/:poId/send', requireAuth, wrap('Failed to send the purchase order', async (req, res) => res.json({ ok: true, ...(await jobs.sendPO({ baseUrl: `${req.protocol}://${req.get('host')}`, tenantId: req.tenantId, id: req.params.poId, userId: req.userId })) })));
router.patch('/api/crm/pos/:poId', requireAuth, wrap('Failed to save', async (req, res) => {
  const po = await jobs.setPOStatus({ tenantId: req.tenantId, id: req.params.poId, status: (req.body || {}).status, userId: req.userId });
  if (!po) return res.status(404).json({ error: { message: 'Purchase order not found.' } });
  res.json({ ok: true, po });
}));

// change orders
router.post('/api/crm/deals/:id/change-orders', requireAuth, wrap('Failed to create the change order', async (req, res) => {
  const b = req.body || {};
  res.json({ ok: true, co: await jobs.createCO({ tenantId: req.tenantId, dealId: req.params.id, title: b.title, description: b.description, amount: b.amount, cost: b.cost, daysAdded: b.daysAdded, userId: req.userId }) });
}));
router.post('/api/crm/change-orders/:coId/send', requireAuth, wrap('Failed to send the change order', async (req, res) => res.json({ ok: true, ...(await jobs.sendCO({ tenantId: req.tenantId, id: req.params.coId, userId: req.userId, baseUrl: baseUrlOf(req) })) })));

// selections
router.post('/api/crm/deals/:id/selections', requireAuth, wrap('Failed to save the selection', async (req, res) => res.json({ ok: true, selection: await jobs.saveSelection({ tenantId: req.tenantId, dealId: req.params.id, body: req.body }) })));
router.patch('/api/crm/selections/:selId', requireAuth, wrap('Failed to save the selection', async (req, res) => res.json({ ok: true, selection: await jobs.saveSelection({ tenantId: req.tenantId, id: req.params.selId, body: req.body }) })));
router.post('/api/crm/selections/:selId/clear', requireAuth, wrap('Failed to clear the choice', async (req, res) => {
  if (!(await jobs.clearChoice({ tenantId: req.tenantId, id: req.params.selId }))) return res.status(404).json({ error: { message: 'Selection not found.' } });
  res.json({ ok: true });
}));

// ---------- the homeowner, through the portal ----------
const hits = new Map();
function limited(ip) { const now = Date.now(); const l = (hits.get(ip) || []).filter(t => now - t < 3600000); l.push(now); hits.set(ip, l); return l.length > 30; }
router.post('/api/crm-public/portal/:token/change-orders/:coId', async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: { message: 'Too many attempts. Please try again later.' } });
  const b = req.body || {};
  try { await jobs.answerCO({ token: req.params.token, id: req.params.coId, approve: !!b.approve, name: b.name, ip: req.ip }); res.json({ ok: true }); } catch (err) { fail(res, err, 'Failed to save your answer'); }
});
router.post('/api/crm-public/portal/:token/selections/:selId', async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: { message: 'Too many attempts. Please try again later.' } });
  try { res.json({ ok: true, ...(await jobs.chooseOption({ token: req.params.token, id: req.params.selId, index: (req.body || {}).index })) }); } catch (err) { fail(res, err, 'Failed to save your choice'); }
});

module.exports = router;
