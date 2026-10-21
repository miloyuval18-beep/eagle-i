// The subs' page (lib/crmSubPortal.js). /s/<token> and /api/crm-public/sub-portal/*
// need no login: the long random link is the key. /api/crm/vendors/:id/portal* are
// the team's (behind routes/crm.js's sign-in, mounted after it).
const express = require('express');
const path = require('path');
const { requireAuth } = require('../auth');
const { query } = require('../db');
const sp = require('../lib/crmSubPortal');
const portal = require('../lib/crmPortal');
const team = require('../lib/crmTeam');

const router = express.Router();
const baseUrlOf = (req) => `${req.protocol}://${req.get('host')}`;
const wrap = (what, fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    const st = err.status || 500;
    if (/invalid input syntax for type uuid/.test(err.message || '')) return res.status(404).json({ error: { message: 'Not found.' } });
    res.status(st).json({ error: { message: st === 500 ? `${what}: ${err.message}` : err.message } });
  }
};
const hits = new Map();
function limited(key, max) { const now = Date.now(); const l = (hits.get(key) || []).filter(t => now - t < 3600000); l.push(now); hits.set(key, l); return l.length > max; }

// ---------- the sub's side ----------
router.get('/s/:token', (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
  res.sendFile(path.join(__dirname, '..', 'public', 'sub-portal.html'));
});
router.get('/api/crm-public/sub-portal/:token', wrap('Failed to load', async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  const got = await sp.subView(req.params.token, { baseUrl: baseUrlOf(req) });
  if (!got) return res.status(404).json({ error: { message: 'This link is not valid. Ask the company that sent it for a new one.' } });
  res.json(got.view);
}));
router.get('/api/crm-public/sub-portal/:token/files/:fileId', wrap('Failed to load the file', async (req, res) => {
  if (limited('sf:' + req.ip, 300)) return res.status(429).type('text/plain').send('Too many requests.');
  const f = await sp.subFile(req.params.token, req.params.fileId);
  if (!f) return res.status(404).type('text/plain').send('Not found.');
  const data = await portal.fileData(f);
  if (!data) return res.status(404).type('text/plain').send('This file opens in Google Drive; ask the office for a copy.');
  const inline = req.query.download !== '1' && /^image\/(jpeg|png|webp)$|^application\/pdf$/.test(f.content_type);
  res.set({ 'Content-Type': f.content_type, 'Content-Length': data.length, 'Cache-Control': 'private, max-age=600', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox", 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${String(f.filename).replace(/["\r\n]/g, '')}"` });
  res.end(data);
}));
router.post('/api/crm-public/sub-portal/:token/ask', wrap('Failed to answer', async (req, res) => {
  if (limited('sa:' + req.ip, 60)) return res.status(429).json({ error: { message: 'Too many questions. Please try again later.' } });
  const b = req.body || {};
  res.json(await sp.ask({ token: req.params.token, question: b.question, dealId: b.jobId || null, lang: req.get('X-Lang') === 'es' ? 'es' : null }));
}));
router.post('/api/crm-public/sub-portal/:token/message', wrap('Failed to send', async (req, res) => {
  if (limited('sm:' + req.ip, 20)) return res.status(429).json({ error: { message: 'Too many messages. Please try again later.' } });
  const b = req.body || {};
  res.json(await sp.message({ token: req.params.token, text: b.text, dealId: b.jobId || null }));
}));

// ---------- the team's side ----------
async function ownVendor(req, res) {
  const v = (await query('SELECT id, name, email FROM crm_vendors WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]).catch(() => ({ rows: [] }))).rows[0];
  if (!v) res.status(404).json({ error: { message: 'Sub not found.' } });
  return v;
}
router.get('/api/crm/vendors/:id/portal', requireAuth, wrap('Failed to load', async (req, res) => {
  const v = await ownVendor(req, res); if (!v) return;
  const got = await sp.subView(await sp.subToken(req.tenantId, v.id));
  res.json({ url: `${baseUrlOf(req)}/s/${got.v.portal_token}`, jobs: got.view.jobs.map(j => ({ title: j.title, status: j.status, files: (j.files || []).length })), questions: await sp.listQuestions(req.tenantId, v.id), email: v.email || null });
}));
router.post('/api/crm/vendors/:id/portal/email', requireAuth, wrap('Failed to send the link', async (req, res) => {
  const v = await ownVendor(req, res); if (!v) return;
  res.json(await sp.emailLink({ tenantId: req.tenantId, vendorId: v.id, baseUrl: baseUrlOf(req), userId: req.userId }));
}));
router.post('/api/crm/vendors/:id/portal/reset', requireAuth, wrap('Failed', async (req, res) => {
  if (!team.isManager(req.crmUser && req.crmUser.role)) return res.status(403).json({ error: { message: 'Only the owner or an admin can do this.' } });
  const v = await ownVendor(req, res); if (!v) return;
  res.json({ url: `${baseUrlOf(req)}/s/${await sp.resetToken(req.tenantId, v.id)}` });
}));

module.exports = router;
