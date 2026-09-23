// Daily per-tenant Reddit search — same plain setInterval poller shape as
// lib/competitorRatingWorker.js (module-level guards, atomic per-tenant
// claim via UPDATE...RETURNING so two overlapping ticks can't double-charge
// one tenant's usage cap, per-tenant try/catch so one tenant's failure
// never blocks another's).
//
// Only searches keywords/subreddits the tenant explicitly set — an empty
// setting means "not configured yet," and the tenant is skipped, not
// defaulted to a guessed keyword list (a guessed keyword is how false
// "leads" happen). No AI relevance filtering: what Reddit's own search
// returns for the tenant's own keywords is shown as-is, honestly labeled
// as "posts matching your keywords," not "confirmed leads."
const { query } = require('../db');
const { checkAndIncrementCounter } = require('./usage');
const { isConfigured, searchSubreddit } = require('./redditSignals');
const { qualifiesForPermits } = require('./realEstateAccess');
const { sendEmail } = require('./email');
const { escapeHtml } = require('./landingPageTemplate');

const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const CLAIM_BATCH_SIZE = 20;
const RECHECK_INTERVAL = '1 day';
const CALL_DELAY_MS = 1500; // spaces out calls against the shared, app-wide Reddit rate limit

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function splitList(text) {
  return String(text || '').split(',').map(s => s.trim()).filter(Boolean);
}

let pollerStarted = false;
let running = false;

async function processTenant(tenantId) {
  // Atomic claim, same idiom as competitorRatingWorker's processTenant.
  const claim = await query(
    `UPDATE business_profile SET next_reddit_check_at = now() + interval '${RECHECK_INTERVAL}'
     WHERE tenant_id = $1 AND (next_reddit_check_at IS NULL OR next_reddit_check_at <= now())
     RETURNING tenant_id`,
    [tenantId]
  );
  if (!claim.rows.length) return;

  const tRes = await query('SELECT industry, company_name FROM tenants WHERE id = $1', [tenantId]);
  const tenant = tRes.rows[0];
  if (!tenant || !qualifiesForPermits({ industry: tenant.industry, companyName: tenant.company_name })) return;

  const pRes = await query('SELECT reddit_search_keywords, reddit_subreddits FROM business_profile WHERE tenant_id = $1', [tenantId]);
  const profile = pRes.rows[0];
  const keywords = splitList(profile && profile.reddit_search_keywords);
  const subreddits = splitList(profile && profile.reddit_subreddits);
  if (!keywords.length || !subreddits.length) return; // tenant hasn't set up their search yet

  const usage = await checkAndIncrementCounter(tenantId, { capColumn: 'monthly_reddit_search_cap', counterColumn: 'reddit_search_count' });
  if (!usage.allowed) return;

  const newLeads = [];
  for (const subreddit of subreddits) {
    for (const keyword of keywords) {
      try {
        await sleep(CALL_DELAY_MS);
        const posts = await searchSubreddit(subreddit, keyword);
        for (const p of posts) {
          if (!p.postId) continue;
          const inserted = await query(
            `INSERT INTO reddit_leads (tenant_id, reddit_post_id, subreddit, title, snippet, permalink, author, matched_keyword, posted_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (tenant_id, reddit_post_id) DO NOTHING
             RETURNING id, title, subreddit, permalink, matched_keyword`,
            [tenantId, p.postId, subreddit, p.title.slice(0, 300), p.selftext.slice(0, 200), p.permalink, p.author, keyword, p.createdUtc]
          );
          if (inserted.rows.length) newLeads.push(inserted.rows[0]);
        }
      } catch (err) {
        console.error(`[redditPollWorker] search failed for tenant ${tenantId}, r/${subreddit} "${keyword}":`, err.message);
      }
    }
  }

  if (!newLeads.length) return;

  const userRes = await query('SELECT email FROM users WHERE tenant_id = $1 ORDER BY created_at ASC LIMIT 1', [tenantId]);
  const toEmail = userRes.rows[0]?.email;
  if (!toEmail) return;

  const listText = newLeads.map(l => `r/${l.subreddit} — "${l.title}"\n${l.permalink}`).join('\n\n');
  const listHtml = newLeads.map(l =>
    `<p style="margin:0 0 12px"><strong>r/${escapeHtml(l.subreddit)}</strong> — ${escapeHtml(l.title)}<br>
     <a href="${escapeHtml(l.permalink)}">${escapeHtml(l.permalink)}</a></p>`
  ).join('');

  try {
    await sendEmail({
      to: toEmail,
      subject: `${newLeads.length} new Reddit post${newLeads.length === 1 ? '' : 's'} matching your keywords`,
      text: `Eagle I found ${newLeads.length} new Reddit post(s) matching your saved keywords:\n\n${listText}\n\nThese are real posts matching your keywords — not confirmed leads. Reply from your own Reddit account; Eagle I never posts on your behalf.\n\n— Eagle I`,
      html: `<p>Eagle I found ${newLeads.length} new Reddit post${newLeads.length === 1 ? '' : 's'} matching your saved keywords:</p>${listHtml}<p style="color:#666;font-size:13px">These are real posts matching your keywords — not confirmed leads. Reply from your own Reddit account; Eagle I never posts on your behalf.</p><p>— Eagle I</p>`
    });
  } catch (err) {
    console.error(`[redditPollWorker] failed to send new-leads email for tenant ${tenantId}:`, err.message);
  }
}

async function tick() {
  if (running || !isConfigured()) return;
  running = true;
  try {
    const due = await query(
      `SELECT tenant_id FROM business_profile WHERE next_reddit_check_at IS NULL OR next_reddit_check_at <= now() LIMIT $1`,
      [CLAIM_BATCH_SIZE]
    );
    for (const row of due.rows) {
      await processTenant(row.tenant_id).catch(err => console.error('[redditPollWorker] tenant', row.tenant_id, 'failed:', err.message));
    }
  } catch (err) {
    console.error('[redditPollWorker] tick failed:', err.message);
  } finally {
    running = false;
  }
}

function startRedditPollWorker() {
  if (pollerStarted) return;
  pollerStarted = true;
  if (!isConfigured()) {
    console.warn('[redditPollWorker] REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET not set — Reddit lead-listening is disabled.');
    return;
  }
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}

module.exports = { startRedditPollWorker };
