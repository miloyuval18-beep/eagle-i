// Sub confirmations and the cash-flow forecast (lib/crmSubs.js).
//
// /api/crm/* routes sit behind routes/crm.js's sign-in and "company has the
// CRM" check (mounted after it). /sub/<token> is the sub's answer page.
const express = require('express');
const path = require('path');
const { requireAuth } = require('../auth');
const subs = require('../lib/crmSubs');
const team = require('../lib/crmTeam');

const router = express.Router();
function fail(res, err, what) {
  const status = err.status || 500;
  res.status(status).json({ error: { message: status === 500 ? `${what}: ${err.message}` : err.message } });
}
const wrap = (what, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, what); } };

router.get('/api/crm/subs/settings', requireAuth, wrap('Failed to load', async (req, res) => res.json({ on: await subs.subConfirmOn(req.tenantId) })));
router.patch('/api/crm/subs/settings', requireAuth, wrap('Failed to save', async (req, res) => {
  if (!team.can(req.crmUser, 'settings')) return res.status(403).json({ error: { message: team.denyText('settings') } });
  res.json(await subs.setSubConfirm(req.tenantId, !!(req.body || {}).on));
}));
router.get('/api/crm/cashflow', requireAuth, wrap('Failed to load the cash flow', async (req, res) => res.json(await subs.cashflow(req.tenantId))));

router.get('/sub/:token', (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
  res.sendFile(path.join(__dirname, '..', 'public', 'sub.html'));
});
const hits = new Map();
function limited(ip) { const now = Date.now(); const l = (hits.get(ip) || []).filter(t => now - t < 3600000); l.push(now); hits.set(ip, l); return l.length > 30; }
router.get('/api/crm-public/sub/:token', wrap('Failed to load', async (req, res) => {
  const info = await subs.confirmInfo(req.params.token);
  if (!info) return res.status(404).json({ error: { message: 'This link is no longer active. The dates may have changed; a new email is on its way.' } });
  res.json(info);
}));
router.post('/api/crm-public/sub/:token', wrap('Failed to save your answer', async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: { message: 'Too many attempts. Please try again later.' } });
  const b = req.body || {};
  res.json({ ok: true, ...(await subs.answerConfirm({ token: req.params.token, yes: !!b.yes, note: b.note })) });
}));

module.exports = router;
