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
// Photos, PDFs and videos open in the browser; everything else downloads.
// A Google Doc (made in Drive) opens in Drive.
async function sendFile(res, f, download, { team = true } = {}) {
  if (/^application\/vnd\.google-apps\./.test(f.content_type)) {
    if (team && f.drive_link) return res.redirect(f.drive_link);
    return res.status(404).type('text/plain').send('This file opens in Google Drive.');
  }
  let data;
  try { data = await portal.fileData(f); } catch (e) { return res.status(e.status === 409 ? 409 : 502).type('text/plain').send(e.message); }
  if (!data) return res.status(404).type('text/plain').send('Not found.');
  const inline = !download && (/^image\/(jpeg|png|webp)$|^application\/pdf$|^video\//.test(f.content_type));
  res.set({
    'Content-Type': f.content_type, 'Content-Length': data.length, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${String(f.filename).replace(/["\r\n]/g, '')}"`
  });
  res.end(data);
}

// ---------- the team's side ----------

router.get('/api/crm/deals/:id/files', requireAuth, async (req, res) => {
  try {
    if (!(await dealInTenant(req, res))) return;
    const drive = await require('../lib/crmDrive').driveOn(req.tenantId);
    const d = drive ? (await query('SELECT drive_folder_id FROM crm_deals WHERE id = $1', [req.params.id])).rows[0] : null;
    res.json({ files: await portal.listFiles(req.tenantId, req.params.id), folders: portal.FOLDERS, maxMb: drive ? 50 : 8,
      drive: drive ? { on: true, folderLink: d && d.drive_folder_id ? `https://drive.google.com/drive/folders/${d.drive_folder_id}` : null } : { on: false } });
  } catch (err) { fail(res, err, 'Failed to load files'); }
});

router.post('/api/crm/deals/:id/files', requireAuth, async (req, res) => {
  const b = req.body || {};
  try {
    if (!(await dealInTenant(req, res))) return;
    const f = await portal.addFile({ tenantId: req.tenantId, dealId: req.params.id, filename: b.filename, dataBase64: b.dataBase64, caption: b.caption, shared: b.shared === undefined ? null : !!b.shared, folder: b.folder || null, userId: req.userId });
    res.json({ ok: true, file: f });
  } catch (err) { fail(res, err, 'Failed to upload'); }
});

// The same, with the raw bytes as the body (big files: no base64 on the way).
// The name, folder and sharing come in headers.
// Only application/octet-stream is read (a cross-site form can't send that without the browser asking first).
const rawFile = (req, res, next) => express.raw({ type: 'application/octet-stream', limit: '52mb' })(req, res, (err) => {
  if (!err) return next();
  res.status(err.type === 'entity.too.large' ? 413 : 400).json({ error: { message: err.type === 'entity.too.large' ? 'That file is too big. The limit is 50 MB.' : 'The upload didn’t come through. Please try again.' } });
});
router.post('/api/crm/deals/:id/files/raw', requireAuth, rawFile, async (req, res) => {
  try {
    if (!req.is('application/octet-stream')) return res.status(415).json({ error: { message: 'Send the file as application/octet-stream.' } });
    if (!(await dealInTenant(req, res))) return;
    const h = (k) => { const v = req.get(k); try { return v == null ? null : decodeURIComponent(v); } catch (e) { return v; } };
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: { message: 'Choose a file to upload.' } });
    const f = await portal.addFile({ tenantId: req.tenantId, dealId: req.params.id, filename: h('X-Filename') || 'file', buffer: req.body, caption: h('X-Caption'), shared: h('X-Shared') == null ? null : h('X-Shared') === '1', folder: h('X-Folder') || null, userId: req.userId });
    res.json({ ok: true, file: f });
  } catch (err) { fail(res, err.type === 'entity.too.large' ? Object.assign(err, { status: 413, message: 'That file is too big. The limit is 50 MB.' }) : err, 'Failed to upload'); }
});

router.get('/api/crm/files/:fileId', requireAuth, async (req, res) => {
  try {
    const f = await portal.getFile(req.tenantId, req.params.fileId);
    if (!f) return res.status(404).json({ error: { message: 'File not found.' } });
    await sendFile(res, f, req.query.download === '1');
  } catch (err) { fail(res, err, 'Failed to load the file'); }
});

router.patch('/api/crm/files/:fileId', requireAuth, async (req, res) => {
  const b = req.body || {};
  try {
    if (!(await portal.updateFile({ tenantId: req.tenantId, id: req.params.fileId, shared: b.shared, subShared: b.subShared, caption: b.caption, folder: b.folder, filename: b.filename, splitVersion: !!b.splitVersion }))) return res.status(404).json({ error: { message: 'File not found.' } });
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Failed to save'); }
});

router.delete('/api/crm/files/:fileId', requireAuth, async (req, res) => {
  try {
    // Kept in the recycle bin, so the Drive copy stays until it's emptied.
    const r = await require('../lib/crmTrash').around({ tenantId: req.tenantId, kind: 'file', id: req.params.fileId, userId: req.userId }, () => portal.deleteFile({ tenantId: req.tenantId, id: req.params.fileId, drive: false }));
    if (!r.ok) return res.status(404).json({ error: { message: 'File not found.' } });
    res.json({ ok: true, undo: r.undo });
  } catch (err) { fail(res, err, 'Failed to delete'); }
});

router.get('/api/crm/deals/:id/portal', requireAuth, async (req, res) => {
  try {
    if (!(await dealInTenant(req, res))) return;
    const token = await portal.portalToken(req.tenantId, req.params.id);
    const updates = (await query(
      `SELECT u.id, u.body, u.created_at, u.emailed_at, COALESCE(us.name, us.email) AS author FROM crm_portal_updates u LEFT JOIN users us ON us.id = u.created_by
       WHERE u.deal_id = $1 ORDER BY u.created_at DESC LIMIT 50`, [req.params.id])).rows;
    const draft = (await query('SELECT update_draft, update_draft_at FROM crm_deals WHERE id = $1', [req.params.id])).rows[0];
    res.json({ url: `${baseUrlOf(req)}/p/${token}`, updates, draft: draft.update_draft || null, draftAt: draft.update_draft_at });
  } catch (err) { fail(res, err, 'Failed to load the portal'); }
});

router.post('/api/crm/deals/:id/portal/email', requireAuth, async (req, res) => {
  try {
    if (!(await dealInTenant(req, res))) return;
    res.json(await portal.emailPortalLink({ tenantId: req.tenantId, dealId: req.params.id, baseUrl: baseUrlOf(req) }));
  } catch (err) { fail(res, err, 'Failed to send the link'); }
});

router.post('/api/crm/deals/:id/portal/reset', requireAuth, async (req, res) => {
  if (!team.can(req.crmUser, 'settings')) return res.status(403).json({ error: { message: team.denyText('settings') } });
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

// Talk or type, saved on the homeowner's record so it follows them to any device.
router.post('/api/crm-public/portal/:token/ai-mode', async (req, res) => {
  const mode = (req.body || {}).mode;
  if (!['talk', 'text'].includes(mode)) return res.status(400).json({ error: { message: 'Pick talk or type.' } });
  try {
    const r = await query(`UPDATE crm_contacts SET ai_mode = $2 WHERE id = (SELECT contact_id FROM crm_deals WHERE portal_token = $1)`, [String(req.params.token).slice(0, 100), mode]);
    if (!r.rowCount) return res.status(404).json({ error: { message: 'This project link is not valid.' } });
    res.json({ mode });
  } catch (err) { fail(res, err, 'Failed to save'); }
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
    await sendFile(res, f, req.query.download === '1', { team: false });
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
