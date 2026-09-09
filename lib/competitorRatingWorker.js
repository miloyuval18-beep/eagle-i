// Periodically re-checks a tenant's already-cached real competitors'
// Google ratings and actively emails the tenant when one drops
// meaningfully — see migrations/1757200000000_competitor_rating_alerts.js
// and lib/competitorRatingAlerts.js for the "why an email, not just a
// dashboard card" reasoning.
//
// Same plain setInterval poller shape as lib/scheduledPostsWorker.js, but
// a daily tick (not 60s) — "who's due for their weekly check" only needs
// evaluating once a day. Claim is per-tenant (not per-row) via the same
// atomic UPDATE...WHERE...RETURNING idiom, so two overlapping ticks can't
// double-charge one tenant's usage cap in the same cycle.
const { query } = require('../db');
const { checkAndIncrementCounter } = require('./usage');
const { getPlaceRatingById } = require('./googlePlaces');
const { detectRatingDrops } = require('./competitorRatingAlerts');
const { sendEmail } = require('./email');
const { escapeHtml } = require('./landingPageTemplate');

const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const CLAIM_BATCH_SIZE = 20;
const RECHECK_INTERVAL = '7 days';

let pollerStarted = false;
let running = false;

async function processTenant(tenantId) {
  // Atomic claim — only the caller that actually flips next_rating_check_at
  // forward wins, so an overlapping tick (or a slow tick plus a restart)
  // can't process the same tenant twice in one cycle.
  const claim = await query(
    `UPDATE business_profile SET next_rating_check_at = now() + interval '${RECHECK_INTERVAL}'
     WHERE tenant_id = $1 AND (next_rating_check_at IS NULL OR next_rating_check_at <= now())
     RETURNING tenant_id`,
    [tenantId]
  );
  if (!claim.rows.length) return; // already claimed since it was selected

  const usage = await checkAndIncrementCounter(tenantId, { capColumn: 'monthly_rating_check_cap', counterColumn: 'rating_check_count' });
  if (!usage.allowed) return; // capped this month — this tenant's next attempt is next week, and it'll succeed once the cap resets

  const profileRes = await query('SELECT places_competitors FROM business_profile WHERE tenant_id = $1', [tenantId]);
  const profile = profileRes.rows[0];
  if (!profile) return;
  // Only competitors with a stable placeId (added after this feature) can
  // be re-checked as "the same business" over time — older cached rows
  // from before that field existed are silently skipped, not guessed at.
  const competitors = (profile.places_competitors || []).filter(c => c && c.placeId);
  if (!competitors.length) return;

  for (const c of competitors) {
    try {
      const { rating, reviewCount } = await getPlaceRatingById(c.placeId);
      await query(
        `INSERT INTO competitor_rating_history (tenant_id, place_id, competitor_name, rating, review_count) VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, c.placeId, c.name, rating, reviewCount]
      );
    } catch (err) {
      console.error(`[competitorRatingWorker] rating check failed for tenant ${tenantId}, competitor ${c.placeId}:`, err.message);
    }
  }

  const historyRes = await query(
    `SELECT place_id, competitor_name, rating, review_count, checked_at FROM competitor_rating_history WHERE tenant_id = $1 ORDER BY checked_at ASC`,
    [tenantId]
  );
  const alerts = detectRatingDrops(historyRes.rows);
  if (!alerts.length) return;

  const userRes = await query('SELECT email FROM users WHERE tenant_id = $1 ORDER BY created_at ASC LIMIT 1', [tenantId]);
  const toEmail = userRes.rows[0]?.email;
  if (!toEmail) return;

  for (const alert of alerts) {
    try {
      await sendEmail({
        to: toEmail,
        subject: `${alert.competitorName}'s Google rating just dropped`,
        text: `${alert.competitorName}'s average Google rating dropped from ${alert.previousRating} to ${alert.currentRating} stars.\n\nThis reflects the real aggregate change from Google Places — not a specific review's content, since Places doesn't expose individual reviews.\n\nMight be a good moment to lean into your own reviews or run a targeted ad in their area.\n\n— Eagle I`,
        html: `<p><strong>${escapeHtml(alert.competitorName)}</strong>'s average Google rating just dropped from <strong>${alert.previousRating}</strong> to <strong>${alert.currentRating}</strong> stars.</p>
<p style="color:#666;font-size:13px">This reflects the real aggregate change from Google Places — not a specific review's content, since Places doesn't expose individual reviews.</p>
<p>Might be a good moment to lean into your own reviews or run a targeted ad in their area.</p>
<p>— Eagle I</p>`
      });
    } catch (err) {
      console.error(`[competitorRatingWorker] failed to send rating-drop email for tenant ${tenantId}:`, err.message);
    }
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const due = await query(
      `SELECT tenant_id FROM business_profile WHERE next_rating_check_at IS NULL OR next_rating_check_at <= now() LIMIT $1`,
      [CLAIM_BATCH_SIZE]
    );
    for (const row of due.rows) {
      await processTenant(row.tenant_id).catch(err => console.error('[competitorRatingWorker] tenant', row.tenant_id, 'failed:', err.message));
    }
  } catch (err) {
    console.error('[competitorRatingWorker] tick failed:', err.message);
  } finally {
    running = false;
  }
}

function startCompetitorRatingWorker() {
  if (pollerStarted) return;
  pollerStarted = true;
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}

module.exports = { startCompetitorRatingWorker };
