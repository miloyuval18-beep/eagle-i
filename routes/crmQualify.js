// Qualifying and booking (lib/crmQualify.js).
//
// /api/crm/* routes sit behind routes/crm.js's sign-in and "company has the
// CRM" check (mounted after it). The homeowner's pages need no login:
//   /q/<portal token>   the project questionnaire
//   /b/<portal token>   booking a site visit for an existing deal
//   /book/<intake key>  the company's public booking page (anyone)
const express = require('express');
const path = require('path');
const { requireAuth } = require('../auth');
const q = require('../lib/crmQualify');
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

router.get('/api/crm/qualify/settings', requireAuth, wrap('Failed to load settings', async (req, res) => res.json(await q.qualifySettings(req.tenantId))));
router.patch('/api/crm/qualify/settings', requireAuth, wrap('Failed to save settings', async (req, res) => {
  if (!team.isManager(req.crmUser && req.crmUser.role)) return res.status(403).json({ error: { message: 'Only the owner or an admin can change this.' } });
  const b = req.body || {};
  res.json(await q.saveQualifySettings(req.tenantId, { minJobValue: b.minJobValue, booking: b.booking }));
}));
router.get('/api/crm/deals/:id/fit', requireAuth, wrap('Failed to load', async (req, res) => {
  const fit = await q.dealFit({ tenantId: req.tenantId, dealId: req.params.id, baseUrl: baseUrlOf(req) });
  if (!fit) return res.status(404).json({ error: { message: 'Deal not found.' } });
  res.json(fit);
}));
router.post('/api/crm/deals/:id/brief', requireAuth, wrap('Failed to write the brief', async (req, res) => {
  if (!(await query('SELECT 1 FROM crm_deals WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId])).rows.length) return res.status(404).json({ error: { message: 'Deal not found.' } });
  res.json({ brief: await q.writeBrief({ tenantId: req.tenantId, dealId: req.params.id }) });
}));
router.post('/api/crm/deals/:id/rescore', requireAuth, wrap('Failed to score', async (req, res) => {
  if (!(await query('SELECT 1 FROM crm_deals WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId])).rows.length) return res.status(404).json({ error: { message: 'Deal not found.' } });
  res.json(await q.scoreDeal(req.tenantId, req.params.id));
}));

// ---------- the homeowner's pages ----------
const page = (file) => (req, res) => { res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' }); res.sendFile(path.join(__dirname, '..', 'public', file)); };
router.get('/q/:token', page('questionnaire.html'));
router.get('/b/:token', page('book.html'));
router.get('/book/:key', page('book.html'));

const hits = new Map();
function limited(ip) { const now = Date.now(); const l = (hits.get(ip) || []).filter(t => now - t < 3600000); l.push(now); hits.set(ip, l); return l.length > 20; }

router.get('/api/crm-public/q/:token', wrap('Failed to load', async (req, res) => {
  const info = await q.questionnaireInfo(req.params.token);
  if (!info) return res.status(404).json({ error: { message: 'This link is not valid.' } });
  res.json(info);
}));
router.post('/api/crm-public/q/:token', wrap('Failed to save your answers', async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: { message: 'Too many attempts. Please try again later.' } });
  res.json({ ok: true, ...(await q.submitQuestionnaire({ token: req.params.token, answers: req.body, baseUrl: baseUrlOf(req) })) });
}));
router.get('/api/crm-public/b/:token', wrap('Failed to load', async (req, res) => {
  const info = await q.bookingInfoByToken(req.params.token);
  if (!info) return res.status(404).json({ error: { message: 'This link is not valid.' } });
  res.json(info);
}));
router.post('/api/crm-public/b/:token', wrap('Failed to book', async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: { message: 'Too many attempts. Please try again later.' } });
  res.json({ ok: true, ...(await q.bookByToken({ token: req.params.token, slot: (req.body || {}).slot, baseUrl: baseUrlOf(req) })) });
}));
router.get('/api/crm-public/book/:key', wrap('Failed to load', async (req, res) => {
  const info = await q.bookingInfoByKey(req.params.key);
  if (!info) return res.status(404).json({ error: { message: 'This booking page is no longer active.' } });
  res.json(info);
}));
router.post('/api/crm-public/book/:key', wrap('Failed to book', async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: { message: 'Too many attempts. Please try again later.' } });
  const b = req.body || {};
  if (b.company_website) return res.json({ ok: true }); // honeypot
  res.json({ ok: true, ...(await q.bookNew({ key: req.params.key, name: b.name, email: b.email, phone: b.phone, address: b.address, notes: b.notes, slot: b.slot, utm: b.utm, baseUrl: baseUrlOf(req) })) });
}));

module.exports = router;
