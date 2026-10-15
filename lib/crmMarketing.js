// What marketing brings in, and how much work is already booked, in Eagle I CRM.
//
//  - Where a lead came from: the inquiry form and booking page pass along the
//    ad click (gclid, fbclid...) and campaign tags of the page they were on, so
//    a Google Ads or Facebook lead is labelled as one, not just "website".
//  - Spend: what the company put into each channel each month (typed in, or
//    reminded on the 2nd of the month). Each channel then shows leads, good
//    fits, site visits, signed jobs and signed value, cost per lead, cost per
//    signed job, and the return on every dollar.
//  - Backlog: signed work not yet done against what the crew can do in a
//    month gives "booked N weeks out". Too few weeks: put more into the
//    channel that signs jobs cheapest. Too many: ease off the costliest one.
const { query } = require('../db');
const crm = require('./crm');

const PAID = ['google_ads', 'google_lsa', 'facebook', 'nextdoor', 'houzz', 'angi', 'thumbtack', 'home_show', 'signs', 'landing_page', 'other'];
const WON = ['signed', 'production', 'complete'];
// If there isn't enough history yet: roughly how often a deal at each stage signs.
const DEFAULT_WIN = { qualified: 0.15, site_visit: 0.25, design_agreement: 0.4, in_design: 0.55, proposal: 0.45 };
function err(message, status = 400) { const e = new Error(message); e.status = status; return e; }
const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');

// ---------- where a lead came from ----------

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid'];
function cleanUtm(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const k of UTM_KEYS) if (raw[k] != null && String(raw[k]).trim()) out[k] = String(raw[k]).trim().slice(0, 200);
  if (raw.referrer && /^https?:\/\//.test(String(raw.referrer))) {
    try { out.referrer = new URL(String(raw.referrer)).hostname.slice(0, 120); } catch (e) { /* not a URL */ }
  }
  return Object.keys(out).length ? out : null;
}
// The channel the tags point to, or null when they don't say.
function channelFromUtm(u) {
  if (!u) return null;
  const src = String(u.utm_source || '').toLowerCase();
  const med = String(u.utm_medium || '').toLowerCase();
  const paid = /cpc|ppc|paid|ads?$|display|search/.test(med);
  if (/lsa|local.?services/.test(src) || /lsa/.test(med)) return 'google_lsa';
  if (u.gclid || u.gbraid || u.wbraid || (/google|adwords/.test(src) && paid)) return 'google_ads';
  if (u.fbclid || /facebook|instagram|^fb$|^ig$|meta/.test(src)) return 'facebook';
  if (/nextdoor/.test(src)) return 'nextdoor';
  if (/houzz/.test(src)) return 'houzz';
  if (/angi|homeadvisor/.test(src)) return 'angi';
  if (/thumbtack/.test(src)) return 'thumbtack';
  if (/yard|sign/.test(src)) return 'signs';
  if (/show|expo/.test(src)) return 'home_show';
  if (/facebook|instagram/.test(String(u.referrer || ''))) return 'facebook';
  if (/nextdoor/.test(String(u.referrer || ''))) return 'nextdoor';
  if (/houzz/.test(String(u.referrer || ''))) return 'houzz';
  return null;
}
async function recordUtm({ dealId, utm }) {
  const u = cleanUtm(utm);
  if (u) await query('UPDATE crm_deals SET utm = $2 WHERE id = $1', [dealId, JSON.stringify(u)]);
  return u;
}

// ---------- spend ----------

function monthStart(v) {
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(String(v || ''));
  if (!m || +m[2] < 1 || +m[2] > 12) throw err('Pick a month.');
  return `${m[1]}-${m[2]}-01`;
}
async function saveSpend({ tenantId, source, month, amount, note }) {
  if (!crm.SOURCES.has(source) || source === 'manual') throw err('Pick where the money went.');
  const n = Number(String(amount == null ? '' : amount).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 10000000) throw err('Enter the amount spent.');
  return (await query(
    `INSERT INTO crm_marketing_spend (tenant_id, source, month, amount, note) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, source, month) DO UPDATE SET amount = EXCLUDED.amount, note = EXCLUDED.note RETURNING *`,
    [tenantId, source, monthStart(month), Math.round(n * 100) / 100, String(note || '').trim().slice(0, 300) || null])).rows[0];
}
async function deleteSpend({ tenantId, id }) {
  return (await query('DELETE FROM crm_marketing_spend WHERE id = $1 AND tenant_id = $2', [id, tenantId])).rowCount > 0;
}
async function listSpend(tenantId, limit = 60) {
  return (await query('SELECT * FROM crm_marketing_spend WHERE tenant_id = $1 ORDER BY month DESC, source LIMIT $2', [tenantId, limit])).rows;
}

// ---------- what each channel brought in ----------

// Leads from the last `months` months (this one included), with the money spent over the same months.
async function channelReport(tenantId, { months = 12, now = new Date() } = {}) {
  const local = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const [y, m] = local.split('-').map(Number);
  const startMonth = new Date(Date.UTC(y, m - 1 - (months - 1), 1)).toISOString().slice(0, 10);
  const deals = (await query(
    `SELECT d.source, d.stage, d.grade, d.value, d.site_visit_at FROM crm_deals d
     WHERE d.tenant_id = $1 AND d.created_at >= ($2::date)::timestamp AT TIME ZONE 'America/Chicago' AND d.source <> 'manual'`, [tenantId, startMonth])).rows;
  const spend = (await query(`SELECT source, SUM(amount)::float AS spent FROM crm_marketing_spend WHERE tenant_id = $1 AND month >= $2 GROUP BY source`, [tenantId, startMonth])).rows;
  const by = {};
  const row = (s) => (by[s] = by[s] || { source: s, spend: 0, leads: 0, goodFits: 0, visits: 0, signed: 0, signedValue: 0 });
  for (const s of spend) row(s.source).spend = s.spent;
  for (const d of deals) {
    const r = row(d.source);
    r.leads++;
    if (d.grade === 'A' || d.grade === 'B') r.goodFits++;
    if (d.site_visit_at) r.visits++;
    if (WON.includes(d.stage)) { r.signed++; r.signedValue += Number(d.value || 0); }
  }
  const channels = Object.values(by).map(r => ({
    ...r,
    costPerLead: r.spend && r.leads ? Math.round(r.spend / r.leads) : null,
    costPerSigned: r.spend && r.signed ? Math.round(r.spend / r.signed) : null,
    returnPerDollar: r.spend ? Math.round((r.signedValue / r.spend) * 10) / 10 : null
  })).sort((a, b) => b.signedValue - a.signedValue || b.leads - a.leads);
  const total = channels.reduce((t, r) => ({ spend: t.spend + r.spend, leads: t.leads + r.leads, signed: t.signed + r.signed, signedValue: t.signedValue + r.signedValue, paidSignedValue: t.paidSignedValue + (r.spend ? r.signedValue : 0) }), { spend: 0, leads: 0, signed: 0, signedValue: 0, paidSignedValue: 0 });
  return { from: startMonth, months, channels, total };
}

// ---------- backlog ----------

async function rawSettings(tenantId) {
  const r = (await query('SELECT crm_settings FROM business_profile WHERE tenant_id = $1', [tenantId])).rows[0];
  return (r && r.crm_settings) || {};
}
async function backlogSettings(tenantId) {
  const s = await rawSettings(tenantId);
  const cap = Number(s.monthlyCapacity);
  const lo = parseInt(s.backlogLowWeeks, 10), hi = parseInt(s.backlogHighWeeks, 10);
  return {
    monthlyCapacity: Number.isFinite(cap) && cap > 0 ? cap : null,
    lowWeeks: Number.isFinite(lo) && lo > 0 ? lo : 8,
    highWeeks: Number.isFinite(hi) && hi > (Number.isFinite(lo) && lo > 0 ? lo : 8) ? hi : 20
  };
}
async function saveBacklogSettings(tenantId, { monthlyCapacity, lowWeeks, highWeeks }) {
  const patch = {};
  if (monthlyCapacity !== undefined) {
    const raw = String(monthlyCapacity == null ? '' : monthlyCapacity).replace(/[$,\s]/g, '');
    const n = raw === '' ? null : Number(raw);
    if (n != null && (!Number.isFinite(n) || n <= 0 || n > 1e9)) throw err('Enter how much work you can do in a month, in dollars.');
    patch.monthlyCapacity = n;
  }
  const lo = lowWeeks !== undefined ? parseInt(lowWeeks, 10) : undefined;
  const hi = highWeeks !== undefined ? parseInt(highWeeks, 10) : undefined;
  if (lo !== undefined && !(lo >= 1 && lo <= 104)) throw err('The low mark should be 1 to 104 weeks.');
  if (hi !== undefined && !(hi >= 2 && hi <= 156)) throw err('The high mark should be 2 to 156 weeks.');
  if (lo !== undefined && hi !== undefined && hi <= lo) throw err('The high mark has to be more than the low mark.');
  if (lo !== undefined) patch.backlogLowWeeks = lo;
  if (hi !== undefined) patch.backlogHighWeeks = hi;
  const cur = await rawSettings(tenantId);
  await query('UPDATE business_profile SET crm_settings = $1 WHERE tenant_id = $2', [JSON.stringify({ ...cur, ...patch }), tenantId]);
  return backlogSettings(tenantId);
}

// How often a deal that reached each stage went on to sign, from the last two
// years of closed deals (the default where there are fewer than 5 to go on).
async function winRates(tenantId) {
  const rows = (await query(
    `SELECT a.meta->>'to' AS stage, d.stage IN ('signed', 'production', 'complete') AS won, COUNT(DISTINCT d.id)::int AS n
     FROM crm_activities a JOIN crm_deals d ON d.id = a.deal_id
     WHERE a.tenant_id = $1 AND a.kind = 'stage' AND a.created_at > now() - interval '24 months' AND d.stage IN ('signed', 'production', 'complete', 'lost')
     GROUP BY 1, 2`, [tenantId])).rows;
  const out = {};
  for (const st of Object.keys(DEFAULT_WIN)) {
    const won = rows.filter(r => r.stage === st && r.won).reduce((n, r) => n + r.n, 0);
    const all = rows.filter(r => r.stage === st).reduce((n, r) => n + r.n, 0);
    out[st] = all >= 5 ? Math.round((won / all) * 100) / 100 : DEFAULT_WIN[st];
  }
  return out;
}

// Pure: the advice from the numbers.
function backlogAdvice({ weeksBooked, lowWeeks, highWeeks, channels }) {
  if (weeksBooked == null) return { level: 'unknown', text: 'Tell Eagle I how much work your crew can do in a month to see how far out you’re booked.' };
  const withSigned = (channels || []).filter(c => c.spend > 0 && c.signed > 0);
  const best = [...withSigned].sort((a, b) => a.costPerSigned - b.costPerSigned)[0];
  const spendNoSign = (channels || []).filter(c => c.spend > 0 && !c.signed).sort((a, b) => b.spend - a.spend)[0];
  const worst = spendNoSign || [...withSigned].sort((a, b) => b.costPerSigned - a.costPerSigned)[0];
  const w = Math.round(weeksBooked);
  if (weeksBooked < lowWeeks) {
    return { level: 'ramp', text: `${w < 1 ? 'No signed work is waiting to start' : `Only about ${w} week${w === 1 ? '' : 's'} of signed work ahead`} (you like at least ${lowWeeks} weeks). Time to bring in more leads${best ? `: ${crm.sourceLabel(best.source)} has signed jobs for about ${money(best.costPerSigned)} each, so that’s where an extra dollar works hardest` : ''}.` };
  }
  if (weeksBooked > highWeeks) {
    return { level: 'ease', text: `You’re booked about ${w} weeks out, past your ${highWeeks}-week mark. You can ease off ads for now${worst && worst.source !== (best && best.source) ? `, starting with ${crm.sourceLabel(worst.source)} (${worst.signed ? `about ${money(worst.costPerSigned)} per signed job` : `${money(worst.spend)} spent, nothing signed yet`})` : ''}, or raise your prices.` };
  }
  return { level: 'hold', text: `About ${w} weeks of signed work ahead, right where you want it (${lowWeeks}–${highWeeks}). Keep spend where it is.` };
}

async function backlog(tenantId, { now = new Date() } = {}) {
  const settings = await backlogSettings(tenantId);
  // Signed work not done yet: signed jobs in full, jobs underway by the share of phases left.
  const jobs = (await query(
    `SELECT d.id, d.stage, COALESCE(d.value, 0)::float AS value,
            (SELECT COUNT(*)::int FROM crm_job_items i WHERE i.deal_id = d.id) AS phases,
            (SELECT COUNT(*)::int FROM crm_job_items i WHERE i.deal_id = d.id AND i.status = 'done') AS done
     FROM crm_deals d WHERE d.tenant_id = $1 AND d.stage IN ('signed', 'production')`, [tenantId])).rows;
  const backlogValue = jobs.reduce((n, j) => n + (j.stage === 'production' && j.phases ? j.value * (1 - j.done / j.phases) : j.value), 0);
  // What the crew gets through in a month: as set, or the last 12 months of finished work.
  let capacity = settings.monthlyCapacity, capacitySource = capacity ? 'set' : null;
  if (!capacity) {
    const done = (await query(
      `SELECT COALESCE(SUM(value), 0)::float AS v, MIN(stage_entered_at) AS first FROM crm_deals WHERE tenant_id = $1 AND stage = 'complete' AND stage_entered_at > $2::timestamptz - interval '12 months'`, [tenantId, now])).rows[0];
    if (done.v > 0) {
      const monthsSeen = Math.max(3, Math.min(12, (now - new Date(done.first)) / (30.4 * 86400000)));
      capacity = done.v / monthsSeen; capacitySource = 'history';
    }
  }
  const rates = await winRates(tenantId);
  const open = (await query(`SELECT stage, COALESCE(value, 0)::float AS value FROM crm_deals WHERE tenant_id = $1 AND stage = ANY($2)`, [tenantId, Object.keys(DEFAULT_WIN)])).rows;
  const pipelineWeighted = open.reduce((n, d) => n + d.value * (rates[d.stage] || 0), 0);
  const perWeek = capacity ? capacity / 4.345 : null;
  const weeksBooked = perWeek ? backlogValue / perWeek : null;
  const weeksWithPipeline = perWeek ? (backlogValue + pipelineWeighted) / perWeek : null;
  const report = await channelReport(tenantId, { months: 12, now });
  return {
    backlogValue: Math.round(backlogValue), jobs: jobs.length, monthlyCapacity: capacity ? Math.round(capacity) : null, capacitySource,
    weeksBooked: weeksBooked == null ? null : Math.round(weeksBooked * 10) / 10,
    weeksWithPipeline: weeksWithPipeline == null ? null : Math.round(weeksWithPipeline * 10) / 10,
    pipelineWeighted: Math.round(pipelineWeighted), winRates: rates, settings,
    advice: backlogAdvice({ weeksBooked, lowWeeks: settings.lowWeeks, highWeeks: settings.highWeeks, channels: report.channels })
  };
}

// On the 2nd of each month: companies that track spend are reminded to enter last month's.
async function scanSpendReminder({ now = new Date() } = {}) {
  const local = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const [y, m, d] = local.split('-').map(Number);
  if (d < 2) return { reminded: 0 };
  const last = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
  const label = new Date(last + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const due = (await query(
    `SELECT DISTINCT s.tenant_id FROM crm_marketing_spend s JOIN tenants t ON t.id = s.tenant_id
     WHERE 'crm' = ANY(t.products) AND s.month < $1
       AND NOT EXISTS (SELECT 1 FROM crm_marketing_spend x WHERE x.tenant_id = s.tenant_id AND x.month = $1)`, [last])).rows;
  let n = 0;
  for (const r of due) {
    const added = await crm.addInboxItem({ tenantId: r.tenant_id, kind: 'spend_reminder', dedupeKey: `spend:${last}`, title: `Enter what you spent on marketing in ${label}`, detail: 'Under Account → Marketing & backlog. It keeps cost per signed job accurate.' });
    if (added) n++;
  }
  return { reminded: n };
}

module.exports = {
  PAID, cleanUtm, channelFromUtm, recordUtm, monthStart, saveSpend, deleteSpend, listSpend, channelReport,
  backlogSettings, saveBacklogSettings, winRates, backlogAdvice, backlog, scanSpendReminder
};
