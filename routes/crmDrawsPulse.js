// Draw schedules (lib/crmDraws.js) and the homeowner pulse (lib/crmPulse.js).
//
// /api/crm/* routes sit behind routes/crm.js's sign-in and "company has the
// CRM" check (mounted after it). /pulse/<token> is the homeowner's answer page.
const express = require('express');
const path = require('path');
const { requireAuth } = require('../auth');
const draws = require('../lib/crmDraws');
const pulse = require('../lib/crmPulse');
const team = require('../lib/crmTeam');
const { query } = require('../db');

const router = express.Router();
function fail(res, err, what) {
  const status = err.status || 500;
  if (/invalid input syntax for type uuid/.test(err.message || '')) return res.status(404).json({ error: { message: 'Not found.' } });
  res.status(status).json({ error: { message: status === 500 ? `${what}: ${err.message}` : err.message } });
}
const wrap = (what, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, what); } };
const managersOnly = (req, res) => {
  if (team.isManager(req.crmUser && req.crmUser.role)) return false;
  res.status(403).json({ error: { message: 'Only the owner or an admin can change this.' } });
  return true;
};
async function ownDeal(req, res) {
  if ((await query('SELECT 1 FROM crm_deals WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId])).rows.length) return true;
  res.status(404).json({ error: { message: 'Deal not found.' } });
  return false;
}

// ---------- draws ----------
router.get('/api/crm/deals/:id/draws', requireAuth, wrap('Failed to load the payment schedule', async (req, res) => {
  if (!(await ownDeal(req, res))) return;
  const [list, settings, phases] = await Promise.all([draws.listDraws(req.tenantId, req.params.id), draws.drawSettings(req.tenantId),
    query('SELECT id, title, status FROM crm_job_items WHERE deal_id = $1 ORDER BY position', [req.params.id]).then(r => r.rows)]);
  res.json({ ...list, autoSend: settings.autoSend, customTemplate: settings.custom, phases });
}));
router.post('/api/crm/deals/:id/draws', requireAuth, wrap('Failed to add the payment', async (req, res) => res.json({ ok: true, draw: await draws.saveDraw({ tenantId: req.tenantId, dealId: req.params.id, body: req.body }) })));
router.post('/api/crm/deals/:id/draws/standard', requireAuth, wrap('Failed to lay out the payments', async (req, res) => {
  if (!(await ownDeal(req, res))) return;
  res.json({ ok: true, ...(await draws.applyTemplate({ tenantId: req.tenantId, dealId: req.params.id })) });
}));
router.post('/api/crm/deals/:id/draws/save-template', requireAuth, wrap('Failed to save', async (req, res) => {
  if (managersOnly(req, res)) return;
  res.json({ ok: true, ...(await draws.saveTemplateFromJob({ tenantId: req.tenantId, dealId: req.params.id })) });
}));
router.patch('/api/crm/draws/settings', requireAuth, wrap('Failed to save', async (req, res) => {
  if (managersOnly(req, res)) return;
  res.json(await draws.setAutoSend(req.tenantId, !!(req.body || {}).autoSend));
}));
router.patch('/api/crm/draws/:did', requireAuth, wrap('Failed to save the payment', async (req, res) => res.json({ ok: true, draw: await draws.saveDraw({ tenantId: req.tenantId, id: req.params.did, body: req.body }) })));
router.delete('/api/crm/draws/:did', requireAuth, wrap('Failed to remove the payment', async (req, res) => { await draws.deleteDraw({ tenantId: req.tenantId, id: req.params.did }); res.json({ ok: true }); }));
router.post('/api/crm/draws/:did/invoice', requireAuth, wrap('Failed to make the invoice', async (req, res) => {
  const d = (await query('SELECT * FROM crm_draws WHERE id = $1 AND tenant_id = $2', [req.params.did, req.tenantId])).rows[0];
  if (!d) return res.status(404).json({ error: { message: 'Payment not found.' } });
  if (d.invoice_id) return res.status(400).json({ error: { message: 'This payment is already invoiced.' } });
  const r = await draws.fire({ tenantId: req.tenantId, draw: d, userId: req.userId });
  if (!r) return res.status(400).json({ error: { message: 'There’s nothing left to bill on this contract.' } });
  res.json({ ok: true, invoice: r.invoice, sent: r.sent });
}));

// ---------- pulse ----------
router.get('/api/crm/pulse/settings', requireAuth, wrap('Failed to load', async (req, res) => res.json({ on: await pulse.pulseOn(req.tenantId), everyDays: pulse.EVERY_DAYS })));
router.patch('/api/crm/pulse/settings', requireAuth, wrap('Failed to save', async (req, res) => {
  if (managersOnly(req, res)) return;
  res.json(await pulse.setPulse(req.tenantId, !!(req.body || {}).on));
}));
router.get('/api/crm/deals/:id/pulses', requireAuth, wrap('Failed to load', async (req, res) => {
  if (!(await ownDeal(req, res))) return;
  res.json({ pulses: await pulse.dealPulses(req.tenantId, req.params.id) });
}));

router.get('/pulse/:token', (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
  res.sendFile(path.join(__dirname, '..', 'public', 'pulse.html'));
});
const hits = new Map();
function limited(ip) { const now = Date.now(); const l = (hits.get(ip) || []).filter(t => now - t < 3600000); l.push(now); hits.set(ip, l); return l.length > 30; }
router.get('/api/crm-public/pulse/:token', wrap('Failed to load', async (req, res) => {
  const info = await pulse.pulseInfo(req.params.token);
  if (!info) return res.status(404).json({ error: { message: 'This link is not valid.' } });
  res.json(info);
}));
router.post('/api/crm-public/pulse/:token', wrap('Failed to save your answer', async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: { message: 'Too many attempts. Please try again later.' } });
  const b = req.body || {};
  res.json({ ok: true, ...(await pulse.answer({ token: req.params.token, score: b.score, comment: b.comment })) });
}));

module.exports = router;
