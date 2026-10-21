// The team calendar (lib/crmCalendar.js).
//
// /api/crm/* routes sit behind routes/crm.js's sign-in and "company has the
// CRM" check (mounted after it).
const express = require('express');
const { requireAuth } = require('../auth');
const cal = require('../lib/crmCalendar');

const router = express.Router();
const baseUrlOf = (req) => `${req.protocol}://${req.get('host')}`;
function fail(res, err, what) {
  const status = err.status || 500;
  if (/invalid input syntax for type uuid/.test(err.message || '')) return res.status(404).json({ error: { message: 'Not found.' } });
  res.status(status).json({ error: { message: status === 500 ? `${what}: ${err.message}` : err.message } });
}
const wrap = (what, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, what); } };

router.get('/api/crm/calendar', requireAuth, wrap('Failed to load the calendar', async (req, res) => {
  const types = req.query.types ? String(req.query.types).split(',').filter(t => cal.TYPES[t]) : null;
  const r = await cal.range({ tenantId: req.tenantId, viewer: req.crmUser, from: req.query.from, to: req.query.to, who: req.query.who || 'me', types });
  res.json({ ...r, types: cal.TYPES, kinds: cal.KINDS, google: await cal.googleStatus(req.tenantId, req.crmUser.id) });
}));
router.post('/api/crm/calendar/events', requireAuth, wrap('Failed to add it', async (req, res) => {
  res.json({ event: await cal.createEvent({ tenantId: req.tenantId, actor: req.crmUser, body: req.body || {} }) });
}));
router.patch('/api/crm/calendar/events/:id', requireAuth, wrap('Failed to save', async (req, res) => {
  res.json({ event: await cal.updateEvent({ tenantId: req.tenantId, actor: req.crmUser, id: req.params.id, body: req.body || {} }) });
}));
router.delete('/api/crm/calendar/events/:id', requireAuth, wrap('Failed to remove it', async (req, res) => {
  const r = await require('../lib/crmTrash').around({ tenantId: req.tenantId, kind: 'event', id: req.params.id, userId: req.userId }, () => cal.deleteEvent({ tenantId: req.tenantId, actor: req.crmUser, id: req.params.id }));
  res.json({ ok: true, undo: r.undo });
}));
router.post('/api/crm/calendar/move', requireAuth, wrap('Failed to move it', async (req, res) => {
  const b = req.body || {};
  await cal.move({ tenantId: req.tenantId, actor: req.crmUser, type: b.type, id: b.id, date: b.date, time: b.time || null, baseUrl: baseUrlOf(req) });
  res.json({ ok: true });
}));

module.exports = router;
