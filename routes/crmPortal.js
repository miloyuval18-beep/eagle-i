// Files, photos and the homeowner portal (lib/crmPortal.js).
//
// /api/crm/* routes sit behind routes/crm.js's sign-in and "company has the
// CRM" check (mounted after it). The homeowner's side, /p/<token> and
// /api/crm-public/portal/*, needs no login: the long random token is the key.
const express = require('express');
const path = require('path');
const { requireAuth } = require('../auth');
const portal = require('../lib/crmPortal');
const team = require('../lib/crmTeam');
const { query } = require('../db');

const router = express.Router();
const baseUrlOf = (req) => `${req.protocol}://${req.get('host')}`;

function fail(res, err, what) {
  const status = err.status || 500;
  if (/invalid input syntax for type uuid/.test(err.message || '')) return res.status(404).json({ error: { message: 'Not found.' } });
  res.status(status).json({ error: { message: status === 500 ? `${what}: ${err.message}` : err.message } });
}
async function dealInTenant(req, res) {
  const r = await query('SELECT id FROM crm_deals WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]).catch(() => ({ rows: [] }));
  if (!r.rows.length) { res.status(404).json({ error: { message: 'Deal not found.' } }); return false; }
  return true;
}
function sendFile(res, f, download) {
  res.set({
    'Content-Type': f.content_type, 'Content-Length': f.size, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${String(f.filename).replace(/"/g, '')}"`
  });
  res.end(f.data);
}

// ---------- the team's side ----------

router.get('/api/crm/deals/:id/files', requireAuth, async (req, res) => {
  try { if (await dealInTenant(req, res)) res.json({ files: await portal.listFiles(req.tenantId, req.params.id) }); } catch (err) { fail(res, err, 'Failed to load files'); }
});

router.post('/api/crm/deals/:id/files', requireAuth, async (req, res) => {
  const b = req.body || {};
  try {
    if (!(await dealInTenant(req, res))) return;
    const f = await portal.addFile({ tenantId: req.tenantId, dealId: req.params.id, filename: b.filename, dataBase64: b.dataBase64, caption: b.caption, shared: b.shared === undefined ? null : !!b.shared, userId: req.userId });
    res.json({ ok: true, file: f });
  } catch (err) { fail(res, err, 'Failed to upload'); }
});

router.get('/api/crm/files/:fileId', requireAuth, async (req, res) => {
  try {
    const f = await portal.getFile(req.tenantId, req.params.fileId);
    if (!f) return res.status(404).json({ error: { message: 'File not found.' } });
    sendFile(res, f, req.query.download === '1');
  } catch (err) { fail(res, err, 'Failed to load the file'); }
});

router.patch('/api/crm/files/:fileId', requireAuth, async (req, res) => {
  const b = req.body || {};
  try {
    if (!(await portal.updateFile({ tenantId: req.tenantId, id: req.params.fileId, shared: b.shared, caption: b.caption }))) return res.status(404).json({ error: { message: 'File not found.' } });
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Failed to save'); }
});

router.delete('/api/crm/files/:fileId', requireAuth, async (req, res) => {
  try {
    if (!(await portal.deleteFile({ tenantId: req.tenantId, id: req.params.fileId }))) return res.status(404).json({ error: { message: 'File not found.' } });
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Failed to delete'); }
});

router.get('/api/crm/deals/:id/portal', requireAuth, async (req, res) => {
  try {
    if (!(await dealInTenant(req, res))) return;
    const token = await portal.portalToken(req.tenantId, req.params.id);
    const updates = (await query(
      `SELECT u.id, u.body, u.created_at, u.emailed_at, COALESCE(us.name, us.email) AS author FROM crm_portal_updates u LEFT JOIN users us ON us.id = u.created_by
       WHERE u.deal_id = $1 ORDER BY u.created_at DESC LIMIT 50`, [req.params.id])).rows;
    res.json({ url: `${baseUrlOf(req)}/p/${token}`, updates });
  } catch (err) { fail(res, err, 'Failed to load the portal'); }
});

router.post('/api/crm/deals/:id/portal/reset', requireAuth, async (req, res) => {
  if (!team.isManager(req.crmUser && req.crmUser.role)) return res.status(403).json({ error: { message: 'Only the owner or an admin can change this.' } });
  try { res.json({ ok: true, url: `${baseUrlOf(req)}/p/${await portal.resetPortalToken(req.tenantId, req.params.id)}` }); } catch (err) { fail(res, err, 'Failed to make a new link'); }
});

router.post('/api/crm/deals/:id/updates', requireAuth, async (req, res) => {
  const b = req.body || {};
  try { res.json({ ok: true, ...(await portal.postUpdate({ tenantId: req.tenantId, dealId: req.params.id, body: b.body, userId: req.userId, email: !!b.email, baseUrl: baseUrlOf(req) })) }); }
  catch (err) {
    if (/RESEND_API_KEY/.test(err.message || '')) return res.status(503).json({ error: { message: 'The update was posted, but email sending is not set up on the server yet.' } });
    fail(res, err, 'Failed to post the update');
  }
});

// ---------- the homeowner's side ----------

const hits = new Map();
function limited(key, max) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter(t => now - t < 3600000);
  list.push(now);
  hits.set(key, list);
  return list.length > max;
}

router.get('/p/:token', (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
  res.sendFile(path.join(__dirname, '..', 'public', 'portal.html'));
});

router.get('/api/crm-public/portal/:token', async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  try {
    const v = await portal.portalView(req.params.token);
    if (!v) return res.status(404).json({ error: { message: 'This project link is not valid. Please contact the company that sent it.' } });
    res.json({ portal: v });
  } catch (err) { fail(res, err, 'Failed to load'); }
});

router.get('/api/crm-public/portal/:token/files/:fileId', async (req, res) => {
  try {
    const f = await portal.portalFile(req.params.token, req.params.fileId);
    if (!f) return res.status(404).send('Not found');
    sendFile(res, f, req.query.download === '1');
  } catch (err) { res.status(500).send('Failed'); }
});

router.post('/api/crm-public/portal/:token/messages', async (req, res) => {
  if (limited('m:' + req.ip, 20)) return res.status(429).json({ error: { message: 'Too many messages. Please try again later.' } });
  try { await portal.portalMessage({ token: req.params.token, message: (req.body || {}).message }); res.json({ ok: true }); } catch (err) { fail(res, err, 'Failed to send'); }
});

router.post('/api/crm-public/portal/:token/files', async (req, res) => {
  if (limited('f:' + req.ip, 30)) return res.status(429).json({ error: { message: 'Too many uploads. Please try again later.' } });
  const b = req.body || {};
  try { const f = await portal.portalUpload({ token: req.params.token, filename: b.filename, dataBase64: b.dataBase64, caption: b.caption }); res.json({ ok: true, file: { id: f.id, filename: f.filename } }); }
  catch (err) { fail(res, err, 'Failed to upload'); }
});

module.exports = router;
