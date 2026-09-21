// Monthly results report: what Eagle I did and what came of it, for one
// calendar month (Central time), as numbers from the real records. Nothing is
// estimated. Where Eagle I cannot see something (whether a review request led
// to an actual review, posts made outside the scheduler), the report says so
// rather than implying a total.
//
// It can be viewed in the app, saved as a PDF from there, emailed on demand, or
// emailed automatically during the first week of each month.
const { query } = require('../db');
const { sendEmail } = require('./email');
const { zonedToUtc } = require('./outreachQueue');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseMonth(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(key || ''));
  if (!m || +m[2] < 1 || +m[2] > 12) return null;
  return { y: +m[1], m: +m[2] };
}
const keyOf = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
const labelOf = (key) => { const p = parseMonth(key); return p ? `${MONTHS[p.m - 1]} ${p.y}` : key; };

function rangeFor(key) {
  const p = parseMonth(key);
  const ny = p.m === 12 ? p.y + 1 : p.y, nm = p.m === 12 ? 1 : p.m + 1;
  return { start: zonedToUtc(p.y, p.m, 1, 0, 0), end: zonedToUtc(ny, nm, 1, 0, 0) };
}

// The calendar month before `now`, in Central time.
function previousMonthKey(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: 'numeric' })
    .formatToParts(now).map(x => [x.type, x.value]));
  const y = +parts.year, m = +parts.month;
  return m === 1 ? keyOf(y - 1, 12) : keyOf(y, m - 1);
}

async function buildReport(tenantId, monthKey) {
  const p = parseMonth(monthKey);
  if (!p) { const e = new Error('Month must look like 2026-09.'); e.status = 400; throw e; }
  const { start, end } = rangeFor(monthKey);
  const q = (sql, params = []) => query(sql, [tenantId, start, end, ...params]);

  const [outreach, replies, followups, letters, leads, reviews, posts, working, topCats, customers, cs] = await Promise.all([
    q("SELECT COUNT(*)::int AS sent, COUNT(*) FILTER (WHERE delivery_status = 'bounced')::int AS bounced FROM vendor_outreach WHERE tenant_id = $1 AND status = 'sent' AND kind = 'initial' AND created_at >= $2 AND created_at < $3"),
    q(`SELECT COUNT(*)::int AS replies,
              COUNT(*) FILTER (WHERE reply_category = 'interested')::int AS interested,
              COUNT(*) FILTER (WHERE reply_category = 'not_now')::int AS not_now,
              COUNT(*) FILTER (WHERE reply_category = 'unsubscribe')::int AS unsubscribed
       FROM vendor_outreach WHERE tenant_id = $1 AND kind = 'initial' AND status = 'sent' AND replied_at >= $2 AND replied_at < $3`),
    q("SELECT COUNT(*)::int AS n FROM vendor_outreach WHERE tenant_id = $1 AND status = 'sent' AND kind <> 'initial' AND created_at >= $2 AND created_at < $3"),
    q('SELECT COUNT(DISTINCT (source, source_id))::int AS n FROM vendor_mailings WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3'),
    q(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'contacted')::int AS contacted,
              COUNT(*) FILTER (WHERE status = 'won')::int AS won, COUNT(*) FILTER (WHERE status = 'lost')::int AS lost,
              COUNT(*) FILTER (WHERE status = 'new')::int AS still_new
       FROM leads WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`),
    q(`SELECT COUNT(*)::int AS sent, COUNT(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replied,
              COUNT(*) FILTER (WHERE reminder_status = 'sent')::int AS reminders
       FROM review_requests WHERE tenant_id = $1 AND status = 'sent' AND created_at >= $2 AND created_at < $3`),
    q("SELECT COUNT(*)::int AS n FROM scheduled_posts WHERE tenant_id = $1 AND status = 'sent' AND sent_at >= $2 AND sent_at < $3"),
    query("SELECT COUNT(*)::int AS n FROM vendor_relationships WHERE tenant_id = $1 AND stage = 'working'", [tenantId]),
    q(`SELECT category_key, COUNT(*)::int AS sent,
              COUNT(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replies
       FROM vendor_outreach WHERE tenant_id = $1 AND status = 'sent' AND kind = 'initial' AND category_key IS NOT NULL AND created_at >= $2 AND created_at < $3
       GROUP BY category_key HAVING COUNT(*) >= 3 ORDER BY (COUNT(*) FILTER (WHERE replied_at IS NOT NULL))::float / COUNT(*) DESC, COUNT(*) DESC LIMIT 3`),
    q(customerSql).catch(() => ({ rows: [{ sent: 0 }] })),
    q(pageSql).catch(() => ({ rows: [{ views: 0, submissions: 0 }] }))
  ]);

  const r = {
    month: monthKey, label: labelOf(monthKey),
    outreach: {
      sent: outreach.rows[0].sent, bounced: outreach.rows[0].bounced, followUps: followups.rows[0].n, lettersMailed: letters.rows[0].n,
      replies: replies.rows[0].replies, interested: replies.rows[0].interested, notNow: replies.rows[0].not_now, unsubscribed: replies.rows[0].unsubscribed,
      workingTogether: working.rows[0].n,
      topCategories: topCats.rows.map(x => ({ key: x.category_key, sent: x.sent, replies: x.replies }))
    },
    leads: { total: leads.rows[0].total, contacted: leads.rows[0].contacted, won: leads.rows[0].won, lost: leads.rows[0].lost, stillNew: leads.rows[0].still_new },
    reviews: { requestsSent: reviews.rows[0].sent, replied: reviews.rows[0].replied, remindersSent: reviews.rows[0].reminders },
    posts: { scheduledPublished: posts.rows[0].n },
    customers: { emailsSent: Number(customers.rows[0].sent) || 0 },
    landingPages: { views: Number(cs.rows[0].views) || 0, submissions: Number(cs.rows[0].submissions) || 0 }
  };
  r.hasActivity = r.outreach.sent + r.outreach.followUps + r.outreach.lettersMailed + r.outreach.replies + r.leads.total +
    r.reviews.requestsSent + r.posts.scheduledPublished + r.customers.emailsSent + r.landingPages.views > 0;
  return r;
}

// Optional tables from later features; a missing table just means zero.
const customerSql = "SELECT COUNT(*)::int AS sent FROM customer_emails WHERE tenant_id = $1 AND status = 'sent' AND created_at >= $2 AND created_at < $3";
const pageSql = 'SELECT COALESCE(SUM(views),0)::int AS views, COALESCE(SUM(submissions),0)::int AS submissions FROM landing_page_stats s JOIN landing_pages lp ON lp.id = s.page_id WHERE lp.tenant_id = $1 AND s.day >= ($2::timestamptz AT TIME ZONE \'America/Chicago\')::date AND s.day < ($3::timestamptz AT TIME ZONE \'America/Chicago\')::date';

const CATEGORY_HINT = (key, labels) => (labels && labels[key]) || key;

const pl = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function renderReport({ companyName, report, categoryLabels }) {
  const o = report.outreach;
  const lines = [];
  const add = (title, items) => { const rows = items.filter(Boolean); if (rows.length) lines.push({ title, rows }); };
  add('Vendor outreach', [
    o.sent ? `${pl(o.sent, 'first email', 'first emails')} sent${o.bounced ? ` (${o.bounced} bounced)` : ''}` : null,
    o.followUps ? `${pl(o.followUps, 'follow-up email', 'follow-up emails')} sent` : null,
    o.lettersMailed ? `${pl(o.lettersMailed, 'business', 'businesses')} added to mailed letters` : null,
    o.replies ? `${pl(o.replies, 'reply', 'replies')}: ${o.interested} interested, ${o.notNow} not now, ${o.unsubscribed} asked to be removed` : (o.sent ? 'No replies were recorded' : null),
    o.topCategories.length ? 'Best replies from: ' + o.topCategories.map(c => `${CATEGORY_HINT(c.key, categoryLabels)} (${c.replies} of ${c.sent})`).join(', ') : null,
    o.workingTogether ? `${pl(o.workingTogether, 'vendor', 'vendors')} currently marked "working together"` : null
  ]);
  add('Leads', [
    report.leads.total ? `${pl(report.leads.total, 'new lead', 'new leads')} (${report.leads.won} won, ${report.leads.contacted} contacted, ${report.leads.stillNew} still marked new)` : null,
    report.landingPages.views ? `${pl(report.landingPages.views, 'landing-page visitor', 'landing-page visitors')}, ${pl(report.landingPages.submissions, 'form submission', 'form submissions')}` : null
  ]);
  add('Reviews', [
    report.reviews.requestsSent ? `${pl(report.reviews.requestsSent, 'review request', 'review requests')} sent, ${report.reviews.replied} replied to${report.reviews.remindersSent ? `, ${pl(report.reviews.remindersSent, 'reminder', 'reminders')} sent` : ''}` : null,
    report.reviews.requestsSent ? 'Eagle I cannot see whether a customer actually posted a review; check your Google and Yelp pages for the total.' : null
  ]);
  add('Posts and customer email', [
    report.posts.scheduledPublished ? `${pl(report.posts.scheduledPublished, 'scheduled post', 'scheduled posts')} published (posts made with "post now" are not counted here)` : null,
    report.customers.emailsSent ? `${pl(report.customers.emailsSent, 'email', 'emails')} sent to past customers` : null
  ]);
  return lines;
}

function renderEmail({ companyName, report, categoryLabels, appUrl }) {
  const sections = renderReport({ companyName, report, categoryLabels });
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#12203a;line-height:1.5">
<p style="font-size:18px;margin:0 0 2px"><b>${esc(report.label)} results</b></p>
<p style="margin:0 0 16px;color:#5a7290">${esc(companyName)}</p>
${sections.map(s => `<p style="margin:16px 0 4px;font-weight:600">${esc(s.title)}</p><ul style="margin:0;padding-left:18px">${s.rows.map(r => `<li style="margin:2px 0">${esc(r)}</li>`).join('')}</ul>`).join('')}
${appUrl ? `<p style="margin:20px 0 0"><a href="${esc(appUrl)}" style="color:#12203a">Open Eagle I</a> for the full breakdown.</p>` : ''}
<p style="color:#8a9bb0;font-size:11px;margin-top:20px">These are counts from your Eagle I records. You can turn this monthly email off in Account Settings, under Company Profile.</p>
</div>`;
  const text = `${report.label} results — ${companyName}\n\n${sections.map(s => `${s.title}\n${s.rows.map(r => '  - ' + r).join('\n')}`).join('\n\n')}\n\n(Turn this email off in Account Settings.)`;
  return { subject: `Your ${report.label} results from Eagle I`, html, text };
}

async function recipientFor(tenantId) {
  const r = await query(
    `SELECT t.company_name, bp.email AS profile_email,
            (SELECT u.email FROM users u WHERE u.tenant_id = t.id ORDER BY u.created_at ASC LIMIT 1) AS account_email
     FROM tenants t LEFT JOIN business_profile bp ON bp.tenant_id = t.id WHERE t.id = $1`, [tenantId]);
  const row = r.rows[0];
  if (!row) return null;
  const to = [row.profile_email, row.account_email].find(e => e && EMAIL_RE.test(e.trim()));
  return to ? { to: to.trim(), companyName: row.company_name } : null;
}

async function categoryLabels() {
  const { getCatalog } = require('./vendorDirectories');
  const labels = {};
  for (const s of getCatalog()) for (const c of s.categories) labels[`${s.key}:${c.key}`] = c.label;
  return labels;
}

async function emailReport(tenantId, monthKey, { send = sendEmail, appUrl } = {}) {
  const who = await recipientFor(tenantId);
  if (!who) return { sent: false, reason: 'no_recipient' };
  const report = await buildReport(tenantId, monthKey);
  const { subject, html, text } = renderEmail({ companyName: who.companyName, report, categoryLabels: await categoryLabels(), appUrl });
  await send({ to: who.to, subject, html, text, fromName: 'Eagle I' });
  return { sent: true, to: who.to };
}

// Runs from the background tick. During the first week of a month (from 9am
// Central) each opted-in company gets last month's report once; a company with
// no activity that month is skipped. Claiming the month first means two
// overlapping ticks can never send it twice.
async function processMonthlyReports({ now = new Date(), send = sendEmail, appUrl = process.env.APP_BASE_URL || '', tenantId = null } = {}) {
  const summary = { checked: 0, sent: 0, skipped: 0 };
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', day: 'numeric', hour: 'numeric', hour12: false })
    .formatToParts(now).map(x => [x.type, x.value]));
  if (+parts.day > 7 || (+parts.hour % 24) < 9) return summary;
  const key = previousMonthKey(now);
  const due = (await query(
    `SELECT tenant_id FROM business_profile
     WHERE monthly_report_enabled AND last_monthly_report IS DISTINCT FROM $1 AND ($2::uuid IS NULL OR tenant_id = $2::uuid) LIMIT 50`, [key, tenantId])).rows;
  for (const d of due) {
    const claimed = await query(
      `UPDATE business_profile SET last_monthly_report = $2
       WHERE tenant_id = $1 AND monthly_report_enabled AND last_monthly_report IS DISTINCT FROM $2 RETURNING tenant_id`, [d.tenant_id, key]);
    if (!claimed.rows.length) continue;
    summary.checked++;
    try {
      const report = await buildReport(d.tenant_id, key);
      if (!report.hasActivity) { summary.skipped++; continue; }
      const res = await emailReport(d.tenant_id, key, { send, appUrl });
      if (res.sent) summary.sent++; else summary.skipped++;
    } catch (err) { console.error('[monthlyReport] failed for a tenant:', err.message); }
  }
  return summary;
}

module.exports = { buildReport, renderEmail, renderReport, emailReport, processMonthlyReports, previousMonthKey, parseMonth, rangeFor, labelOf, categoryLabels };
