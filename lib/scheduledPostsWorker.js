// Fires real scheduled_posts rows (created by routes/scheduledPosts.js) by
// calling the exact same publish code the live "Post Now" button uses —
// publishToMeta / publishToGbp — never a second copy of the posting logic.
//
// Plain setInterval poller, same shape as lib/weatherSignals.js's
// startWeatherSignalPoller: no cron dependency anywhere else in this
// codebase, and "check for due rows every 60s" is all this needs. A
// Render free-tier instance that's spun down won't fire a post exactly on
// time — it'll fire late on next wake, since the query is "still pending,"
// not "due exactly now." That's a hosting-tier tradeoff, not a bug here.
const { query } = require('../db');
const { publishToMeta } = require('../routes/social');
const { publishToGbp } = require('../routes/gbp');

const POLL_INTERVAL_MS = 60 * 1000;
const CLAIM_BATCH_SIZE = 20;

let pollerStarted = false;
let running = false;

async function processOne(id) {
  // Atomic claim — same idiom as routes/social.js's oauth_states
  // DELETE...RETURNING: only the caller that flips pending->sending wins,
  // so two overlapping ticks (or a slow tick plus a restart) can't double-post.
  const claim = await query(
    `UPDATE scheduled_posts SET status = 'sending', attempts = attempts + 1
     WHERE id = $1 AND status = 'pending' RETURNING *`,
    [id]
  );
  if (!claim.rows.length) return; // already claimed or canceled since it was selected

  const post = claim.rows[0];
  const targets = Array.isArray(post.targets) ? post.targets : [];
  const metaTargets = targets.filter(t => t === 'facebook' || t === 'instagram');
  const gbpTargets = targets.filter(t => t === 'google');

  const result = {};
  let anyOk = false;
  let firstError = null;

  try {
    if (metaTargets.length) {
      result.meta = await publishToMeta(post.tenant_id, { message: post.message, imageUrl: post.image_url, targets: metaTargets });
      for (const platform of Object.keys(result.meta)) {
        if (result.meta[platform].ok) anyOk = true;
        else firstError = firstError || result.meta[platform].error;
      }
    }
    if (gbpTargets.length) {
      try {
        const gbpResult = await publishToGbp(post.tenant_id, { summary: post.message, imageUrl: post.image_url });
        result.google = { ok: true, ...gbpResult };
        anyOk = true;
      } catch (err) {
        result.google = { ok: false, error: err.message };
        firstError = firstError || err.message;
      }
    }
    await query(
      `UPDATE scheduled_posts SET status = $2, result = $3, error = $4, sent_at = now() WHERE id = $1`,
      [id, anyOk ? 'sent' : 'failed', JSON.stringify(result), anyOk ? null : firstError]
    );
  } catch (err) {
    // publishToMeta itself threw (e.g. connection was disconnected after
    // scheduling) — no per-platform result to show, the whole row failed.
    await query(`UPDATE scheduled_posts SET status = 'failed', error = $2 WHERE id = $1`, [id, err.message]);
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const due = await query(
      `SELECT id FROM scheduled_posts WHERE status = 'pending' AND scheduled_at <= now() ORDER BY scheduled_at ASC LIMIT $1`,
      [CLAIM_BATCH_SIZE]
    );
    for (const row of due.rows) {
      await processOne(row.id).catch(err => console.error('[scheduledPostsWorker] post', row.id, 'failed:', err.message));
    }
  } catch (err) {
    console.error('[scheduledPostsWorker] tick failed:', err.message);
  } finally {
    running = false;
  }
}

function startScheduledPostsWorker() {
  if (pollerStarted) return;
  pollerStarted = true;
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}

module.exports = { startScheduledPostsWorker };
