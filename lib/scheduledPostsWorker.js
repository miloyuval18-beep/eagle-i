// Polls scheduled_posts for due rows and fires them through the exact same
// Meta publish path the live "Post Now" button uses (routes/social.js's
// publishToMeta). Plain setInterval, not a cron library — the requirement
// is "check for due rows," which a 60s poll against scheduled_at <= now()
// already covers, and this codebase has no other background-job precedent
// to be consistent with.
const { query } = require('../db');
const { publishToMeta } = require('../routes/social');

const POLL_INTERVAL_MS = 60 * 1000;
let running = false;

async function tick() {
  if (running) return; // don't overlap if a slow send outlasts the interval
  running = true;
  try {
    const due = await query(
      `SELECT id, tenant_id, message, image_url, targets FROM scheduled_posts
       WHERE status = 'pending' AND scheduled_at <= now()
       ORDER BY scheduled_at ASC LIMIT 20`
    );
    for (const post of due.rows) {
      // Atomic claim so a second worker/tick can't double-send the same row.
      const claimed = await query(
        `UPDATE scheduled_posts SET status = 'sending' WHERE id = $1 AND status = 'pending' RETURNING id`,
        [post.id]
      );
      if (!claimed.rows.length) continue;

      try {
        const results = await publishToMeta(post.tenant_id, {
          message: post.message,
          imageUrl: post.image_url,
          targets: post.targets
        });
        await query(
          `UPDATE scheduled_posts SET status = 'sent', result = $1, sent_at = now(), attempts = attempts + 1 WHERE id = $2`,
          [JSON.stringify(results), post.id]
        );
      } catch (err) {
        await query(
          `UPDATE scheduled_posts SET status = 'failed', error = $1, attempts = attempts + 1 WHERE id = $2`,
          [err.message, post.id]
        );
      }
    }
  } catch (err) {
    console.error('Scheduled-posts worker tick failed:', err.message);
  } finally {
    running = false;
  }
}

function startScheduledPostsWorker() {
  setInterval(tick, POLL_INTERVAL_MS);
}

module.exports = { startScheduledPostsWorker, tick };
