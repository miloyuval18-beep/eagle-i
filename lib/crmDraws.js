// Draw schedules in Eagle I CRM: getting paid as the work gets done.
//
// A job's payment milestones, each a share of the contract or "the rest",
// tied to a phase of the schedule or to the job being marked Complete.
// Finishing that phase makes the progress invoice for the current contract
// value (approved change orders included), due in a week. It goes straight to
// the homeowner when the company has switched that on; otherwise it waits in
// Needs you for one tap. A signed job gets the company's standard draws (or
// the built-in remodel ones) laid against its schedule on its own.
const { query } = require('../db');
const crm = require('./crm');

function err(message, status = 400) { const e = new Error(message); e.status = status; return e; }
const clean = (v, n) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, n) : null; };
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cents = (n) => Math.round(Number(n || 0) * 100);
const baseUrlFor = async (tenantId) => require('./appUrl').fixUrl(((await query(`SELECT base_url FROM crm_playbook_sends WHERE tenant_id = $1 AND base_url <> '' ORDER BY due_at DESC LIMIT 1`, [tenantId])).rows[0] || {}).base_url || require('./appUrl').appUrl());

// [title, share of the contract (null = the rest), a word from the phase it follows ('complete' = the job's end)]
const DEFAULT_TEMPLATE = [['Rough-in complete', 30, 'rough-in'], ['Cabinets and countertops in', 30, 'cabinet'], ['Final payment', null, 'complete']];

async function rawSettings(tenantId) {
  const r = (await query('SELECT crm_settings FROM business_profile WHERE tenant_id = $1', [tenantId])).rows[0];
  return (r && r.crm_settings) || {};
}
async function drawSettings(tenantId) {
  const s = await rawSettings(tenantId);
  const tpl = Array.isArray(s.drawTemplate) && s.drawTemplate.length ? s.drawTemplate : DEFAULT_TEMPLATE;
  return { autoSend: !!s.drawsAutoSend, template: tpl, custom: Array.isArray(s.drawTemplate) && !!s.drawTemplate.length };
}
async function saveRaw(tenantId, patch) {
  const cur = await rawSettings(tenantId);
  await query('UPDATE business_profile SET crm_settings = $1 WHERE tenant_id = $2', [JSON.stringify({ ...cur, ...patch }), tenantId]);
}
async function setAutoSend(tenantId, on) { await saveRaw(tenantId, { drawsAutoSend: !!on }); return drawSettings(tenantId); }

async function listDraws(tenantId, dealId) {
  const draws = (await query(
    `SELECT w.*, i.title AS phase_title, i.status AS phase_status, v.number AS invoice_number, v.status AS invoice_status, v.amount AS invoice_amount
     FROM crm_draws w LEFT JOIN crm_job_items i ON i.id = w.trigger_item_id LEFT JOIN crm_invoices v ON v.id = w.invoice_id
     WHERE w.tenant_id = $1 AND w.deal_id = $2 ORDER BY w.position, w.created_at`, [tenantId, dealId])).rows;
  const deal = await crm.getDeal(tenantId, dealId);
  const inv = (await query(`SELECT COALESCE(SUM(amount), 0)::float AS billed, COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0)::float AS paid FROM crm_invoices WHERE deal_id = $1 AND status NOT IN ('void', 'draft')`, [dealId])).rows[0];
  return {
    draws, contract: Number((deal && deal.value) || 0), billed: inv.billed, paid: inv.paid,
    pctTotal: draws.reduce((n, d) => n + Number(d.pct || 0), 0), hasRest: draws.some(d => d.pct == null)
  };
}

async function saveDraw({ tenantId, dealId = null, id = null, body }) {
  const b = body || {};
  const title = clean(b.title, 120);
  if (!title) throw err('Name the payment, like “Rough-in complete”.');
  const rest = !!b.rest;
  const pct = rest ? null : Number(String(b.pct == null ? '' : b.pct).replace(/[%\s]/g, ''));
  if (!rest && !(pct > 0 && pct <= 100)) throw err('Enter a share of the contract between 1 and 100%, or choose “the rest”.');
  let deal = dealId;
  if (id) {
    const cur = (await query('SELECT * FROM crm_draws WHERE id = $1 AND tenant_id = $2', [id, tenantId])).rows[0];
    if (!cur) throw err('Payment not found.', 404);
    if (cur.invoice_id) throw err('This payment is already invoiced. Change the invoice instead.');
    deal = cur.deal_id;
  } else if (!(await query('SELECT 1 FROM crm_deals WHERE id = $1 AND tenant_id = $2', [dealId, tenantId])).rows.length) throw err('Deal not found.', 404);
  const onComplete = b.trigger === 'complete';
  const itemId = !onComplete && b.trigger ? b.trigger : null;
  if (itemId && !(await query('SELECT 1 FROM crm_job_items WHERE id = $1 AND deal_id = $2', [itemId, deal])).rows.length) throw err('That phase isn’t on this job.');
  if (rest && (await query('SELECT 1 FROM crm_draws WHERE deal_id = $1 AND pct IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)', [deal, id])).rows.length) throw err('Only one payment can be “the rest”.');
  if (id) {
    return (await query('UPDATE crm_draws SET title = $3, pct = $4, trigger_item_id = $5, on_complete = $6 WHERE id = $1 AND tenant_id = $2 RETURNING *', [id, tenantId, title, pct, itemId, onComplete])).rows[0];
  }
  const pos = (await query('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM crm_draws WHERE deal_id = $1', [deal])).rows[0].p;
  return (await query('INSERT INTO crm_draws (tenant_id, deal_id, title, pct, trigger_item_id, on_complete, position) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
    [tenantId, deal, title, pct, itemId, onComplete, pos])).rows[0];
}
async function deleteDraw({ tenantId, id }) {
  const r = await query('DELETE FROM crm_draws WHERE id = $1 AND tenant_id = $2 AND invoice_id IS NULL RETURNING id', [id, tenantId]);
  if (!r.rowCount) throw err('Invoiced payments can’t be removed (cancel the invoice instead).', 400);
  return true;
}

// The company's standard draws against this job's schedule (nothing if it already has draws).
async function applyTemplate({ tenantId, dealId }) {
  if ((await query('SELECT 1 FROM crm_draws WHERE deal_id = $1 LIMIT 1', [dealId])).rows.length) return { created: 0 };
  const { template } = await drawSettings(tenantId);
  const items = (await query('SELECT id, title FROM crm_job_items WHERE deal_id = $1 ORDER BY position', [dealId])).rows;
  let n = 0;
  for (const [title, pct, match] of template) {
    const onComplete = match === 'complete';
    const item = !onComplete && match ? items.find(i => i.title.toLowerCase().includes(String(match).toLowerCase())) : null;
    await query('INSERT INTO crm_draws (tenant_id, deal_id, title, pct, trigger_item_id, on_complete, position) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [tenantId, dealId, title, pct, item ? item.id : null, onComplete || (!item && !!match), n]);
    n++;
  }
  return { created: n };
}

// This job's draws become the company's standard (matched to phases by their names).
async function saveTemplateFromJob({ tenantId, dealId }) {
  const draws = (await query(`SELECT w.title, w.pct, w.on_complete, i.title AS phase FROM crm_draws w LEFT JOIN crm_job_items i ON i.id = w.trigger_item_id WHERE w.deal_id = $1 AND w.tenant_id = $2 ORDER BY w.position`, [dealId, tenantId])).rows;
  if (!draws.length) throw err('This job has no payment schedule to save.');
  const tpl = draws.map(d => [d.title, d.pct == null ? null : Number(d.pct), d.on_complete ? 'complete' : d.phase ? d.phase.toLowerCase().slice(0, 60) : null]);
  await saveRaw(tenantId, { drawTemplate: tpl });
  return { draws: tpl.length };
}

// A milestone was reached: make its invoice (and send it, when that's switched on).
async function fire({ tenantId, draw, userId = null, now = new Date(), send }) {
  if ((await query('SELECT invoice_id FROM crm_draws WHERE id = $1', [draw.id])).rows[0]?.invoice_id) return null;
  const deal = await crm.getDeal(tenantId, draw.deal_id);
  if (!deal || deal.stage === 'lost') return null;
  const contract = Number(deal.value || 0);
  let amount;
  if (draw.pct == null) {
    const billed = (await query(`SELECT COALESCE(SUM(amount), 0)::float AS b FROM crm_invoices WHERE deal_id = $1 AND status <> 'void'`, [draw.deal_id])).rows[0].b;
    amount = (cents(contract) - cents(billed)) / 100;
  } else amount = Math.round(contract * Number(draw.pct)) / 100;
  if (!(amount > 0)) {
    await crm.addInboxItem({ tenantId, dealId: draw.deal_id, kind: 'draw_ready', dedupeKey: `draw:${draw.id}`, title: `“${draw.title}” on ${deal.title} came up with nothing to bill`, detail: contract ? 'Everything on the contract is already invoiced.' : 'The deal has no contract value. Add it, then invoice this payment by hand.' });
    return null;
  }
  const pay = require('./crmPayments');
  const due = new Date(now.getTime() + 7 * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const inv = await pay.createInvoice({ tenantId, dealId: draw.deal_id, kind: draw.pct == null ? 'final' : 'progress', title: draw.title, amount, dueDate: due, userId });
  // Claim the milestone; if the same phase was saved twice at once, only one invoice stands.
  if (!(await query('UPDATE crm_draws SET invoice_id = $2 WHERE id = $1 AND invoice_id IS NULL RETURNING id', [draw.id, inv.id])).rows.length) {
    await query(`UPDATE crm_invoices SET status = 'void' WHERE id = $1`, [inv.id]);
    return null;
  }
  const { autoSend } = await drawSettings(tenantId);
  if (autoSend && deal.contact_email) {
    try {
      await pay.sendInvoice({ tenantId, id: inv.id, userId, baseUrl: await baseUrlFor(tenantId), ...(send ? { send } : {}) });
      await crm.logActivity({ tenantId, dealId: draw.deal_id, kind: 'system', actor: 'eagle_i', body: `Sent invoice #${inv.number} for “${draw.title}” (${money(amount)}) on its own.` });
      return { invoice: inv, sent: true };
    } catch (e) { console.error('[crmDraws] auto-send failed:', e.message); }
  }
  await crm.addInboxItem({ tenantId, dealId: draw.deal_id, kind: 'draw_ready', dedupeKey: `draw:${draw.id}`, title: `Invoice ready: ${draw.title} on ${deal.title} (${money(amount)})`, detail: 'The milestone was reached. Open the deal and send invoice #' + inv.number + '.' });
  return { invoice: inv, sent: false };
}

async function onItemDone({ tenantId, itemId, userId = null }) {
  const draws = (await query('SELECT * FROM crm_draws WHERE tenant_id = $1 AND trigger_item_id = $2 AND invoice_id IS NULL', [tenantId, itemId])).rows;
  const out = [];
  for (const d of draws) out.push(await fire({ tenantId, draw: d, userId }));
  return out.filter(Boolean);
}
async function onComplete(deal) {
  const draws = (await query('SELECT * FROM crm_draws WHERE deal_id = $1 AND on_complete = true AND invoice_id IS NULL ORDER BY position', [deal.id])).rows;
  const out = [];
  for (const d of draws) out.push(await fire({ tenantId: deal.tenant_id, draw: d }));
  return out.filter(Boolean);
}

module.exports = { DEFAULT_TEMPLATE, drawSettings, setAutoSend, listDraws, saveDraw, deleteDraw, applyTemplate, saveTemplateFromJob, fire, onItemDone, onComplete };
