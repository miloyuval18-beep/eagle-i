// Ordering materials on time in Eagle I CRM.
//
// A purchase order for a job knows the phase it's for (job_item_id), when that phase
// starts (needed_by), the supplier's lead time (lead_days) and so the day it has to go
// out (order_by: the needed-by date less the lead time and two working days to spare).
// Eagle I gets each one ready (lines, prices, vendor, needed-by date) and never sends
// it: two working days before the order-by date it's in Needs you and emailed to the
// person running the job as ready to check and send; on the order-by day (or straight
// away when it's already late) it's flagged again as urgent. A person sends it with
// "Send to vendor". When the phase moves, the dates move with it (and it's flagged
// again if that brings the order-by date closer).
const { query } = require('../db');
const crm = require('./crm');
const { sendEmail } = require('./email');

const TZ = 'America/Chicago';
const SPARE_DAYS = 2;   // working days between delivery and the phase starting
const HEADS_UP = 2;     // working days of warning before the order-by date
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ymd = (d) => d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10);
const localDay = (now) => now.toLocaleDateString('en-CA', { timeZone: TZ });
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nice = (day) => new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

// Pure: working days (Mon to Fri) before or after a day.
function shiftWorkdays(day, n) {
  const d = new Date(day + 'T12:00:00Z');
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  while (left > 0) { d.setUTCDate(d.getUTCDate() + step); if (![0, 6].includes(d.getUTCDay())) left--; }
  return d.toISOString().slice(0, 10);
}

// Pure: a supplier's lead time in working days from what they wrote ("in stock",
// "3 days", "2-3 weeks", "10 business days", "6 wks"), or null when it doesn't say.
function parseLeadDays(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return null;
  if (/in stock|on hand|same day|next day|tomorrow|available now/.test(t)) return 1;
  const m = t.match(/(\d+(?:\.\d+)?)\s*(?:-|to|–)?\s*(\d+(?:\.\d+)?)?\s*(business days?|working days?|days?|weeks?|wks?|months?)/);
  if (!m) return null;
  const n = Number(m[2] || m[1]);
  if (/month/.test(m[3])) return Math.round(n * 21);
  if (/w/.test(m[3])) return Math.round(n * 5);
  if (/business|working/.test(m[3])) return Math.round(n);
  return Math.max(1, Math.round(n * 5 / 7));
}

// Pure: the day an order has to go out to arrive with time to spare.
function orderByFor(neededBy, leadDays) {
  if (!neededBy) return null;
  return shiftWorkdays(ymd(neededBy), -(Math.max(0, leadDays || 0) + SPARE_DAYS));
}

// Times a purchase order against a phase: needed by its start, ordered by lead time.
async function time({ poId, itemId = null, leadDays = null }) {
  const po = (await query(`SELECT * FROM crm_purchase_orders WHERE id = $1`, [poId])).rows[0];
  if (!po) return null;
  const item = itemId || po.job_item_id ? (await query(`SELECT id, start_date FROM crm_job_items WHERE id = $1`, [itemId || po.job_item_id])).rows[0] : null;
  const lead = leadDays != null ? leadDays : po.lead_days;
  const needed = item && item.start_date ? ymd(item.start_date) : (po.needed_by ? ymd(po.needed_by) : null);
  const orderBy = orderByFor(needed, lead);
  // Closer than before: warn again.
  const sooner = po.order_by && orderBy && orderBy < ymd(po.order_by);
  await query(`UPDATE crm_purchase_orders SET job_item_id = COALESCE($2, job_item_id), lead_days = $3, needed_by = $4, order_by = $5,
      ready_flagged_at = CASE WHEN $6 THEN NULL ELSE ready_flagged_at END, due_flagged_at = CASE WHEN $6 THEN NULL ELSE due_flagged_at END WHERE id = $1`,
    [poId, item ? item.id : null, lead, needed, orderBy, !!sooner]);
  return { needed, orderBy };
}

// A phase moved: every unsent order for it moves too.
async function retime(itemId) {
  const pos = (await query(`SELECT id FROM crm_purchase_orders WHERE job_item_id = $1 AND status = 'draft'`, [itemId])).rows;
  for (const p of pos) await time({ poId: p.id });
  return pos.length;
}

// Who hears about an order: the job's project manager, else whoever handles it, else the owners.
async function peopleFor(deal) {
  // The project manager if there is one, else whoever handles the deal, else the owners.
  const ids = [deal.pm_user_id || deal.owner_user_id].filter(Boolean);
  let rows = ids.length ? (await query(`SELECT email, name FROM users WHERE id = ANY($1) AND disabled_at IS NULL AND NOT checkin_excluded`, [ids])).rows : [];
  if (!rows.length) rows = (await query(`SELECT email, name FROM users WHERE tenant_id = $1 AND role IN ('owner', 'admin') AND disabled_at IS NULL AND NOT checkin_excluded`, [deal.tenant_id])).rows;
  const TEST = require('./crmCheckins').TEST_ADDR;
  return rows.filter(r => EMAIL_RE.test(String(r.email || '')) && !TEST.test(r.email));
}

async function processOrdering({ now = new Date(), send = sendEmail, appUrl = require('./appUrl').appUrl(), tenantId = null } = {}) {
  const today = localDay(now);
  const soon = shiftWorkdays(today, HEADS_UP);
  const pos = (await query(
    `SELECT p.*, v.name AS vendor_name, v.email AS vendor_email, i.title AS phase, d.title AS deal_title, d.tenant_id, d.pm_user_id, d.owner_user_id
     FROM crm_purchase_orders p JOIN crm_deals d ON d.id = p.deal_id LEFT JOIN crm_vendors v ON v.id = p.vendor_id LEFT JOIN crm_job_items i ON i.id = p.job_item_id
     WHERE p.status = 'draft' AND p.order_by IS NOT NULL AND p.order_by <= $1::date AND (p.ready_flagged_at IS NULL OR (p.order_by <= $2::date AND p.due_flagged_at IS NULL)) AND ($3::uuid IS NULL OR p.tenant_id = $3) LIMIT 200`, [soon, today, tenantId])).rows;
  const out = { ready: 0, due: 0 };
  for (const p of pos) {
    const orderBy = ymd(p.order_by);
    const urgent = orderBy <= today;
    const col = urgent ? 'due_flagged_at' : 'ready_flagged_at';
    const claim = await query(`UPDATE crm_purchase_orders SET ${urgent ? 'due_flagged_at = now(), ready_flagged_at = COALESCE(ready_flagged_at, now())' : 'ready_flagged_at = now()'} WHERE id = $1 AND ${col} IS NULL RETURNING id`, [p.id]);
    if (!claim.rowCount) continue;
    const late = orderBy < today;
    const what = `PO #${p.number} to ${p.vendor_name || 'a supplier'}: ${p.title} (${money(p.total)})`;
    const when = `${p.phase ? `${p.phase} starts ${nice(ymd(p.needed_by))}` : `needed ${nice(ymd(p.needed_by))}`}${p.lead_days != null ? `; ${p.vendor_name || 'the supplier'} needs about ${p.lead_days} working day${p.lead_days === 1 ? '' : 's'}` : ''}`;
    const title = late ? `Late: order now for ${p.deal_title}` : urgent ? `Order today for ${p.deal_title}` : `Ready to order by ${nice(orderBy)}: ${p.deal_title}`;
    await crm.addInboxItem({ tenantId: p.tenant_id, dealId: p.deal_id, kind: 'order', dedupeKey: `order:${p.id}:${urgent ? 'due' : 'ready'}:${orderBy}`,
      title, detail: `${what}. ${when}. It's ready: check it and tap “Send to vendor” on the job.${late ? ' It may arrive late: check the phase dates too.' : ''}` });
    if (urgent) await crm.resolveInbox(p.tenant_id, `order:${p.id}:ready:${orderBy}`).catch(() => {});
    const link = `${appUrl}/crm/app#job/${p.deal_id}`;
    for (const who of await peopleFor(p)) {
      await send({ to: who.email, subject: `${title}`.slice(0, 150),
        html: `<div style="font-family:Arial,sans-serif;font-size:17px;color:#14202b;max-width:560px;line-height:1.5"><p>${late ? '<b style="color:#c01b1b">This order is late.</b> ' : ''}${esc(what)} is ready to send${urgent ? ' <b>today</b>' : ` by <b>${esc(nice(orderBy))}</b>`}.</p><p>${esc(when)}.</p><p>Nothing goes to the supplier until you send it.</p><p style="margin:22px 0"><a href="${link}" style="background:#163a6b;color:#fff;padding:13px 20px;border-radius:10px;text-decoration:none;font-weight:bold">Check and send it</a></p></div>`,
        text: `${late ? 'LATE: ' : ''}${what} is ready to send${urgent ? ' today' : ` by ${nice(orderBy)}`}.\n${when}.\nNothing goes to the supplier until you send it.\n\n${link}` }).catch(e => console.error('[crmOrdering] email failed:', e.message));
    }
    out[urgent ? 'due' : 'ready']++;
  }
  return out;
}

module.exports = { SPARE_DAYS, shiftWorkdays, parseLeadDays, orderByFor, time, retime, processOrdering };
