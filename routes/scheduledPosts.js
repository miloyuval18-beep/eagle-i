// Real scheduled posts — persistence + management API. lib/scheduledPostsWorker.js
// is what actually fires these at their scheduled_at time, via the same
// publishToMeta/publishToGbp code the live "Post Now" button uses.
const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

const VALID_TARGETS = new Set(['facebook', 'instagram', 'google']);
const VALID_STATUSES = new Set(['pending', 'sending', 'sent', 'failed', 'canceled']);

router.post('/api/scheduled-posts', requireAuth, async (req, res) => {
  const { message, imageUrl, targets, scheduledAt } = req.body || {};
  if (!message || !message.trim()) {
    return res.status(400).json({ error: { message: 'Post text is required.' } });
  }
  if (!Array.isArray(targets) || !targets.length || !targets.every(t => VALID_TARGETS.has(t))) {
    return res.status(400).json({ error: { message: 'targets must be a non-empty array of facebook/instagram/google.' } });
  }
  const when = new Date(scheduledAt);
  if (isNaN(when.getTime()) || when.getTime() <= Date.now()) {
    return res.status(400).json({ error: { message: 'scheduledAt must be a valid future date/time.' } });
  }
  try {
    const wantsMeta = targets.includes('facebook') || targets.includes('instagram');
    const wantsGoogle = targets.includes('google');
    const connRes = await query(
      `SELECT platform FROM social_connections WHERE tenant_id = $1 AND platform = 'meta'
       UNION ALL
       SELECT 'google' FROM google_business_connections WHERE tenant_id = $1`,
      [req.tenantId]
    );
    const connected = new Set(connRes.rows.map(r => r.platform));
    if (wantsMeta && !connected.has('meta')) {
      return res.status(400).json({ error: { message: 'No Facebook/Instagram account connected yet — connect one in Social HQ first.' } });
    }
    if (wantsGoogle && !connected.has('google')) {
      return res.status(400).json({ error: { message: 'No Google Business Profile connected yet — connect one in Social HQ first.' } });
    }
    const result = await query(
      `INSERT INTO scheduled_posts (tenant_id, message, image_url, targets, scheduled_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.tenantId, message.trim(), imageUrl || null, JSON.stringify(targets), when.toISOString()]
    );
    res.json({ ok: true, post: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to schedule post: ' + err.message } });
  }
});

router.get('/api/scheduled-posts', requireAuth, async (req, res) => {
  const { status } = req.query;
  if (status && !VALID_STATUSES.has(status)) {
    return res.status(400).json({ error: { message: 'Invalid status filter.' } });
  }
  try {
    const result = status
      ? await query(`SELECT * FROM scheduled_posts WHERE tenant_id = $1 AND status = $2 ORDER BY scheduled_at ASC`, [req.tenantId, status])
      : await query(`SELECT * FROM scheduled_posts WHERE tenant_id = $1 ORDER BY scheduled_at DESC`, [req.tenantId]);
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
      return res.status(404).json({ error: { message: 'No pending scheduled post found with that id.' } });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to cancel: ' + err.message } });
  }
});

module.exports = router;
