// Landing-page results: how many people visited and how many filled out the
// form, per page and (during a two-version test) per version.
//
// A "visitor" is counted once per browser: the first time it loads the page it
// is counted and given a cookie that also remembers which version it was shown,
// so a returning visitor always sees the same version and a refresh is never a
// second visit. Obvious robots (link previews, uptime monitors, crawlers) are
// neither counted nor assigned a version. Counts are per day in Central time.
const crypto = require('crypto');
const { query } = require('../db');
const { compareVersions } = require('./outreachReport');

const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|monitor|uptime|curl|wget|python|node-fetch|axios|go-http|java\/|scrapy|lighthouse|pingdom/i;
const COOKIE_MAX_AGE = 30 * 24 * 3600;
const MIN_VISITORS_PER_VERSION = 100;

const isBot = (ua) => !ua || BOT_RE.test(String(ua));

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
const cookieName = (pageId) => `lpv_${String(pageId).replace(/-/g, '').slice(0, 12)}`;

// Decides which version this request sees, and whether to count it as a new visitor.
function assignVisit({ page, cookieHeader, userAgent }) {
  const bot = isBot(userAgent);
  const name = cookieName(page.id);
  const existing = readCookie(cookieHeader, name);
  const abOn = !!(page.ab_enabled && (page.headline_b || page.subheadline_b || page.cta_primary_b));
  let variant = existing === 'A' || existing === 'B' ? existing : null;
  if (!abOn) variant = 'A';
  else if (!variant) variant = bot ? 'A' : (crypto.randomInt(2) ? 'B' : 'A');
  return { variant, countView: !bot && !existing, setCookie: !bot && !existing ? `${name}=${variant}; Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax` : null, cookieName: name, existingVariant: existing === 'A' || existing === 'B' ? existing : null };
}

async function bump(pageId, variant, col) {
  await query(
    `INSERT INTO landing_page_stats (page_id, variant, day, ${col})
     VALUES ($1, $2, (now() AT TIME ZONE 'America/Chicago')::date, 1)
     ON CONFLICT (page_id, variant, day) DO UPDATE SET ${col} = landing_page_stats.${col} + 1`, [pageId, variant]);
}
const recordView = (pageId, variant) => bump(pageId, variant, 'views');
const recordSubmission = (pageId, variant) => bump(pageId, variant, 'submissions');

const rate = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

// Totals for every page of a tenant; during a test, the test's own numbers per version.
async function getStats(tenantId) {
  const pages = (await query('SELECT id, ab_enabled, ab_started_at FROM landing_pages WHERE tenant_id = $1', [tenantId])).rows;
  if (!pages.length) return {};
  const rows = (await query(
    `SELECT s.page_id, s.variant, s.day, s.views, s.submissions
     FROM landing_page_stats s JOIN landing_pages lp ON lp.id = s.page_id WHERE lp.tenant_id = $1`, [tenantId])).rows;
  const out = {};
  for (const p of pages) {
    const mine = rows.filter(r => r.page_id === p.id);
    const total = mine.reduce((a, r) => ({ views: a.views + r.views, submissions: a.submissions + r.submissions }), { views: 0, submissions: 0 });
    const entry = { views: total.views, submissions: total.submissions, rate: rate(total.submissions, total.views), ab: null };
    if (p.ab_enabled && p.ab_started_at) {
      const startDay = new Date(p.ab_started_at).toISOString().slice(0, 10);
      const sum = (v) => mine.filter(r => r.variant === v && String(r.day instanceof Date ? r.day.toISOString() : r.day).slice(0, 10) >= startDay)
        .reduce((a, r) => ({ views: a.views + r.views, submissions: a.submissions + r.submissions }), { views: 0, submissions: 0 });
      const A = sum('A'), B = sum('B');
      entry.ab = {
        startedAt: p.ab_started_at,
        A: { ...A, rate: rate(A.submissions, A.views) }, B: { ...B, rate: rate(B.submissions, B.views) },
        result: compareVersions({ delivered: A.views, replies: A.submissions }, { delivered: B.views, replies: B.submissions },
          { min: MIN_VISITORS_PER_VERSION, noun: 'visitors', none: 'Nobody has filled out the form on either version yet.' })
      };
    }
    out[p.id] = entry;
  }
  return out;
}

module.exports = { isBot, readCookie, cookieName, assignVisit, recordView, recordSubmission, getStats, MIN_VISITORS_PER_VERSION };
