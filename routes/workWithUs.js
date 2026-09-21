// The public "work with us" page and the owner's tools for it.
// See lib/workWithUs.js for what is locked down and why.
const express = require('express');
const { requireAuth } = require('../auth');
const wwu = require('../lib/workWithUs');
const relationships = require('../lib/relationships');
const { query } = require('../db');

const router = express.Router();
const SLUG_RE = /^[a-z0-9-]{3,60}$/;
const sendError = (res, err, what) => (err && err.status
  ? res.status(err.status).json({ error: { message: err.message, code: err.code } })
  : res.status(500).json({ error: { message: `${what}: ${err.message}` } }));
const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;

// Per-address limit on the public form (a vendor rarely needs more than one try).
const HITS = new Map();
const LIMIT = 4, WINDOW_MS = 60 * 60 * 1000;
function limited(ip) {
  const now = Date.now();
  const hits = (HITS.get(ip) || []).filter(t => now - t < WINDOW_MS);
  hits.push(now);
  HITS.set(ip, hits);
  if (HITS.size > 5000) for (const [k, v] of HITS) if (!v.some(t => now - t < WINDOW_MS)) HITS.delete(k); // keep the map from growing without bound
  return hits.length > LIMIT;
}

// ---- Public ----

router.get('/work-with-us/:slug', async (req, res) => {
  if (!SLUG_RE.test(req.params.slug)) return res.status(404).send('Page not found.');
  try {
    const page = await wwu.getPublicPage(req.params.slug);
    if (!page) return res.status(404).send('Page not found.');
    res.set({ 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' })
      .send(wwu.renderPage({ companyName: page.company_name, intro: page.intro || wwu.DEFAULT_INTRO, serviceArea: page.service_area, slug: req.params.slug }));
  } catch (err) { res.status(500).send('Failed to load page.'); }
});

router.post('/work-with-us/:slug/submit', async (req, res) => {
  if (!SLUG_RE.test(req.params.slug)) return res.status(404).json({ error: { message: 'Page not found.' } });
  if (limited(req.ip)) return res.status(429).json({ error: { message: 'Too many submissions from this connection. Please try again later.' } });
  // Hidden trap field: a person never fills it. Say "thanks" and store nothing.
  if (req.body && req.body.fax) return res.json({ ok: true });
  try {
    await wwu.submit(req.params.slug, req.body, { baseUrl: baseUrl(req) });
    res.json({ ok: true });
  } catch (err) { sendError(res, err, 'Failed to submit'); }
});

// ---- Owner ----

router.get('/api/work-page', requireAuth, async (req, res) => {
  try {
    const s = await wwu.getSettings(req.tenantId);
    if (!s) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    res.json({ ...s, url: s.slug ? `${baseUrl(req)}/work-with-us/${s.slug}` : null, qrUrl: s.slug ? `${baseUrl(req)}/work-with-us/${s.slug}?src=qr` : null });
  } catch (err) { sendError(res, err, 'Failed to load'); }
});

router.put('/api/work-page', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const s = await wwu.saveSettings(req.tenantId, { enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined, intro: b.intro });
    res.json({ ...s, url: s.slug ? `${baseUrl(req)}/work-with-us/${s.slug}` : null, qrUrl: s.slug ? `${baseUrl(req)}/work-with-us/${s.slug}?src=qr` : null });
  } catch (err) { sendError(res, err, 'Failed to save'); }
});

router.get('/api/work-page/submissions', requireAuth, async (req, res) => {
  try { res.json({ submissions: await wwu.listSubmissions(req.tenantId) }); }
  catch (err) { sendError(res, err, 'Failed to load'); }
});

router.get('/api/work-page/submissions/:id/files/:fileId', requireAuth, async (req, res) => {
  const id = Number(req.params.id), fileId = Number(req.params.fileId);
  if (!Number.isInteger(id) || !Number.isInteger(fileId)) return res.status(400).json({ error: { message: 'Invalid id.' } });
  try {
    const f = await wwu.getFile(req.tenantId, id, fileId);
    if (!f) return res.status(404).json({ error: { message: 'File not found.' } });
    res.set({
      'Content-Type': f.content_type,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'"
    }).send(f.data);
  } catch (err) { sendError(res, err, 'Failed to download'); }
});

router.patch('/api/work-page/submissions/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: { message: 'Invalid id.' } });
  try { await wwu.setStatus(req.tenantId, id, req.body && req.body.status); res.json({ ok: true }); }
  catch (err) { sendError(res, err, 'Failed to update'); }
});

router.delete('/api/work-page/submissions/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: { message: 'Invalid id.' } });
  try {
    const n = await wwu.removeSubmission(req.tenantId, id);
    if (!n) return res.status(404).json({ error: { message: 'Not found.' } });
    await query("DELETE FROM vendor_relationships WHERE tenant_id = $1 AND source = 'inbound' AND source_id = $2 AND stage = 'replied' AND notes LIKE 'Came in through your Work With Us page%'", [req.tenantId, id]);
    res.json({ ok: true });
  } catch (err) { sendError(res, err, 'Failed to delete'); }
});

module.exports = router;
