// Reddit lead-listening — read/settings routes. The actual searching
// happens in lib/redditPollWorker.js; this file only lists results, lets
// a tenant dismiss one, and lets them set their own keywords/subreddits.
// Never posts or replies on Reddit — see that worker's header comment.
const express = require('express');
const { requireAuth } = require('../auth');
const { query } = require('../db');

const router = express.Router();
const oneLine = (s, n) => String(s == null ? '' : s).split('').filter(ch => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127).join('').replace(/\s+/g, ' ').trim().slice(0, n);

router.get('/api/reddit-leads', requireAuth, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  try {
    const result = await query(
      `SELECT id, subreddit, title, snippet, permalink, author, matched_keyword, posted_at, status, found_at,
              COUNT(*) OVER() AS total_count
       FROM reddit_leads WHERE tenant_id = $1 ORDER BY found_at DESC LIMIT $2 OFFSET $3`,
      [req.tenantId, limit, offset]
    );
    const total = result.rows[0] ? Number(result.rows[0].total_count) : 0;
    const leads = result.rows.map(r => { const { total_count, ...rest } = r; return { ...rest, id: Number(rest.id) }; });
    res.json({ leads, total, hasMore: offset + leads.length < total });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load leads: ' + err.message } });
  }
});

// Registered before the /:id routes below — otherwise Express would match
// "settings" as an :id value on a PATCH here, since it's checked first by
// registration order.
router.get('/api/reddit-leads/settings', requireAuth, async (req, res) => {
  try {
    const r = await query('SELECT reddit_search_keywords, reddit_subreddits FROM business_profile WHERE tenant_id = $1', [req.tenantId]);
    const row = r.rows[0] || {};
    res.json({
      keywords: row.reddit_search_keywords || '',
      subreddits: row.reddit_subreddits || '',
      configured: !!(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET)
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load settings: ' + err.message } });
  }
});

router.patch('/api/reddit-leads/settings', requireAuth, async (req, res) => {
  const { keywords, subreddits } = req.body || {};
  try {
    await query(
      `UPDATE business_profile SET
         reddit_search_keywords = COALESCE($2, reddit_search_keywords),
         reddit_subreddits = COALESCE($3, reddit_subreddits)
       WHERE tenant_id = $1`,
      [req.tenantId,
       keywords !== undefined ? oneLine(keywords, 500) : null,
       subreddits !== undefined ? oneLine(subreddits, 300) : null]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to save: ' + err.message } });
  }
});

router.patch('/api/reddit-leads/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: { message: 'Invalid id.' } });
  if (req.body?.status !== 'dismissed') return res.status(400).json({ error: { message: 'status must be "dismissed".' } });
  try {
    const n = (await query('UPDATE reddit_leads SET status = $1 WHERE id = $2 AND tenant_id = $3', ['dismissed', id, req.tenantId])).rowCount;
    if (!n) return res.status(404).json({ error: { message: 'Not found.' } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to update: ' + err.message } });
  }
});

module.exports = router;
