// Subs confirming their dates, and the cash-flow forecast, in Eagle I CRM.
//
//  - Sub confirmations: three days before a phase starts, the sub on it gets an
//    email with the job, the address and the dates, and two buttons: "I'll be
//    there" or "Can't make it". "Can't make it" (with their note) lands in
//    Needs you at once; no answer by the day before does too. Moving the dates
//    asks again. Off until the company switches it on (approving the wording).
//  - Cash flow: the next eight weeks, by week: money expected in (invoices sent
//    and not yet paid, by due date; overdue ones up front; milestone payments
//    not yet invoiced, by the end date of their phase) and money going out
//    (purchase orders sent and not yet received, by the date they're needed).
const crypto = require('crypto');
const { query } = require('../db');
const { sendEmail } = require('./email');
const crm = require('./crm');

const TZ = 'America/Chicago';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function err(message, status = 400) { const e = new Error(message); e.status = status; return e; }
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ymd = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
const localDay = (now) => now.toLocaleDateString('en-CA', { timeZone: TZ });
const addDays = (day, n) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const fmtDay = (day) => new Date(ymd(day) + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

async function rawSettings(tenantId) {
  const r = (await query('SELECT crm_settings FROM business_profile WHERE tenant_id = $1', [tenantId])).rows[0];
  return (r && r.crm_settings) || {};
}
async function subConfirmOn(tenantId) { return !!(await rawSettings(tenantId)).subConfirmOn; }
async function setSubConfirm(tenantId, on) {
  const cur = await rawSettings(tenantId);
  await query('UPDATE business_profile SET crm_settings = $1 WHERE tenant_id = $2', [JSON.stringify({ ...cur, subConfirmOn: !!on }), tenantId]);
  return { on: !!on };
}

function composeAsk({ company, phone, vendor, phase, job, address, start, end, link, page = { html: '', text: '' } }) {
  const when = ymd(start) === ymd(end || start) ? fmtDay(start) : `${fmtDay(start)} to ${fmtDay(end)}`;
  const subject = `Please confirm: ${phase} at ${address || job}, ${when}`.slice(0, 150);
  const btn = (href, label, primary) => `<a href="${href}" style="display:inline-block;padding:12px 18px;margin:0 8px 8px 0;border-radius:8px;text-decoration:none;font-weight:bold;${primary ? 'background:#1f4e79;color:#fff' : 'border:1.5px solid #8794a0;color:#14202b'}">${label}</a>`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:17px;color:#14202b;max-width:560px;line-height:1.5"><p>Hi ${esc(vendor)},</p>
<p>${esc(company)} has you down for <b>${esc(phase)}</b> on the ${esc(job)} job:</p>
<p style="margin:0 0 4px"><b>${esc(when)}</b></p><p style="margin:0 0 16px">${esc(address || '')}</p>
<p>${btn(`${link}?a=yes`, 'I’ll be there', true)}${btn(`${link}?a=no`, 'Can’t make it', false)}</p>
<p>Questions? Reply to this email${phone ? ` or call ${esc(phone)}` : ''}.</p><p>${esc(company)}</p>${page.html}</div>`;
  const text = `Hi ${vendor},\n\n${company} has you down for ${phase} on the ${job} job:\n${when}\n${address || ''}\n\nI'll be there: ${link}?a=yes\nCan't make it: ${link}?a=no\n\nQuestions? Reply${phone ? ` or call ${phone}` : ''}.\n\n${company}${page.text}`;
  return { subject, html, text };
}

// Every tick: ask subs whose phases start within three days; flag the silent ones.
async function processConfirmations({ now = new Date(), send = sendEmail, baseUrl = require('./appUrl').appUrl() } = {}) {
  const out = { asked: 0, flagged: 0 };
  const today = localDay(now);
  // Silent the day before: flag it (whenever the tick runs, any time of day).
  const silent = (await query(
    `SELECT i.id, i.title, i.start_date, i.tenant_id, i.deal_id, v.name AS vendor, v.phone FROM crm_job_items i JOIN crm_vendors v ON v.id = i.vendor_id
     WHERE i.confirm_status = 'sent' AND i.start_date <= $1::date AND i.start_date >= $2::date AND i.status = 'todo'`, [addDays(today, 1), today])).rows;
  for (const s of silent) {
    if (await crm.addInboxItem({ tenantId: s.tenant_id, dealId: s.deal_id, kind: 'sub_conflict', dedupeKey: `subsilent:${s.id}:${ymd(s.start_date)}`, title: `${s.vendor} hasn’t confirmed ${s.title} (${fmtDay(s.start_date)})`, detail: s.phone ? `Give them a call: ${s.phone}.` : 'Give them a call.' })) out.flagged++;
  }
  if (!require('./followUps').inSendWindow(now)) return out;
  const due = (await query(
    `SELECT i.*, d.title AS job, v.name AS vendor, v.email AS vendor_email, p.address, t.company_name, bp.phone AS company_phone, bp.email AS company_email
     FROM crm_job_items i JOIN crm_deals d ON d.id = i.deal_id JOIN crm_vendors v ON v.id = i.vendor_id JOIN tenants t ON t.id = i.tenant_id
     JOIN business_profile bp ON bp.tenant_id = i.tenant_id LEFT JOIN crm_properties p ON p.id = d.property_id
     WHERE i.confirm_status IS NULL AND i.status = 'todo' AND i.start_date > $1::date AND i.start_date <= $2::date
       AND d.stage IN ('signed', 'production') AND 'crm' = ANY(t.products) AND (bp.crm_settings->>'subConfirmOn')::boolean = true LIMIT 100`,
    [today, addDays(today, 3)])).rows;
  for (const it of due) {
    if (!EMAIL_RE.test(String(it.vendor_email || '').trim())) continue;
    const token = crypto.randomBytes(24).toString('hex');
    const base = ((await query(`SELECT base_url FROM crm_playbook_sends WHERE tenant_id = $1 AND base_url <> '' ORDER BY due_at DESC LIMIT 1`, [it.tenant_id])).rows[0] || {}).base_url || baseUrl;
    const claimed = (await query(`UPDATE crm_job_items SET confirm_token = $2, confirm_status = 'sent', confirm_sent_at = $3 WHERE id = $1 AND confirm_status IS NULL RETURNING id`, [it.id, token, now])).rows.length;
    if (!claimed) continue;
    try {
      const mail = composeAsk({ company: it.company_name, phone: it.company_phone, vendor: it.vendor, phase: it.title, job: it.job, address: it.address, start: it.start_date, end: it.end_date, link: `${base}/sub/${token}`, page: await require('./crmSubPortal').pageLine(it.tenant_id, it.vendor_id, base) });
      const fromAddress = await require('./sendingDomain').getVerifiedFromAddress(it.tenant_id);
      await send({ to: it.vendor_email.trim(), ...mail, replyTo: EMAIL_RE.test(String(it.company_email || '')) ? it.company_email : undefined, fromName: it.company_name, fromAddress: fromAddress || undefined });
      await crm.logActivity({ tenantId: it.tenant_id, dealId: it.deal_id, kind: 'email', actor: 'eagle_i', body: `Asked ${it.vendor} to confirm ${it.title} (${ymd(it.start_date)}).` });
      out.asked++;
    } catch (e) {
      await query(`UPDATE crm_job_items SET confirm_status = NULL, confirm_token = NULL WHERE id = $1`, [it.id]);
      console.error('[crmSubs] ask failed:', e.message);
    }
  }
  return out;
}

async function itemByToken(token) {
  if (!/^[0-9a-f]{48}$/.test(String(token || ''))) return null;
  return (await query(
    `SELECT i.*, d.title AS job, v.name AS vendor, p.address, t.company_name, bp.phone AS company_phone FROM crm_job_items i JOIN crm_deals d ON d.id = i.deal_id
     JOIN crm_vendors v ON v.id = i.vendor_id JOIN tenants t ON t.id = i.tenant_id LEFT JOIN business_profile bp ON bp.tenant_id = i.tenant_id
     LEFT JOIN crm_properties p ON p.id = d.property_id WHERE i.confirm_token = $1`, [token])).rows[0] || null;
}
async function confirmInfo(token) {
  const it = await itemByToken(token);
  if (!it) return null;
  return { company: it.company_name, companyPhone: it.company_phone, vendor: it.vendor, phase: it.title, job: it.job, address: it.address, start: ymd(it.start_date), end: ymd(it.end_date || it.start_date), status: it.confirm_status, note: it.confirm_note };
}
async function answerConfirm({ token, yes, note }) {
  const it = await itemByToken(token);
  if (!it) throw err('This link is no longer active. The dates may have changed; a new email is on its way.', 404);
  const n = String(note || '').trim().slice(0, 1000) || null;
  const status = yes ? 'confirmed' : 'conflict';
  await query('UPDATE crm_job_items SET confirm_status = $2, confirm_note = COALESCE($3, confirm_note), confirm_answered_at = now() WHERE id = $1', [it.id, status, n]);
  await crm.logActivity({ tenantId: it.tenant_id, dealId: it.deal_id, kind: 'reply', actor: 'eagle_i', body: `${it.vendor} ${yes ? 'confirmed' : 'can’t make'} ${it.title} (${ymd(it.start_date)})${n ? `: “${n}”` : ''}.` });
  if (yes) await crm.resolveInbox(it.tenant_id, `subsilent:${it.id}:${ymd(it.start_date)}`);
  else await crm.addInboxItem({ tenantId: it.tenant_id, dealId: it.deal_id, kind: 'sub_conflict', dedupeKey: `subno:${it.id}:${ymd(it.start_date)}`, title: `${it.vendor} can’t make ${it.title} (${fmtDay(it.start_date)})`, detail: n || 'Find another time or another sub, then move the dates on the schedule.' });
  return { status };
}

// Dates moved: ask again.
async function resetIfMoved(before, after) {
  if (!before.confirm_status) return;
  if (ymd(before.start_date || '') === ymd(after.start_date || '') && ymd(before.end_date || '') === ymd(after.end_date || '') && before.vendor_id === after.vendor_id) return;
  await query(`UPDATE crm_job_items SET confirm_status = NULL, confirm_token = NULL, confirm_note = NULL, confirm_answered_at = NULL WHERE id = $1`, [after.id]);
}

// ---------- cash flow ----------

function weekStart(day) { const d = new Date(ymd(day) + 'T12:00:00Z'); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); return ymd(d); }

async function cashflow(tenantId, { now = new Date(), weeks = 8 } = {}) {
  const today = localDay(now);
  const first = weekStart(today);
  const buckets = Array.from({ length: weeks }, (_, i) => ({ week: addDays(first, i * 7), in: 0, out: 0, items: [] }));
  const last = addDays(first, weeks * 7 - 1);
  const put = (day, side, amount, label) => {
    const b = day < first ? null : buckets.find(x => day >= x.week && day <= addDays(x.week, 6));
    if (!b) return false;
    b[side] += amount; b.items.push({ side, amount, label, day });
    return true;
  };
  let overdue = 0; const overdueItems = [];
  const invs = (await query(`SELECT i.number, i.title, i.amount, i.due_date, d.title AS job FROM crm_invoices i JOIN crm_deals d ON d.id = i.deal_id WHERE i.tenant_id = $1 AND i.status = 'sent'`, [tenantId])).rows;
  for (const v of invs) {
    const day = v.due_date ? ymd(v.due_date) : today;
    const label = `Invoice #${v.number} · ${v.job}`;
    if (day < today) { overdue += Number(v.amount); overdueItems.push({ amount: Number(v.amount), label, day }); } else put(day, 'in', Number(v.amount), label);
  }
  const draws = (await query(
    `SELECT w.title, w.pct, w.on_complete, d.id AS deal_id, d.title AS job, COALESCE(d.value, 0)::float AS contract, i.end_date,
            (SELECT MAX(COALESCE(x.end_date, x.start_date)) FROM crm_job_items x WHERE x.deal_id = d.id) AS job_end
     FROM crm_draws w JOIN crm_deals d ON d.id = w.deal_id LEFT JOIN crm_job_items i ON i.id = w.trigger_item_id
     WHERE w.tenant_id = $1 AND w.invoice_id IS NULL AND d.stage IN ('signed', 'production')`, [tenantId])).rows;
  const billed = new Map((await query(`SELECT deal_id, COALESCE(SUM(amount), 0)::float AS b FROM crm_invoices WHERE tenant_id = $1 AND status <> 'void' GROUP BY deal_id`, [tenantId])).rows.map(r => [r.deal_id, r.b]));
  const pctBy = new Map();
  for (const w of draws) if (w.pct != null) pctBy.set(w.deal_id, (pctBy.get(w.deal_id) || 0) + w.contract * Number(w.pct) / 100);
  for (const w of draws) {
    const when = w.on_complete ? w.job_end : w.end_date;
    if (!when) continue;
    // A milestone is billed a week after it's reached (the invoice's due date).
    const day = addDays(ymd(when) < today ? today : ymd(when), 7);
    const amount = w.pct != null ? Math.round(w.contract * Number(w.pct)) / 100 : Math.max(0, w.contract - (billed.get(w.deal_id) || 0) - (pctBy.get(w.deal_id) || 0));
    if (amount > 0) put(day, 'in', amount, `${w.title} · ${w.job} (expected)`);
  }
  const pos = (await query(`SELECT o.number, o.title, o.total, o.needed_by, v.name AS vendor FROM crm_purchase_orders o LEFT JOIN crm_vendors v ON v.id = o.vendor_id WHERE o.tenant_id = $1 AND o.status = 'sent'`, [tenantId])).rows;
  for (const o of pos) put(o.needed_by ? (ymd(o.needed_by) < today ? today : ymd(o.needed_by)) : today, 'out', Number(o.total), `PO #${o.number} · ${o.vendor || o.title}`);
  return { from: first, to: last, overdue: Math.round(overdue * 100) / 100, overdueItems, weeks: buckets.map(b => ({ ...b, in: Math.round(b.in * 100) / 100, out: Math.round(b.out * 100) / 100 })) };
}

module.exports = { subConfirmOn, setSubConfirm, composeAsk, processConfirmations, confirmInfo, answerConfirm, resetIfMoved, weekStart, cashflow };
