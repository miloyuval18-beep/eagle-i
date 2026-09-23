// Before/after photo requests — the owner's tools, and the public
// per-customer upload page/endpoint. See lib/photoRequests.js for what's
// locked down and why (same pattern as work-with-us).
const express = require('express');
const { requireAuth } = require('../auth');
const pr = require('../lib/photoRequests');

const router = express.Router();
const TOKEN_RE = /^[a-f0-9]{40}$/;
const sendError = (res, err, what) => (err && err.status
  ? res.status(err.status).json({ error: { message: err.message, code: err.code } })
  : res.status(500).json({ error: { message: `${what}: ${err.message}` } }));
const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;

// Per-address limit on the public upload (a customer rarely needs more than a couple tries).
const HITS = new Map();
const LIMIT = 6, WINDOW_MS = 60 * 60 * 1000;
function limited(ip) {
  const now = Date.now();
  const hits = (HITS.get(ip) || []).filter(t => now - t < WINDOW_MS);
  hits.push(now);
  HITS.set(ip, hits);
  if (HITS.size > 5000) for (const [k, v] of HITS) if (!v.some(t => now - t < WINDOW_MS)) HITS.delete(k);
  return hits.length > LIMIT;
}

// ---- Public ----

router.get('/photos/:token', async (req, res) => {
  if (!TOKEN_RE.test(req.params.token)) return res.status(404).send('Page not found.');
  try {
    const r = await pr.getRequestByToken(req.params.token);
    if (!r) return res.status(404).send('Page not found.');
    res.set({ 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' })
      .send(pr.renderPage({ companyName: r.company_name, customerName: r.customer_name, jobLabel: r.job_label, alreadySubmitted: r.status === 'submitted' }));
  } catch (err) { res.status(500).send('Failed to load page.'); }
});

router.post('/api/photos/:token/upload', async (req, res) => {
  if (!TOKEN_RE.test(req.params.token)) return res.status(404).json({ error: { message: 'Page not found.' } });
  if (limited(req.ip)) return res.status(429).json({ error: { message: 'Too many uploads from this connection. Please try again later.' } });
  try {
    const result = await pr.submit(req.params.token, req.body);
    res.json(result);
  } catch (err) { sendError(res, err, 'Upload failed'); }
});

// ---- Owner ----

router.post('/api/photo-requests', requireAuth, async (req, res) => {
  try {
    const { customerName, customerEmail, jobLabel } = req.body || {};
    const result = await pr.create(req.tenantId, { customerName, customerEmail, jobLabel }, { baseUrl: baseUrl(req) });
    res.json(result);
  } catch (err) { sendError(res, err, 'Failed to send'); }
});

router.get('/api/photo-requests', requireAuth, async (req, res) => {
  try { res.json({ requests: await pr.list(req.tenantId) }); }
  catch (err) { sendError(res, err, 'Failed to load'); }
});

router.get('/api/photo-requests/:id/files/:fileId', requireAuth, async (req, res) => {
  const id = Number(req.params.id), fileId = Number(req.params.fileId);
  if (!Number.isInteger(id) || !Number.isInteger(fileId)) return res.status(400).json({ error: { message: 'Invalid id.' } });
  try {
    const f = await pr.getFile(req.tenantId, id, fileId);
    if (!f) return res.status(404).json({ error: { message: 'File not found.' } });
    // Inline, not attachment — the point is a gallery view. Real image
    // bytes only (sniffed at upload), so inline rendering carries no
    // script-execution risk the way an arbitrary file type would.
    res.set({
      'Content-Type': f.content_type,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600'
    }).send(f.data);
  } catch (err) { sendError(res, err, 'Failed to load'); }
});

router.delete('/api/photo-requests/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: { message: 'Invalid id.' } });
  try {
    const n = await pr.remove(req.tenantId, id);
    if (!n) return res.status(404).json({ error: { message: 'Not found.' } });
    res.json({ ok: true });
  } catch (err) { sendError(res, err, 'Failed to delete'); }
});

module.exports = router;
