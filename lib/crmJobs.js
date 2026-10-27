// Running the job in Eagle I CRM: schedule, daily logs, subs and vendors,
// purchase orders, change orders and selections.
//
// What happens on its own:
//  - a signed contract gets a schedule from the company's template (or the
//    built-in remodel one), laid out on working days from the kickoff;
//  - a shared daily log also appears as an update in the homeowner's portal;
//  - a sub's insurance that runs out within 30 days shows up in "Needs you";
//  - a change order the homeowner approves (portal, typed name) updates the
//    job's value, and the team hears about it;
//  - a selection picked over its allowance drafts the change order for the
//    difference and flags it for the team to send.
const { query, pool } = require('../db');
const { sendEmail } = require('./email');
const crm = require('./crm');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = require('./day'); // real days only (not 2026-02-30)
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const text = (v, max) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, max) : null; };
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN; };
const ymd = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
function err(message, status = 400) { const e = new Error(message); e.status = status; return e; }

// ---------- schedule ----------

// Built-in remodel schedule: phase and working days.
const DEFAULT_TEMPLATE = [
  ['Kickoff meeting', 1], ['Permits', 5], ['Demolition', 3], ['Framing', 5], ['Rough plumbing & electrical', 5], ['Rough-in inspection', 1],
  ['Insulation & drywall', 7], ['Cabinets & millwork', 5], ['Countertops', 3], ['Tile & flooring', 5], ['Paint', 4], ['Fixtures & trim', 3],
  ['Punch list', 2], ['Final walkthrough', 1]
];

// Working-day arithmetic (Monday to Friday).
function nextWorkday(d) { const x = new Date(d); while ([0, 6].includes(x.getUTCDay())) x.setUTCDate(x.getUTCDate() + 1); return x; }
function addWorkdays(d, n) { let x = new Date(d); let left = n; while (left > 0) { x.setUTCDate(x.getUTCDate() + 1); if (![0, 6].includes(x.getUTCDay())) left--; } return x; }
function layOut(template, startYmd) {
  let cur = nextWorkday(new Date(startYmd + 'T00:00:00Z'));
  return template.map(([title, days]) => {
    const start = new Date(cur);
    const end = addWorkdays(start, Math.max(1, days) - 1);
    cur = nextWorkday(addWorkdays(end, 1));
    return { title, start: ymd(start), end: ymd(end) };
  });
}

async function templateFor(tenantId) {
  const raw = (await query('SELECT crm_settings FROM business_profile WHERE tenant_id = $1', [tenantId])).rows[0];
  const t = raw && raw.crm_settings && Array.isArray(raw.crm_settings.scheduleTemplate) ? raw.crm_settings.scheduleTemplate : null;
  return t && t.length ? t.filter(x => Array.isArray(x) && x[0]).map(([a, b]) => [String(a).slice(0, 120), Math.min(60, Math.max(1, parseInt(b, 10) || 1))]) : DEFAULT_TEMPLATE;
}

// A signed contract: lay out the schedule once (never over one the team has started).
async function createScheduleFromTemplate({ tenantId, dealId, startDate = null }) {
  if ((await query('SELECT 1 FROM crm_job_items WHERE deal_id = $1 LIMIT 1', [dealId])).rows.length) return { created: 0 };
  const start = startDate && DATE_RE.test(startDate) ? startDate : ymd(new Date(Date.now() + 7 * 86400000));
  const rows = layOut(await templateFor(tenantId), start);
  for (let i = 0; i < rows.length; i++) {
    await query(`INSERT INTO crm_job_items (tenant_id, deal_id, title, start_date, end_date, position) VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, dealId, rows[i].title, rows[i].start, rows[i].end, i]);
  }
  await crm.logActivity({ tenantId, dealId, kind: 'system', actor: 'eagle_i', body: `Laid out the job schedule (${rows.length} phases, ${rows[0].start} to ${rows[rows.length - 1].end}).` });
  return { created: rows.length };
}

async function saveTemplateFromJob({ tenantId, dealId }) {
  const items = (await query('SELECT title, start_date, end_date FROM crm_job_items WHERE deal_id = $1 AND tenant_id = $2 ORDER BY position', [dealId, tenantId])).rows;
  if (!items.length) throw err('This job has no schedule to save.');
  const tpl = items.map(i => {
    let days = 1;
    if (i.start_date && i.end_date) { let d = new Date(ymd(i.start_date) + 'T00:00:00Z'); const e = new Date(ymd(i.end_date) + 'T00:00:00Z'); days = 0; while (d <= e) { if (![0, 6].includes(d.getUTCDay())) days++; d.setUTCDate(d.getUTCDate() + 1); } }
    return [i.title, Math.max(1, days)];
  });
  const cur = (await query('SELECT crm_settings FROM business_profile WHERE tenant_id = $1', [tenantId])).rows[0];
  const next = { ...((cur && cur.crm_settings) || {}), scheduleTemplate: tpl };
  await query('UPDATE business_profile SET crm_settings = $1 WHERE tenant_id = $2', [JSON.stringify(next), tenantId]);
  return { phases: tpl.length };
}

async function listSchedule(tenantId, dealId) {
  return (await query(
    `SELECT i.*, COALESCE(u.name, u.email) AS assignee_name, v.name AS vendor_name FROM crm_job_items i
     LEFT JOIN users u ON u.id = i.assignee_user_id LEFT JOIN crm_vendors v ON v.id = i.vendor_id
     WHERE i.tenant_id = $1 AND i.deal_id = $2 ORDER BY i.position, i.start_date`, [tenantId, dealId])).rows;
}

async function saveItem({ tenantId, dealId, id = null, body, userId = null }) {
  const b = body || {};
  const title = text(b.title, 120);
  if (!title) throw err('Name the phase.');
  const start = DATE_RE.test(String(b.startDate || '')) ? b.startDate : null;
  const end = DATE_RE.test(String(b.endDate || '')) ? b.endDate : start;
  if (start && end && end < start) throw err('The end date is before the start date.');
  const status = ['todo', 'doing', 'done'].includes(b.status) ? b.status : 'todo';
  const vendor = b.vendorId ? (await query('SELECT id FROM crm_vendors WHERE id = $1 AND tenant_id = $2', [b.vendorId, tenantId])).rows[0] : null;
  const assignee = b.assigneeUserId ? (await query('SELECT id FROM users WHERE id = $1 AND tenant_id = $2', [b.assigneeUserId, tenantId])).rows[0] : null;
  if (id) {
    const before = (await query('SELECT * FROM crm_job_items WHERE id = $1 AND tenant_id = $2', [id, tenantId])).rows[0];
    if (!before) throw err('Phase not found.', 404);
    const r = (await query(
      `UPDATE crm_job_items SET title = $3, start_date = $4, end_date = $5, status = $6, vendor_id = $7, assignee_user_id = $8, show_homeowner = $9 WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, title, start, end, status, vendor ? vendor.id : null, assignee ? assignee.id : null, b.showHomeowner !== false])).rows[0];
    // New dates or a different sub: they're asked to confirm again (lib/crmSubs.js).
    await require('./crmSubs').resetIfMoved(before, r);
    // A sub with an Eagle I account hears about new dates, if the company turned that on.
    require('./crmAccountFeatures').onPhaseMoved({ before, after: r }).catch(() => {});
    if (before.status !== 'done' && status === 'done') {
      await crm.logActivity({ tenantId, dealId: before.deal_id, kind: 'system', userId, body: `Finished: ${title}` });
      await maybeAllDone(tenantId, before.deal_id);
      // A payment milestone tied to this phase is due now (lib/crmDraws.js).
      await require('./crmDraws').onItemDone({ tenantId, itemId: id, userId }).catch(e => console.error('[crmJobs] draw failed:', e.message));
    }
    return r;
  }
  const pos = (await query('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM crm_job_items WHERE deal_id = $1', [dealId])).rows[0].p;
  return (await query(
    `INSERT INTO crm_job_items (tenant_id, deal_id, title, start_date, end_date, status, vendor_id, assignee_user_id, show_homeowner, position)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [tenantId, dealId, title, start, end, status, vendor ? vendor.id : null, assignee ? assignee.id : null, b.showHomeowner !== false, pos])).rows[0];
}

// Everything on the schedule is done: suggest closing the job out.
async function maybeAllDone(tenantId, dealId) {
  const left = (await query(`SELECT COUNT(*)::int AS n FROM crm_job_items WHERE deal_id = $1 AND status <> 'done'`, [dealId])).rows[0].n;
  const deal = await crm.getDeal(tenantId, dealId);
  if (!left && deal && deal.stage !== 'complete') {
    await crm.addInboxItem({ tenantId, dealId, kind: 'job_done', dedupeKey: `alldone:${dealId}`, title: `Every phase of “${deal.title}” is done`, detail: 'Move it to Complete when the homeowner has signed off: their thank-you and check-in emails start then.' });
  }
}

async function deleteItem({ tenantId, id }) {
  return (await query('DELETE FROM crm_job_items WHERE id = $1 AND tenant_id = $2 RETURNING id', [id, tenantId])).rowCount > 0;
}

// ---------- daily logs ----------

async function addLog({ tenantId, dealId, body, crew = null, logDate = null, shared = false, userId = null }) {
  const b = text(body, 5000);
  if (!b) throw err('Write what happened on site.');
  const deal = await crm.getDeal(tenantId, dealId);
  if (!deal) throw err('Deal not found.', 404);
  const date = DATE_RE.test(String(logDate || '')) ? logDate : new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const log = (await query(
    `INSERT INTO crm_daily_logs (tenant_id, deal_id, log_date, body, crew, shared, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [tenantId, dealId, date, b, text(crew, 300), !!shared, userId])).rows[0];
  await crm.logActivity({ tenantId, dealId, kind: 'system', userId, body: `Daily log (${date}): ${b.slice(0, 200)}` });
  if (shared) {
    // The homeowner sees it as an update in their portal.
    await query('INSERT INTO crm_portal_updates (tenant_id, deal_id, body, created_by) VALUES ($1, $2, $3, $4)', [tenantId, dealId, b, userId]);
  }
  return log;
}

async function listLogs(tenantId, dealId) {
  return (await query(
    `SELECT l.*, COALESCE(u.name, u.email) AS author FROM crm_daily_logs l LEFT JOIN users u ON u.id = l.user_id
     WHERE l.tenant_id = $1 AND l.deal_id = $2 ORDER BY l.log_date DESC, l.created_at DESC LIMIT 200`, [tenantId, dealId])).rows;
}

// ---------- subs & vendors ----------

async function listVendors(tenantId) {
  return (await query('SELECT * FROM crm_vendors WHERE tenant_id = $1 AND archived = false ORDER BY trade NULLS LAST, name', [tenantId])).rows;
}

async function saveVendor({ tenantId, id = null, body }) {
  const b = body || {};
  const name = text(b.name, 160);
  if (!name) throw err('Add the company name.');
  const email = text(b.email, 200);
  if (email && !EMAIL_RE.test(email)) throw err('That email address does not look right.');
  const ins = DATE_RE.test(String(b.insuranceExpires || '')) ? b.insuranceExpires : null;
  const vals = [name, text(b.trade, 80), text(b.contactName, 120), email, text(b.phone, 40), text(b.licenseNo, 60), ins, text(b.notes, 2000)];
  if (id) {
    const r = await query(
      `UPDATE crm_vendors SET name = $3, trade = $4, contact_name = $5, email = $6, phone = $7, license_no = $8, insurance_expires = $9, notes = $10 WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, ...vals]);
    if (!r.rows.length) throw err('Vendor not found.', 404);
    return r.rows[0];
  }
  return (await query(
    `INSERT INTO crm_vendors (tenant_id, name, trade, contact_name, email, phone, license_no, insurance_expires, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [tenantId, ...vals])).rows[0];
}

async function archiveVendor({ tenantId, id }) {
  return (await query('UPDATE crm_vendors SET archived = true WHERE id = $1 AND tenant_id = $2 RETURNING id', [id, tenantId])).rowCount > 0;
}

// Runs on the background tick: insurance running out within 30 days.
async function scanVendorInsurance({ now = new Date() } = {}) {
  const rows = (await query(
    `SELECT v.id, v.tenant_id, v.name, v.insurance_expires FROM crm_vendors v JOIN tenants t ON t.id = v.tenant_id
     WHERE v.archived = false AND v.insurance_expires IS NOT NULL AND v.insurance_expires <= ($1::date + 30) AND 'crm' = ANY(t.products)`, [ymd(now)])).rows;
  let n = 0;
  for (const v of rows) {
    const expired = ymd(v.insurance_expires) < ymd(now);
    if (await crm.addInboxItem({
      tenantId: v.tenant_id, kind: 'vendor_insurance', dedupeKey: `ins:${v.id}:${ymd(v.insurance_expires)}`,
      title: `${v.name}’s insurance ${expired ? 'has expired' : 'expires soon'}`,
      detail: `Certificate on file ${expired ? 'expired' : 'expires'} ${new Date(ymd(v.insurance_expires) + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}. Ask them for a new one before they’re back on site.`
    })) n++;
  }
  return { flagged: n };
}

// ---------- purchase orders ----------

async function nextNumber(client, table, tenantId, start) {
  return (await client.query(`SELECT COALESCE(MAX(number), ${start}) + 1 AS n FROM ${table} WHERE tenant_id = $1`, [tenantId])).rows[0].n;
}

// Inserts a row numbered after the company's last one, retrying if two are made at once.
async function insertNumbered(table, start, build, tenantId) {
  const client = await pool.connect();
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await client.query('BEGIN');
        const row = await build(client, await nextNumber(client, table, tenantId, start));
        await client.query('COMMIT');
        return row;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        if (e.code !== '23505' || attempt === 2) throw e;
      }
    }
  } finally {
    client.release();
  }
}

function cleanLines(lines) {
  return (Array.isArray(lines) ? lines : []).slice(0, 100).map(l => ({
    description: text(l && l.description, 300), quantity: Math.max(0, num(l && l.quantity) || 0) || 1, unit_cost: Math.max(0, num(l && l.unit_cost) || 0)
  })).filter(l => l.description);
}

async function createPO({ tenantId, dealId, vendorId = null, title, lines, category = 'materials', neededBy = null, note = null, userId = null }) {
  if (!(await crm.getDeal(tenantId, dealId))) throw err('Deal not found.', 404);
  const clean = cleanLines(lines);
  if (!clean.length) throw err('Add at least one line.');
  const vendor = vendorId ? (await query('SELECT id FROM crm_vendors WHERE id = $1 AND tenant_id = $2', [vendorId, tenantId])).rows[0] : null;
  const total = Math.round(clean.reduce((n, l) => n + l.quantity * l.unit_cost * 100, 0)) / 100;
  const cat = ['labor', 'materials', 'subcontract', 'equipment', 'other'].includes(category) ? category : 'materials';
  const po = await insertNumbered('crm_purchase_orders', 5000, async (client, number) => (await client.query(
    `INSERT INTO crm_purchase_orders (tenant_id, deal_id, vendor_id, number, title, lines, total, category, needed_by, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [tenantId, dealId, vendor ? vendor.id : null, number, text(title, 160) || 'Purchase order', JSON.stringify(clean), total, cat,
     DATE_RE.test(String(neededBy || '')) ? neededBy : null, text(note, 2000), userId])).rows[0], tenantId);
  await crm.logActivity({ tenantId, dealId, kind: 'system', userId, body: `Purchase order #${po.number}: ${po.title} (${money(total)}).` });
  return po;
}

async function listPOs(tenantId, dealId) {
  return (await query(
    `SELECT p.*, v.name AS vendor_name, v.email AS vendor_email FROM crm_purchase_orders p LEFT JOIN crm_vendors v ON v.id = p.vendor_id
     WHERE p.tenant_id = $1 AND p.deal_id = $2 ORDER BY p.created_at DESC`, [tenantId, dealId])).rows;
}

async function sendPO({ tenantId, id, userId = null, send = sendEmail, baseUrl = require('./appUrl').appUrl() }) {
  const po = (await query(
    `SELECT p.*, v.name AS vendor_name, v.email AS vendor_email, d.title AS deal_title, pr.address AS site FROM crm_purchase_orders p
     LEFT JOIN crm_vendors v ON v.id = p.vendor_id JOIN crm_deals d ON d.id = p.deal_id LEFT JOIN crm_properties pr ON pr.id = d.property_id
     WHERE p.id = $1 AND p.tenant_id = $2`, [id, tenantId])).rows[0];
  if (!po) throw err('Purchase order not found.', 404);
  if (!EMAIL_RE.test(String(po.vendor_email || ''))) throw err('Pick a vendor with an email address first.');
  if (po.status === 'void') throw err('This purchase order was cancelled.');
  const co = (await query(`SELECT t.company_name, bp.phone, bp.email, bp.address FROM tenants t LEFT JOIN business_profile bp ON bp.tenant_id = t.id WHERE t.id = $1`, [tenantId])).rows[0] || {};
  const page = await require('./crmSubPortal').pageLine(tenantId, po.vendor_id, baseUrl);
  const rowsHtml = po.lines.map(l => `<tr><td style="padding:5px 8px;border-bottom:1px solid #e3e7eb">${esc(l.description)}</td><td style="padding:5px 8px;border-bottom:1px solid #e3e7eb;text-align:right">${esc(l.quantity)}</td><td style="padding:5px 8px;border-bottom:1px solid #e3e7eb;text-align:right">${money(l.unit_cost)}</td><td style="padding:5px 8px;border-bottom:1px solid #e3e7eb;text-align:right">${money(l.quantity * l.unit_cost)}</td></tr>`).join('');
  await send({
    to: po.vendor_email, subject: `Purchase order #${po.number} from ${co.company_name}: ${po.title}`.slice(0, 150),
    html: `<div style="font-family:Arial,sans-serif;font-size:16px;color:#14202b;max-width:640px"><p>Hi ${esc(po.vendor_name)},</p><p>Please supply the following for <b>${esc(po.deal_title)}</b>${po.site ? ` at ${esc(po.site)}` : ''}${po.needed_by ? `, needed by <b>${esc(ymd(po.needed_by))}</b>` : ''}.</p>
<table style="border-collapse:collapse;width:100%"><tr><th style="text-align:left;padding:5px 8px">Item</th><th style="text-align:right;padding:5px 8px">Qty</th><th style="text-align:right;padding:5px 8px">Unit</th><th style="text-align:right;padding:5px 8px">Total</th></tr>${rowsHtml}
<tr><td colspan="3" style="padding:8px;text-align:right"><b>Total</b></td><td style="padding:8px;text-align:right"><b>${money(po.total)}</b></td></tr></table>
${po.note ? `<p style="white-space:pre-wrap">${esc(po.note)}</p>` : ''}<p>Please reply to confirm. Thank you,<br>${esc(co.company_name)}${co.phone ? ' · ' + esc(co.phone) : ''}</p>${page.html}</div>`,
    text: `Purchase order #${po.number} from ${co.company_name}: ${po.title}\nJob: ${po.deal_title}${po.site ? ' at ' + po.site : ''}${po.needed_by ? '\nNeeded by ' + ymd(po.needed_by) : ''}\n\n${po.lines.map(l => `${l.description} — ${l.quantity} × ${money(l.unit_cost)} = ${money(l.quantity * l.unit_cost)}`).join('\n')}\n\nTotal: ${money(po.total)}${po.note ? '\n\n' + po.note : ''}\n\nPlease reply to confirm.\n${co.company_name}${page.text}`,
    replyTo: EMAIL_RE.test(String(co.email || '')) ? co.email : undefined, fromName: co.company_name,
    fromAddress: (await require('./sendingDomain').getVerifiedFromAddress(tenantId)) || undefined
  });
  await query(`UPDATE crm_purchase_orders SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END, sent_at = now() WHERE id = $1`, [id]);
  await crm.logActivity({ tenantId, dealId: po.deal_id, kind: 'email', userId, body: `Sent purchase order #${po.number} to ${po.vendor_name}.` });
  return { to: po.vendor_email };
}

async function setPOStatus({ tenantId, id, status, userId = null }) {
  if (!['received', 'void', 'sent'].includes(status)) throw err('Unknown status.');
  const po = (await query('UPDATE crm_purchase_orders SET status = $3 WHERE id = $1 AND tenant_id = $2 RETURNING *', [id, tenantId, status])).rows[0] || null;
  // Received goods are a real cost on the job (job costing), added once.
  if (po && status === 'received') await require('./crmCosts').costFromPO({ tenantId, poId: po.id, userId });
  return po;
}

// ---------- change orders ----------

async function createCO({ tenantId, dealId, title, description = null, amount, cost = 0, daysAdded = 0, selectionId = null, userId = null }) {
  if (!(await crm.getDeal(tenantId, dealId))) throw err('Deal not found.', 404);
  const amt = num(amount);
  if (!Number.isFinite(amt) || Math.abs(amt) > 1e8) throw err('Enter how much the price changes (use a minus sign for a credit).');
  const c = Number.isFinite(num(cost)) ? num(cost) : 0;
  const co = await insertNumbered('crm_change_orders', 100, async (client, number) => (await client.query(
    `INSERT INTO crm_change_orders (tenant_id, deal_id, number, title, description, amount, cost, days_added, selection_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [tenantId, dealId, number, text(title, 160) || 'Change order', text(description, 4000), amt, c, Math.max(0, Math.min(365, parseInt(daysAdded, 10) || 0)), selectionId, userId])).rows[0], tenantId);
  await crm.logActivity({ tenantId, dealId, kind: 'system', userId, actor: userId ? 'owner' : 'eagle_i', body: `Change order #${co.number}: ${co.title} (${amt >= 0 ? '+' : ''}${money(amt)}).` });
  return co;
}

async function listCOs(tenantId, dealId) {
  return (await query('SELECT * FROM crm_change_orders WHERE tenant_id = $1 AND deal_id = $2 ORDER BY number DESC', [tenantId, dealId])).rows;
}

// Ready for the homeowner: shows in their portal (and the portal link is emailed).
async function sendCO({ tenantId, id, userId = null, baseUrl = '', send = sendEmail }) {
  const co = (await query('SELECT * FROM crm_change_orders WHERE id = $1 AND tenant_id = $2', [id, tenantId])).rows[0];
  if (!co) throw err('Change order not found.', 404);
  if (!['draft', 'sent'].includes(co.status)) throw err(`This change order is already ${co.status}.`);
  await query(`UPDATE crm_change_orders SET status = 'sent', sent_at = now() WHERE id = $1`, [id]);
  const deal = await crm.getDeal(tenantId, co.deal_id);
  const link = `${baseUrl}/p/${await require('./crmPortal').portalToken(tenantId, co.deal_id)}`;
  let emailed = false;
  if (EMAIL_RE.test(String(deal.contact_email || ''))) {
    const t = (await query('SELECT company_name FROM tenants WHERE id = $1', [tenantId])).rows[0] || {};
    const { say, langOf } = require('./crmSpanish');
    const lang = langOf(deal.contact_language);
    const first = String(deal.contact_name || '').split(/\s+/)[0] || say(lang, 'there');
    const n = co.days_added || 0;
    const v = { number: co.number, title: co.title, change: say(lang, Number(co.amount) >= 0 ? 'co_adds' : 'co_credits', { amount: money(Math.abs(co.amount)) }), days: n ? say(lang, 'co_days', { n, s: n === 1 ? '' : 's', es: n === 1 ? '' : 'es' }) : '' };
    await send({
      to: deal.contact_email.trim(), subject: say(lang, 'co_subject', v).slice(0, 150),
      html: `<div style="font-family:Arial,sans-serif;font-size:17px;color:#14202b;max-width:560px;line-height:1.5"><p>${esc(say(lang, 'hi', { first }))}</p><p>${esc(say(lang, 'co_intro', v))}</p><p><a href="${link}">${esc(say(lang, 'co_link'))}</a></p><p>${esc(t.company_name)}</p></div>`,
      text: `${say(lang, 'hi', { first })}\n\n${say(lang, 'co_intro', v)}\n\n${say(lang, 'co_link')}: ${link}\n\n${t.company_name}`,
      fromName: t.company_name, fromAddress: (await require('./sendingDomain').getVerifiedFromAddress(tenantId)) || undefined
    }).then(() => { emailed = true; }).catch(e => { if (!/RESEND_API_KEY/.test(e.message)) throw e; });
  }
  await crm.logActivity({ tenantId, dealId: co.deal_id, kind: 'system', userId, body: `Sent change order #${co.number} to the homeowner${emailed ? ' (emailed)' : ''}.` });
  return { emailed, link };
}

async function portalDeal(token) {
  if (!/^[0-9a-f]{48}$/.test(String(token || ''))) return null;
  return (await query(`SELECT d.*, c.name AS contact_name FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id WHERE d.portal_token = $1`, [token])).rows[0] || null;
}

async function tellOwner(deal, subject, body) {
  const r = (await query(`SELECT COALESCE(u.email, bp.email) AS e FROM crm_deals d LEFT JOIN users u ON u.id = d.owner_user_id LEFT JOIN business_profile bp ON bp.tenant_id = d.tenant_id WHERE d.id = $1`, [deal.id])).rows[0];
  if (r && EMAIL_RE.test(String(r.e || ''))) await sendEmail({ to: r.e, subject: subject.slice(0, 150), html: `<p>${esc(body)}</p>`, text: body }).catch(() => {});
}

// The homeowner approves (typed name) or declines in their portal.
async function answerCO({ token, id, approve, name = null, ip = null }) {
  const deal = await portalDeal(token);
  if (!deal) throw err('This link is not valid.', 404);
  const co = (await query(`SELECT * FROM crm_change_orders WHERE id = $1 AND deal_id = $2`, [id, deal.id])).rows[0];
  if (!co) throw err('Change order not found.', 404);
  if (co.status !== 'sent') throw err(co.status === 'approved' ? 'Already approved. Thank you!' : 'This change order isn’t waiting for an answer.');
  if (approve) {
    const nm = text(name, 120);
    if (!nm || nm.length < 3) throw err('Type your full name to approve.');
    const u = await query(`UPDATE crm_change_orders SET status = 'approved', approved_at = now(), approved_name = $2, approved_ip = $3 WHERE id = $1 AND status = 'sent' RETURNING *`, [id, nm, String(ip || '').slice(0, 64)]);
    if (!u.rowCount) throw err('This changed while you were looking at it. Please reload.', 409);
    await query('UPDATE crm_deals SET value = COALESCE(value, 0) + $2, updated_at = now() WHERE id = $1', [deal.id, co.amount]);
    await crm.logActivity({ tenantId: deal.tenant_id, dealId: deal.id, kind: 'system', actor: 'contact', body: `Approved change order #${co.number} (${money(co.amount)}), signed as “${nm}”.` });
    await crm.addInboxItem({ tenantId: deal.tenant_id, dealId: deal.id, kind: 'estimate_accepted', dedupeKey: `co-ok:${co.id}`, title: `${deal.contact_name} approved change order #${co.number}`, detail: `${co.title}: ${money(co.amount)}. Job value updated.` });
    await tellOwner(deal, `Change order approved: ${co.title}`, `${deal.contact_name} approved change order #${co.number} (${co.title}) for ${money(co.amount)}, signed as "${nm}".`);
  } else {
    await query(`UPDATE crm_change_orders SET status = 'declined', declined_at = now() WHERE id = $1 AND status = 'sent'`, [id]);
    await crm.logActivity({ tenantId: deal.tenant_id, dealId: deal.id, kind: 'reply', actor: 'contact', body: `Declined change order #${co.number}: ${co.title}.` });
    await crm.addInboxItem({ tenantId: deal.tenant_id, dealId: deal.id, kind: 'negative_reply', dedupeKey: `co-no:${co.id}`, title: `${deal.contact_name} declined change order #${co.number}`, detail: co.title });
    await tellOwner(deal, `Change order declined: ${co.title}`, `${deal.contact_name} declined change order #${co.number} (${co.title}).`);
  }
}

// ---------- selections ----------

function cleanOptions(options) {
  return (Array.isArray(options) ? options : []).slice(0, 12).map(o => {
    const out = { name: text(o && o.name, 160), price: Math.max(0, num(o && o.price) || 0), note: text(o && o.note, 500) };
    // An option picked from the product catalog (lib/crmProducts.js) keeps its photo.
    if (o && typeof o.product_id === 'string' && /^[0-9a-f-]{36}$/.test(o.product_id)) { out.product_id = o.product_id; out.photo = !!o.photo; }
    return out;
  }).filter(o => o.name);
}

async function saveSelection({ tenantId, dealId, id = null, body }) {
  const b = body || {};
  const category = text(b.category, 120);
  if (!category) throw err('Name what needs choosing, like “Kitchen backsplash tile”.');
  const options = cleanOptions(b.options);
  const allowance = Math.max(0, num(b.allowance) || 0);
  const due = DATE_RE.test(String(b.dueDate || '')) ? b.dueDate : null;
  if (id) {
    const cur = (await query('SELECT * FROM crm_selections WHERE id = $1 AND tenant_id = $2', [id, tenantId])).rows[0];
    if (!cur) throw err('Selection not found.', 404);
    if (cur.chosen_index != null) throw err('The homeowner already chose. Clear their choice first to change the options.');
    return (await query('UPDATE crm_selections SET category = $3, allowance = $4, due_date = $5, options = $6, note = $7 WHERE id = $1 AND tenant_id = $2 RETURNING *',
      [id, tenantId, category, allowance, due, JSON.stringify(options), text(b.note, 1000)])).rows[0];
  }
  if (!(await crm.getDeal(tenantId, dealId))) throw err('Deal not found.', 404);
  return (await query('INSERT INTO crm_selections (tenant_id, deal_id, category, allowance, due_date, options, note) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
    [tenantId, dealId, category, allowance, due, JSON.stringify(options), text(b.note, 1000)])).rows[0];
}

async function listSelections(tenantId, dealId) {
  return (await query('SELECT * FROM crm_selections WHERE tenant_id = $1 AND deal_id = $2 ORDER BY due_date NULLS LAST, created_at', [tenantId, dealId])).rows;
}

async function clearChoice({ tenantId, id }) {
  return (await query('UPDATE crm_selections SET chosen_index = NULL, chosen_at = NULL WHERE id = $1 AND tenant_id = $2 RETURNING id', [id, tenantId])).rowCount > 0;
}

// The homeowner picks an option in their portal. Over the allowance, the
// change order for the difference is drafted for the team to check and send.
async function chooseOption({ token, id, index }) {
  const deal = await portalDeal(token);
  if (!deal) throw err('This link is not valid.', 404);
  const sel = (await query('SELECT * FROM crm_selections WHERE id = $1 AND deal_id = $2', [id, deal.id])).rows[0];
  if (!sel) throw err('Selection not found.', 404);
  if (sel.chosen_index != null) throw err('You already chose. Message your team if you’d like to change it.');
  const i = parseInt(index, 10);
  const opt = sel.options[i];
  if (!opt) throw err('Pick one of the options.');
  await query('UPDATE crm_selections SET chosen_index = $2, chosen_at = now() WHERE id = $1', [id, i]);
  const over = Math.round((Number(opt.price) - Number(sel.allowance)) * 100) / 100;
  await crm.logActivity({ tenantId: deal.tenant_id, dealId: deal.id, kind: 'system', actor: 'contact', body: `Chose ${opt.name} for ${sel.category}${Number(sel.allowance) ? ` (${over > 0 ? `${money(over)} over` : 'within'} the allowance)` : ''}.` });
  if (over > 0 && Number(sel.allowance) > 0) {
    const co = await createCO({ tenantId: deal.tenant_id, dealId: deal.id, title: `${sel.category}: ${opt.name} (over allowance)`, description: `Allowance ${money(sel.allowance)}; chosen ${opt.name} at ${money(opt.price)}.`, amount: over, cost: 0, selectionId: sel.id });
    await crm.addInboxItem({ tenantId: deal.tenant_id, dealId: deal.id, kind: 'reply', dedupeKey: `sel-over:${sel.id}`, title: `${deal.contact_name} chose an upgrade: ${money(over)} over the allowance`, detail: `${sel.category}: ${opt.name}. Change order #${co.number} is drafted: check it and send it for approval.` });
  } else {
    await crm.addInboxItem({ tenantId: deal.tenant_id, dealId: deal.id, kind: 'reply', dedupeKey: `sel:${sel.id}`, title: `${deal.contact_name} chose ${opt.name}`, detail: sel.category });
  }
  return { over: Math.max(0, over) };
}

// What the homeowner's portal shows from the job.
async function portalJob(dealId) {
  const schedule = (await query(`SELECT title, start_date, end_date, status FROM crm_job_items WHERE deal_id = $1 AND show_homeowner = true ORDER BY position`, [dealId])).rows
    .map(i => ({ title: i.title, start: i.start_date ? ymd(i.start_date) : null, end: i.end_date ? ymd(i.end_date) : null, status: i.status }));
  const changeOrders = (await query(`SELECT id, number, title, description, amount, days_added, status, approved_at, approved_name FROM crm_change_orders WHERE deal_id = $1 AND status IN ('sent', 'approved', 'declined') ORDER BY number DESC`, [dealId])).rows
    .map(c => ({ id: c.id, number: c.number, title: c.title, description: c.description, amount: Number(c.amount), daysAdded: c.days_added, status: c.status, approvedAt: c.approved_at, approvedName: c.approved_name }));
  const selections = (await query(`SELECT id, category, allowance, due_date, options, chosen_index, note FROM crm_selections WHERE deal_id = $1 ORDER BY due_date NULLS LAST, created_at`, [dealId])).rows
    .map(s => ({ id: s.id, category: s.category, allowance: Number(s.allowance), due: s.due_date ? ymd(s.due_date) : null, options: s.options, chosen: s.chosen_index, note: s.note }));
  return { schedule, changeOrders, selections };
}

// Active jobs (signed or in production) with how far along they are.
async function listJobs(tenantId) {
  return (await query(
    `SELECT d.id, d.title, d.stage, d.value, c.name AS contact_name, p.address,
            (SELECT COUNT(*)::int FROM crm_job_items i WHERE i.deal_id = d.id) AS phases,
            (SELECT COUNT(*)::int FROM crm_job_items i WHERE i.deal_id = d.id AND i.status = 'done') AS done,
            (SELECT title FROM crm_job_items i WHERE i.deal_id = d.id AND i.status <> 'done' ORDER BY position LIMIT 1) AS current_phase,
            (SELECT MAX(end_date) FROM crm_job_items i WHERE i.deal_id = d.id) AS finish,
            (SELECT COUNT(*)::int FROM crm_change_orders co WHERE co.deal_id = d.id AND co.status = 'sent') AS cos_waiting,
            (SELECT COUNT(*)::int FROM crm_selections s WHERE s.deal_id = d.id AND s.chosen_index IS NULL) AS selections_open
     FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id LEFT JOIN crm_properties p ON p.id = d.property_id
     WHERE d.tenant_id = $1 AND d.stage IN ('signed', 'production') ORDER BY d.stage DESC, d.updated_at DESC`, [tenantId])).rows;
}

module.exports = {
  DEFAULT_TEMPLATE, layOut, addWorkdays, nextWorkday, templateFor, createScheduleFromTemplate, saveTemplateFromJob, listSchedule, saveItem, deleteItem,
  addLog, listLogs, listVendors, saveVendor, archiveVendor, scanVendorInsurance,
  createPO, listPOs, sendPO, setPOStatus, createCO, listCOs, sendCO, answerCO, saveSelection, listSelections, clearChoice, chooseOption, portalJob, listJobs
};
