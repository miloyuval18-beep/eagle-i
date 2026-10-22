// The calendar link, the morning email (lib/crmDaily.js) and duplicate
// contacts (lib/crmAssist.js).
//
// /api/crm/* routes sit behind routes/crm.js's sign-in and "company has the
// CRM" check (mounted after it). /cal/<token>.ics is read by calendar apps.
const express = require('express');
const { requireAuth } = require('../auth');
const daily = require('../lib/crmDaily');
const assist = require('../lib/crmAssist');
const team = require('../lib/crmTeam');
const { query } = require('../db');

const router = express.Router();
const baseUrlOf = (req) => `${req.protocol}://${req.get('host')}`;
function fail(res, err, what) {
  const status = err.status || 500;
  if (/invalid input syntax for type uuid/.test(err.message || '')) return res.status(404).json({ error: { message: 'Not found.' } });
  res.status(status).json({ error: { message: status === 500 ? `${what}: ${err.message}` : err.message } });
}
const wrap = (what, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, what); } };
const links = (req, token) => { const url = `${baseUrlOf(req)}/cal/${token}.ics`; return { calendarUrl: url, webcalUrl: url.replace(/^https?:/, 'webcal:'), phoneUrl: `${baseUrlOf(req)}/cal/${token}/add` }; };

router.get('/api/crm/me/daily', requireAuth, wrap('Failed to load', async (req, res) => {
  const u = (await query('SELECT crm_digest_off FROM users WHERE id = $1', [req.userId])).rows[0];
  res.json({ ...links(req, await daily.calendarToken(req.userId)), digestOn: !(u && u.crm_digest_off) });
}));
router.post('/api/crm/me/calendar/reset', requireAuth, wrap('Failed to make a new link', async (req, res) => res.json(links(req, await daily.resetCalendarToken(req.userId)))));
router.patch('/api/crm/me/digest', requireAuth, wrap('Failed to save', async (req, res) => res.json(await daily.setDigest(req.userId, !!(req.body || {}).on))));

// The QR code on a computer opens this on the phone: an iPhone subscribes in
// its own Calendar app, anything else goes to Google Calendar.
router.get('/cal/:token/add', (req, res) => {
  const t = String(req.params.token);
  if (!/^[0-9a-f]{48}$/.test(t)) return res.status(404).type('text/plain').send('This calendar link is no longer active.');
  const ics = `${baseUrlOf(req)}/cal/${t}.ics`;
  const apple = /iPhone|iPad|iPod|Macintosh/.test(String(req.get('user-agent') || ''));
  res.redirect(apple ? ics.replace(/^https?:/, 'webcal:') : 'https://calendar.google.com/calendar/r?cid=' + encodeURIComponent(ics.replace(/^https?:/, 'webcal:')));
});
router.get('/cal/:token', wrap('Failed to build the calendar', async (req, res) => {
  const ics = await daily.calendarFor(String(req.params.token).replace(/\.ics$/, ''));
  if (!ics) return res.status(404).type('text/plain').send('This calendar link is no longer active.');
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Content-Disposition': 'inline; filename="eagle-i.ics"' });
  res.send(ics);
}));

router.get('/api/crm/duplicates', requireAuth, wrap('Failed to look for duplicates', async (req, res) => res.json({ groups: await assist.findDuplicates(req.tenantId) })));
router.post('/api/crm/duplicates/merge', requireAuth, wrap('Failed to merge', async (req, res) => {
  if (!team.can(req.crmUser, 'data')) return res.status(403).json({ error: { message: team.denyText('data') } });
  const b = req.body || {};
  res.json({ ok: true, ...(await assist.mergeContacts({ tenantId: req.tenantId, keepId: b.keepId, mergeIds: b.mergeIds, userId: req.userId })) });
}));

module.exports = router;
