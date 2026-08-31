// Real image hosting — the missing piece for Instagram posting. Instagram's
// Graph API only accepts a publicly reachable image URL for a media
// container (no direct file upload), and Eagle I had no image hosting at
// all until now (see the "Instagram requires a publicly reachable image
// URL" fallback message in routes/social.js). Images are stored directly
// in Postgres (bytea) and served back publicly at GET /img/:id — no new
// external account, no new npm dependency.
const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

const DATA_URL_RE = /^data:image\/(png|jpeg|jpg|webp);base64,/;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB raw (client should compress before upload)

function parseImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !DATA_URL_RE.test(dataUrl)) {
    return { ok: false, error: 'Image must be a PNG, JPEG, or WebP data URL.' };
  }
  const match = dataUrl.match(/^data:(image\/[a-z0-9+.]+);base64,/);
  const mimeType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
  const base64Part = dataUrl.slice(dataUrl.indexOf(',') + 1);
  let buf;
  try {
    buf = Buffer.from(base64Part, 'base64');
  } catch {
    return { ok: false, error: 'Could not decode image data.' };
  }
  if (!buf.length) return { ok: false, error: 'Image data is empty.' };
  if (buf.length > MAX_IMAGE_BYTES) {
    return { ok: false, error: `Image is too large (max ${MAX_IMAGE_BYTES / 1024 / 1024}MB).` };
  }
  return { ok: true, mimeType, buf };
}

function publicImageUrl(req, id) {
  // Render terminates TLS in front of the app, so req.protocol is 'http'
  // even on the live https site unless trust proxy is respected — server.js
  // already sets app.set('trust proxy', true), so this is correct there.
  return `${req.protocol}://${req.get('host')}/img/${id}`;
}

router.post('/api/images/upload', requireAuth, async (req, res) => {
  const { dataUrl } = req.body || {};
  const parsed = parseImageDataUrl(dataUrl);
  if (!parsed.ok) return res.status(400).json({ error: { message: parsed.error } });

  try {
    const result = await query(
      `INSERT INTO post_images (tenant_id, mime_type, data) VALUES ($1, $2, $3) RETURNING id, created_at`,
      [req.tenantId, parsed.mimeType, parsed.buf]
    );
    const row = result.rows[0];
    res.json({ ok: true, id: row.id, url: publicImageUrl(req, row.id), createdAt: row.created_at });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to store image: ' + err.message } });
  }
});

router.get('/api/images', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, mime_type, created_at FROM post_images WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.tenantId]
    );
    res.json({
      images: result.rows.map(r => ({ id: r.id, mimeType: r.mime_type, url: publicImageUrl(req, r.id), createdAt: r.created_at }))
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load images: ' + err.message } });
  }
});

router.delete('/api/images/:id', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `DELETE FROM post_images WHERE id = $1 AND tenant_id = $2 RETURNING id`,
      [req.params.id, req.tenantId]
    );
    if (!result.rows.length) return res.status(404).json({ error: { message: 'Image not found.' } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to delete image: ' + err.message } });
  }
});

// Public — Instagram's own servers (and anyone with the link) need to fetch
// this without a session, exactly like /lp/:slug is public. The id is a
// random uuid, which is the access control (same posture as landing pages).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/img/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).send('Not found');
  try {
    const result = await query(`SELECT mime_type, data FROM post_images WHERE id = $1`, [req.params.id]);
    if (!result.rows.length) return res.status(404).send('Not found');
    const row = result.rows[0];
    res.set('Content-Type', row.mime_type);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(row.data);
  } catch (err) {
    res.status(500).send('Failed to load image');
  }
});

// Attached to the router (not a separate named export) for the same reason
// documented in routes/ads.js — keeps server.js's plain `require(...)` /
// `app.use(...)` wiring unchanged while still letting tests reach the pure
// validation logic directly.
router.parseImageDataUrl = parseImageDataUrl;
module.exports = router;
