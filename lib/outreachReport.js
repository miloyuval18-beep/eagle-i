// Results of vendor outreach: how many emails went out and how many people
// answered, broken down by category, city and (for two-version tests) which
// version did better.
//
// Only first emails count. Follow-ups are excluded so a business isn't counted
// twice, and automatic out-of-office replies are never counted as replies.
// A reply rate is replies divided by emails that were actually delivered (sent
// minus hard bounces). Replies keep arriving for days, so recent sends always
// look worse than they will end up.
const { query } = require('../db');
const { getCatalog } = require('./vendorDirectories');

const MIN_PER_VERSION = 20;

// Two-proportion z test, worded for a business owner rather than a statistician.
function compareVersions(a, b, { min = MIN_PER_VERSION, noun = 'delivered emails', none = 'Neither version has a reply yet. Replies can take a few days.' } = {}) {
  const out = { verdict: 'too_early', winner: null, text: '' };
  if (a.delivered < min || b.delivered < min) {
    out.text = `Too early to call. Each version needs about ${min} ${noun}; version A has ${a.delivered} and version B has ${b.delivered}.`;
    return out;
  }
  if (a.replies + b.replies === 0) {
    out.verdict = 'no_replies';
    out.text = none;
    return out;
  }
  const pa = a.replies / a.delivered, pb = b.replies / b.delivered;
  const pooled = (a.replies + b.replies) / (a.delivered + b.delivered);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.delivered + 1 / b.delivered));
  const z = se === 0 ? 0 : (pa - pb) / se;
  const lead = pa > pb ? 'A' : 'B';
  if (Math.abs(z) >= 1.96) { out.verdict = 'clear'; out.winner = lead; out.text = `Version ${lead} is doing better, and the gap is large enough that it is unlikely to be luck.`; }
  else if (Math.abs(z) >= 1.28) { out.verdict = 'leaning'; out.winner = lead; out.text = `Version ${lead} is ahead, but the gap could still be luck. Keep collecting replies before switching.`; }
  else { out.verdict = 'no_difference'; out.text = 'No real difference between the versions yet.'; }
  return out;
}

const rate = (replies, delivered) => (delivered > 0 ? Math.round((replies / delivered) * 1000) / 10 : null);

function shape(r) {
  const sent = Number(r.sent), bounced = Number(r.bounced);
  const delivered = sent - bounced;
  const replies = Number(r.replies);
  return {
    sent, bounced, delivered, replies, interested: Number(r.interested), notNow: Number(r.not_now), unsubscribed: Number(r.unsubscribed),
    replyRate: rate(replies, delivered), interestedRate: rate(Number(r.interested), delivered)
  };
}

const AGG = `COUNT(*) AS sent,
  COUNT(*) FILTER (WHERE delivery_status = 'bounced') AS bounced,
  COUNT(*) FILTER (WHERE replied_at IS NOT NULL) AS replies,
  COUNT(*) FILTER (WHERE replied_at IS NOT NULL AND reply_category = 'interested') AS interested,
  COUNT(*) FILTER (WHERE replied_at IS NOT NULL AND reply_category = 'not_now') AS not_now,
  COUNT(*) FILTER (WHERE replied_at IS NOT NULL AND reply_category = 'unsubscribe') AS unsubscribed`;
const BASE = "tenant_id = $1 AND kind = 'initial' AND status = 'sent' AND created_at > now() - ($2 || ' days')::interval";

async function getReport(tenantId, { days = 90 } = {}) {
  const d = String(Math.min(730, Math.max(7, parseInt(days, 10) || 90)));
  const labels = {};
  for (const s of getCatalog()) for (const c of s.categories) labels[`${s.key}:${c.key}`] = c.label;

  const [overall, byCat, byCity, tests, subjects] = await Promise.all([
    query(`SELECT ${AGG} FROM vendor_outreach WHERE ${BASE}`, [tenantId, d]),
    query(`SELECT category_key, ${AGG} FROM vendor_outreach WHERE ${BASE} AND category_key IS NOT NULL GROUP BY category_key ORDER BY COUNT(*) DESC`, [tenantId, d]),
    query(`SELECT city, ${AGG} FROM vendor_outreach WHERE ${BASE} AND city IS NOT NULL AND city <> '' GROUP BY city ORDER BY COUNT(*) DESC LIMIT 40`, [tenantId, d]),
    query(`SELECT test_id, variant, MIN(created_at) AS started, MIN(subject) AS subject, MIN(message) AS message, ${AGG}
           FROM vendor_outreach WHERE ${BASE} AND test_id IS NOT NULL AND variant IS NOT NULL
           GROUP BY test_id, variant ORDER BY MIN(created_at) DESC`, [tenantId, d]),
    query(`SELECT subject, ${AGG} FROM vendor_outreach WHERE ${BASE} AND subject IS NOT NULL GROUP BY subject HAVING COUNT(*) >= 5 ORDER BY COUNT(*) DESC LIMIT 10`, [tenantId, d])
  ]);

  const testMap = new Map();
  for (const r of tests.rows) {
    const t = testMap.get(r.test_id) || { testId: r.test_id, started: r.started };
    t[r.variant] = { ...shape(r), subject: r.subject, message: r.message };
    testMap.set(r.test_id, t);
  }
  const abTests = [...testMap.values()].filter(t => t.A && t.B).map(t => ({ ...t, result: compareVersions(t.A, t.B) }));

  return {
    days: Number(d),
    overall: shape(overall.rows[0]),
    byCategory: byCat.rows.map(r => ({ key: r.category_key, label: labels[r.category_key] || r.category_key, ...shape(r) })),
    byCity: byCity.rows.map(r => ({ city: r.city, ...shape(r) })),
    bySubject: subjects.rows.map(r => ({ subject: r.subject, ...shape(r) })),
    abTests
  };
}

module.exports = { getReport, compareVersions, MIN_PER_VERSION };
