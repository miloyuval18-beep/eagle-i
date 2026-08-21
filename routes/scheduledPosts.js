const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

const VALID_TARGETS = new Set(['facebook', 'instagram']);

router.post('/api/scheduled-posts', requireAuth, async (req, res) => {
  const { message, imageUrl, targets, scheduledAt } = req.body || {};
  if (!message || !message.trim()) {
    return res.status(400).json({ error: { message: 'Post text is required.' } });
  }
  if (!Array.isArray(targets) || !targets.length || !targets.every(t => VALID_TARGETS.has(t))) {
    return res.status(400).json({ error: { message: 'targets must be a non-empty array of "facebook"/"instagram".' } });
  }
  const when = new Date(scheduledAt);
  if (isNaN(when.getTime()) || when.getTime() <= Date.now()) {
    return res.status(400).json({ error: { message: 'scheduledAt must be a valid future date/time.' } });
  }

  try {
    const connRes = await query(
      `SELECT 1 FROM social_connections WHERE tenant_id = $1 AND platform = 'meta'`,
      [req.tenantId]
    );
    if (!connRes.rows.length) {
      return res.status(400).json({ error: { message: 'No Facebook/Instagram account connected yet.' } });
    }

    const result = await query(
      `INSERT INTO scheduled_posts (tenant_id, message, image_url, targets, scheduled_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.tenantId, message, imageUrl || null, JSON.stringify(targets), when.toISOString()]
    );
    res.json({ ok: true, post: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to schedule post: ' + err.message } });
  }
});

router.get('/api/scheduled-posts', requireAuth, async (req, res) => {
  const { status } = req.query;
  try {
    const result = status
      ? await query(
          `SELECT * FROM scheduled_posts WHERE tenant_id = $1 AND status = $2 ORDER BY scheduled_at ASC`,
          [req.tenantId, status]
        )
      : await query(
          `SELECT * FROM scheduled_posts WHERE tenant_id = $1 ORDER BY scheduled_at ASC`,
          [req.tenantId]
        );
    res.json({ posts: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load scheduled posts: ' + err.message } });
  }
});

router.delete('/api/scheduled-posts/:id', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `UPDATE scheduled_posts SET status = 'canceled' WHERE id = $1 AND tenant_id = $2 AND status = 'pending' RETURNING id`,
      [req.params.id, req.tenantId]
    );
    if (!result.rows.length) {
      return res.status(400).json({ error: { message: 'That post is not pending (already sent, failed, or canceled).' } });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to cancel post: ' + err.message } });
  }
});

module.exports = router;
