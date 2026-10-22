// What marketing brings in, and the backlog (lib/crmMarketing.js).
//
// Sits behind routes/crm.js's sign-in and "company has the CRM" check
// (mounted after it). Everyone on the team can look; owners and admins
// enter spend and change the backlog marks.
const express = require('express');
const { requireAuth } = require('../auth');
const mk = require('../lib/crmMarketing');
const crm = require('../lib/crm');
const team = require('../lib/crmTeam');

const router = express.Router();
function fail(res, err, what) {
  const status = err.status || 500;
  if (/invalid input syntax for type uuid/.test(err.message || '')) return res.status(404).json({ error: { message: 'Not found.' } });
  res.status(status).json({ error: { message: status === 500 ? `${what}: ${err.message}` : err.message } });
}
const wrap = (what, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, what); } };
const managersOnly = (req, res) => {
  if (team.can(req.crmUser, 'settings')) return false;
  res.status(403).json({ error: { message: team.denyText('settings') } });
  return true;
};

router.get('/api/crm/marketing', requireAuth, wrap('Failed to load', async (req, res) => {
  const months = [3, 6, 12, 24].includes(parseInt(req.query.months, 10)) ? parseInt(req.query.months, 10) : 12;
  const [report, backlog, spend] = await Promise.all([mk.channelReport(req.tenantId, { months }), mk.backlog(req.tenantId), mk.listSpend(req.tenantId)]);
  res.json({ report, backlog, spend, channels: mk.PAID.map(k => [k, crm.sourceLabel(k)]), labels: crm.SOURCE_LABELS });
}));
router.post('/api/crm/marketing/spend', requireAuth, wrap('Failed to save', async (req, res) => {
  if (managersOnly(req, res)) return;
  const b = req.body || {};
  res.json({ ok: true, spend: await mk.saveSpend({ tenantId: req.tenantId, source: b.source, month: b.month, amount: b.amount, note: b.note }) });
}));
router.delete('/api/crm/marketing/spend/:sid', requireAuth, wrap('Failed to delete', async (req, res) => {
  if (managersOnly(req, res)) return;
  const r = await require('../lib/crmTrash').around({ tenantId: req.tenantId, kind: 'spend', id: req.params.sid, userId: req.userId }, async () => !!(await mk.deleteSpend({ tenantId: req.tenantId, id: req.params.sid })));
  if (!r.ok) return res.status(404).json({ error: { message: 'Not found.' } });
  res.json({ ok: true, undo: r.undo });
}));
router.patch('/api/crm/marketing/settings', requireAuth, wrap('Failed to save', async (req, res) => {
  if (managersOnly(req, res)) return;
  const b = req.body || {};
  res.json(await mk.saveBacklogSettings(req.tenantId, { monthlyCapacity: b.monthlyCapacity, lowWeeks: b.lowWeeks, highWeeks: b.highWeeks }));
}));

module.exports = router;
