// Where each job is heading, in Eagle I CRM.
//
//  - Cost forecast: what the job will most likely cost by the end, from the
//    budget (the accepted estimate's cost plus approved change orders), what's
//    been spent, what's committed on open purchase orders, how far along the
//    schedule is, and how this company's finished jobs came out against their
//    budgets. It starts rough (few finished jobs, no schedule) and says so; it
//    gets better as jobs finish. A job heading well under its planned margin
//    shows up in Needs you once.
//  - Schedule risk: everything that tends to push a finish date, in one
//    place: phases running late, subs who haven't confirmed (or can't make
//    it), materials not received by the date they're needed, selections the
//    homeowner hasn't made, unsigned change orders, rain on outdoor work,
//    inspections coming up, a sub's insurance lapsing. A score, the reasons,
//    and a likely finish date. A high score shows up in Needs you once a week.
//
// No AI is needed for either: they're arithmetic over the job's own records,
// so every number can be traced.
const { query } = require('../db');
const crm = require('./crm');

const DAY = 86400000;
const ymd = (d) => (d instanceof Date ? d.toISOString() : String(d || '')).slice(0, 10);
const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
const todayYmd = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const daysBetween = (a, b) => Math.round((new Date(ymd(b) + 'T12:00:00Z') - new Date(ymd(a) + 'T12:00:00Z')) / DAY);
function workdays(a, b) {
  let n = 0; const x = new Date(ymd(a) + 'T12:00:00Z'), end = new Date(ymd(b) + 'T12:00:00Z');
  while (x <= end && n < 2000) { if (![0, 6].includes(x.getUTCDay())) n++; x.setUTCDate(x.getUTCDate() + 1); }
  return Math.max(1, n);
}

// ---------- cost forecast ----------

// Pure: share of the schedule done, weighted by each phase's working days.
function progressOf(items) {
  const dated = items.filter(i => i.start_date && i.end_date);
  if (!dated.length) {
    if (!items.length) return null;
    return items.reduce((n, i) => n + (i.status === 'done' ? 1 : i.status === 'doing' ? 0.5 : 0), 0) / items.length;
  }
  let total = 0, done = 0;
  for (const i of dated) { const w = workdays(i.start_date, i.end_date); total += w; done += w * (i.status === 'done' ? 1 : i.status === 'doing' ? 0.5 : 0); }
  return total ? done / total : null;
}

// Pure: the forecast. `history`: actual / budget on finished jobs (ratios).
function forecastCost({ contract, budget, spent, committed, progress, history = [] }) {
  const sorted = [...history].filter(x => x > 0.3 && x < 3).sort((a, b) => a - b);
  const ratio = sorted.length >= 3 ? sorted[Math.floor(sorted.length / 2)] : 1;
  const known = spent + committed;
  let eac = Math.max(known, budget * ratio);
  let method = sorted.length >= 3 ? `budget × ${ratio.toFixed(2)} (how your last ${sorted.length} finished jobs came out)` : 'the budget (not enough finished jobs yet to adjust it)';
  // Spending ahead of the work: project the pace, weighted by how far along it is.
  if (progress != null && progress >= 0.15 && spent > 0) {
    const pace = spent / progress;
    if (pace > eac) { eac = progress * pace + (1 - progress) * eac; method = `spending pace so far (${Math.round(progress * 100)}% done, ${money(spent)} spent)`; }
  }
  eac = Math.round(Math.max(eac, known) * 100) / 100;
  const plannedMargin = contract ? (contract - budget) / contract * 100 : null;
  const margin = contract ? (contract - eac) / contract * 100 : null;
  const confidence = sorted.length >= 5 && progress != null ? 'good' : sorted.length >= 3 || progress != null ? 'rough' : 'very rough';
  return { contract, budget, spent, committed, progress, eac, overBudget: Math.round((eac - budget) * 100) / 100, plannedMargin, margin, method, confidence, finishedJobs: sorted.length };
}

async function costInputs(dealId) {
  const est = (await query(`SELECT cost_total, total, subtotal FROM crm_estimates WHERE deal_id = $1 AND status = 'accepted' AND kind = 'construction' ORDER BY accepted_at DESC LIMIT 1`, [dealId])).rows[0];
  const co = (await query(`SELECT COALESCE(SUM(amount), 0)::float AS amount, COALESCE(SUM(cost), 0)::float AS cost FROM crm_change_orders WHERE deal_id = $1 AND status = 'approved'`, [dealId])).rows[0];
  const spent = (await query(`SELECT COALESCE(SUM(amount), 0)::float AS n FROM crm_costs WHERE deal_id = $1`, [dealId])).rows[0].n;
  // Open purchase orders not yet in costs (minus bills already matched to them).
  const committed = (await query(
    `SELECT COALESCE(SUM(GREATEST(p.total - COALESCE((SELECT SUM(c.amount) FROM crm_costs c WHERE c.matched_po_id = p.id), 0), 0)), 0)::float AS n
     FROM crm_purchase_orders p WHERE p.deal_id = $1 AND p.status = 'sent' AND NOT EXISTS (SELECT 1 FROM crm_costs c WHERE c.po_id = p.id)`, [dealId])).rows[0].n;
  const items = (await query(`SELECT start_date, end_date, status FROM crm_job_items WHERE deal_id = $1`, [dealId])).rows;
  const value = (await query(`SELECT value FROM crm_deals WHERE id = $1`, [dealId])).rows[0];
  return { est, co, spent, committed, items, dealValue: value && value.value != null ? Number(value.value) : null };
}

async function finishedRatios(tenantId) {
  return (await query(
    `SELECT (SELECT SUM(amount) FROM crm_costs c WHERE c.deal_id = d.id)::float / NULLIF(e.cost_total + COALESCE((SELECT SUM(cost) FROM crm_change_orders x WHERE x.deal_id = d.id AND x.status = 'approved'), 0), 0)::float AS r
     FROM crm_deals d JOIN LATERAL (SELECT cost_total FROM crm_estimates e WHERE e.deal_id = d.id AND e.status = 'accepted' AND e.kind = 'construction' ORDER BY accepted_at DESC LIMIT 1) e ON true
     WHERE d.tenant_id = $1 AND d.stage = 'complete' AND e.cost_total > 0 ORDER BY d.updated_at DESC LIMIT 30`, [tenantId])).rows.map(r => Number(r.r)).filter(Number.isFinite);
}

async function costForecast(tenantId, dealId) {
  const { est, co, spent, committed, items, dealValue } = await costInputs(dealId);
  if (!est) return { ready: false, why: 'No accepted construction estimate on this job yet, so there’s no budget to forecast against.' };
  // The contract is the deal's value (approved change orders are added to it as they're approved), as on the rest of the job screen.
  return { ready: true, ...forecastCost({ contract: dealValue || Number(est.total) + co.amount, budget: Number(est.cost_total) + co.cost, spent, committed, progress: progressOf(items), history: await finishedRatios(tenantId) }) };
}

// ---------- schedule risk ----------

const inDays = (d) => (d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`);
// Pure: score and reasons from the job's facts.
function scheduleRiskFrom({ today, items, pos, selections, cos, weather = [], vendors = {} }) {
  const reasons = [];
  let score = 0;
  const add = (pts, text, level = 'warn') => { score += pts; reasons.push({ text, level, pts }); };
  let slip = 0;
  let late = 0;
  for (const i of items) {
    if (i.status === 'done') continue;
    if (i.end_date && ymd(i.end_date) < today) {
      const d = daysBetween(i.end_date, today); slip = Math.max(slip, d);
      if (late++ < 3) add(Math.min(20, 8 + d), `“${i.title}” was due to finish ${d} day${d === 1 ? '' : 's'} ago and isn’t done.`);
    } else if (i.start_date && ymd(i.start_date) < today && i.status === 'todo') {
      const d = daysBetween(i.start_date, today); slip = Math.max(slip, Math.min(d, 30));
      if (late++ < 3) add(Math.min(15, 5 + d), `“${i.title}” should have started ${d} day${d === 1 ? '' : 's'} ago.`);
    }
    const soon = i.start_date && daysBetween(today, i.start_date) >= 0 && daysBetween(today, i.start_date) <= 10;
    if (soon && i.confirm_status === 'conflict') add(25, `The sub for “${i.title}” said they can’t make the dates.`, 'bad');
    else if (soon && i.confirm_status === 'sent' && daysBetween(today, i.start_date) <= 3) add(10, `The sub for “${i.title}” hasn’t confirmed, and it starts ${inDays(daysBetween(today, i.start_date))}.`);
    const v = i.vendor_id && vendors[i.vendor_id];
    if (soon && v && v.insurance_expires && ymd(v.insurance_expires) < ymd(i.start_date)) add(10, `${v.name}’s insurance on file expires before “${i.title}” starts.`);
    if (soon && /inspect/i.test(i.title) && daysBetween(today, i.start_date) <= 5) add(5, `“${i.title}” is coming up. Make sure it’s booked with the city.`, 'info');
  }
  for (const p of pos) {
    if (!p.needed_by || !['draft', 'sent'].includes(p.status)) continue;
    const d = daysBetween(today, p.needed_by);
    if (d < 0) add(15, `PO #${p.number} (${p.title}) was needed ${-d} day${d === -1 ? '' : 's'} ago and isn’t received${p.status === 'draft' ? ' (it was never sent)' : ''}.`, 'bad');
    else if (d <= 7) add(p.status === 'draft' ? 12 : 6, `PO #${p.number} (${p.title}) is needed ${inDays(d)}${p.status === 'draft' ? ' and hasn’t been sent to the vendor' : ' and hasn’t arrived'}.`);
  }
  for (const s of selections) {
    if (s.chosen_index != null || !s.due_date) continue;
    const d = daysBetween(today, s.due_date);
    if (d < 0) add(12, `The homeowner was due to choose “${s.category}” ${-d} day${d === -1 ? '' : 's'} ago.`);
    else if (d <= 7) add(6, `The homeowner needs to choose “${s.category}” ${d === 0 ? 'today' : `within ${d} day${d === 1 ? '' : 's'}`}.`, 'info');
  }
  for (const c of cos) {
    if (c.status === 'sent' && c.sent_at && daysBetween(c.sent_at, today) >= 3) add(5, `Change order #${c.number} (${c.title}) has waited ${daysBetween(c.sent_at, today)} days for the homeowner’s OK.`);
  }
  const added = cos.filter(c => c.status === 'approved').reduce((n, c) => n + (c.days_added || 0), 0);
  for (const w of weather.slice(0, 2)) add(8, w.title, 'info');
  const last = items.filter(i => i.end_date).map(i => ymd(i.end_date)).sort().pop() || null;
  let finish = null;
  if (last) { const f = new Date(last + 'T12:00:00Z'); let n = slip; while (n > 0) { f.setUTCDate(f.getUTCDate() + 1); if (![0, 6].includes(f.getUTCDay())) n--; } finish = ymd(f); }
  score = Math.min(100, score);
  return { score, level: score >= 45 ? 'high' : score >= 20 ? 'medium' : 'low', reasons, plannedFinish: last, likelyFinish: finish, slipDays: slip, changeOrderDays: added };
}

async function scheduleRisk(tenantId, dealId, now = new Date()) {
  const items = (await query(`SELECT id, title, start_date, end_date, status, vendor_id, confirm_status FROM crm_job_items WHERE deal_id = $1 ORDER BY position`, [dealId])).rows;
  if (!items.length) return { ready: false, why: 'No schedule on this job yet.' };
  const [pos, selections, cos, weather, vendors] = await Promise.all([
    query(`SELECT number, title, status, needed_by FROM crm_purchase_orders WHERE deal_id = $1`, [dealId]),
    query(`SELECT category, due_date, chosen_index FROM crm_selections WHERE deal_id = $1`, [dealId]),
    query(`SELECT number, title, status, sent_at, days_added FROM crm_change_orders WHERE deal_id = $1`, [dealId]),
    query(`SELECT title FROM crm_inbox WHERE deal_id = $1 AND kind = 'weather' AND status = 'open' ORDER BY created_at DESC LIMIT 2`, [dealId]),
    query(`SELECT id, name, insurance_expires FROM crm_vendors WHERE tenant_id = $1`, [tenantId])
  ]);
  return { ready: true, ...scheduleRiskFrom({ today: todayYmd(now), items, pos: pos.rows, selections: selections.rows, cos: cos.rows, weather: weather.rows, vendors: Object.fromEntries(vendors.rows.map(v => [v.id, v])) }) };
}

async function jobOutlook(tenantId, dealId) {
  const [cost, risk] = await Promise.all([costForecast(tenantId, dealId), scheduleRisk(tenantId, dealId)]);
  await query(`INSERT INTO crm_forecasts (deal_id, tenant_id, cost, risk, at) VALUES ($1, $2, $3, $4, now()) ON CONFLICT (deal_id) DO UPDATE SET cost = $3, risk = $4, at = now()`, [dealId, tenantId, JSON.stringify(cost), JSON.stringify(risk)]);
  return { cost, risk };
}

// Every few hours: each active job's outlook, flagged once when it turns bad.
async function scanJobs({ now = new Date(), limit = 40 } = {}) {
  const jobs = (await query(
    `SELECT d.id, d.tenant_id, d.title FROM crm_deals d JOIN tenants t ON t.id = d.tenant_id LEFT JOIN crm_forecasts f ON f.deal_id = d.id
     WHERE d.stage IN ('signed', 'production') AND 'crm' = ANY(t.products) AND (f.at IS NULL OR f.at < $1::timestamptz - interval '6 hours')
     ORDER BY f.at NULLS FIRST LIMIT $2`, [now, limit])).rows;
  let flagged = 0;
  const week = (() => { const d = new Date(now); const y = d.getUTCFullYear(); const start = Date.UTC(y, 0, 1); return `${y}w${Math.ceil(((d - start) / DAY + new Date(start).getUTCDay() + 1) / 7)}`; })();
  for (const j of jobs) {
    try {
      const { cost, risk } = await jobOutlook(j.tenant_id, j.id);
      if (cost.ready && cost.plannedMargin != null && cost.margin != null && cost.plannedMargin - cost.margin >= 5 && cost.overBudget > 500) {
        const band = Math.floor((cost.plannedMargin - cost.margin) / 5);
        if (await crm.addInboxItem({ tenantId: j.tenant_id, dealId: j.id, kind: 'cost_forecast', dedupeKey: `forecast:${j.id}:${band}`, title: `${j.title} is heading for a ${cost.margin.toFixed(0)}% margin (planned ${cost.plannedMargin.toFixed(0)}%)`, detail: `Likely final cost ${money(cost.eac)} against a budget of ${money(cost.budget)}, from ${cost.method}. Spent ${money(cost.spent)}, committed ${money(cost.committed)}.` })) flagged++;
      }
      if (risk.ready && risk.level === 'high') {
        if (await crm.addInboxItem({ tenantId: j.tenant_id, dealId: j.id, kind: 'schedule_risk', dedupeKey: `schedrisk:${j.id}:${week}`, title: `${j.title}: the finish date is at risk${risk.likelyFinish && risk.likelyFinish !== risk.plannedFinish ? ` (likely ${risk.likelyFinish} instead of ${risk.plannedFinish})` : ''}`, detail: risk.reasons.filter(r => r.level !== 'info').slice(0, 4).map(r => r.text).join(' ') })) flagged++;
      }
    } catch (e) { console.error('[crmForecast] job failed:', e.message); }
  }
  return { checked: jobs.length, flagged };
}

module.exports = { progressOf, forecastCost, costForecast, scheduleRiskFrom, scheduleRisk, jobOutlook, scanJobs };
