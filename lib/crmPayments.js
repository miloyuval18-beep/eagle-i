// Getting paid in Eagle I CRM: invoices on a deal and online payment through
// the company's own Stripe account (Stripe Connect).
//
// Money goes from the homeowner straight to the company's Stripe account;
// Eagle I never holds it. Eagle I can take a small platform fee per payment
// (CRM_PAYMENT_FEE_BPS, basis points; 0 by default).
//
// What happens on its own:
//  - accepting an estimate that asks for money at signing creates the deposit
//    invoice, and the estimate page offers to pay it right away;
//  - a payment (seen on the homeowner's return from Stripe, or by Stripe's
//    webhook, whichever is first) marks the invoice paid, logs it on the deal,
//    ticks off "Collect the deposit", tells the team and puts it in "Needs you";
//  - approved "invoice due" playbooks remind the homeowner before or after the
//    due date and stop the moment it's paid.
// Without a connected Stripe account, invoices still work: the pay page shows
// how to pay and the team marks checks and cash as paid.
const crypto = require('crypto');
const { query, pool } = require('../db');
const { sendEmail } = require('./email');
const crm = require('./crm');

const KINDS = { deposit: 'Deposit', progress: 'Progress payment', final: 'Final payment', other: 'Invoice' };
const PAID_VIA = ['card', 'bank', 'check', 'cash', 'other'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function err(message, status = 400) { const e = new Error(message); e.status = status; return e; }

// Stripe client; tests swap in a stand-in with setStripe().
let stripeOverride = null;
function setStripe(s) { stripeOverride = s; }
function stripe() {
  if (stripeOverride) return stripeOverride;
  if (!process.env.STRIPE_SECRET_KEY) return null;
  const Stripe = require('stripe');
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}
const feeBps = () => Math.max(0, Math.min(500, parseInt(process.env.CRM_PAYMENT_FEE_BPS || '0', 10) || 0));

// ---------- Stripe Connect ----------

async function connectStatus(tenantId) {
  const t = (await query('SELECT stripe_connect_account_id, stripe_connect_ready FROM tenants WHERE id = $1', [tenantId])).rows[0] || {};
  return { available: !!stripe(), accountId: t.stripe_connect_account_id || null, ready: !!t.stripe_connect_ready };
}

// Starts (or continues) connecting the company's Stripe account. Returns the Stripe page to send the owner to.
async function connectLink({ tenantId, email, baseUrl }) {
  const s = stripe();
  if (!s) throw err('Online payments are not set up on the Eagle I server yet.', 503);
  let { accountId } = await connectStatus(tenantId);
  if (!accountId) {
    const t = (await query(`SELECT t.company_name, bp.site FROM tenants t LEFT JOIN business_profile bp ON bp.tenant_id = t.id WHERE t.id = $1`, [tenantId])).rows[0] || {};
    const acct = await s.accounts.create({
      type: 'express', country: 'US', email: email || undefined,
      business_profile: { name: t.company_name || undefined, mcc: '1520', url: t.site ? (/^https?:/.test(t.site) ? t.site : 'https://' + t.site) : undefined },
      capabilities: { card_payments: { requested: true }, transfers: { requested: true }, us_bank_account_ach_payments: { requested: true } },
      metadata: { eagle_i_tenant: tenantId }
    });
    accountId = acct.id;
    await query('UPDATE tenants SET stripe_connect_account_id = $2, stripe_connect_ready = false WHERE id = $1', [tenantId, accountId]);
  }
  const link = await s.accountLinks.create({ account: accountId, type: 'account_onboarding', refresh_url: `${baseUrl}/crm#company`, return_url: `${baseUrl}/crm?stripe=return#company` });
  return { url: link.url };
}

// Asks Stripe whether the account can take payments yet.
async function refreshConnect(tenantId) {
  const s = stripe();
  const { accountId } = await connectStatus(tenantId);
  if (!s || !accountId) return connectStatus(tenantId);
  const acct = await s.accounts.retrieve(accountId);
  await query('UPDATE tenants SET stripe_connect_ready = $2 WHERE id = $1', [tenantId, !!acct.charges_enabled]);
  return connectStatus(tenantId);
}

// ---------- invoices ----------

async function nextNumber(client, tenantId) {
  return (await client.query('SELECT COALESCE(MAX(number), 2000) + 1 AS n FROM crm_invoices WHERE tenant_id = $1', [tenantId])).rows[0].n;
}

async function createInvoice({ tenantId, dealId, kind = 'progress', title, amount, dueDate = null, note = null, estimateId = null, userId = null }) {
  const deal = await crm.getDeal(tenantId, dealId);
  if (!deal) throw err('Deal not found.', 404);
  const amt = Math.round(Number(String(amount == null ? '' : amount).replace(/[$,\s]/g, '')) * 100) / 100;
  if (!(amt > 0) || amt > 1e8) throw err('Enter the amount to invoice.');
  const k = KINDS[kind] ? kind : 'other';
  const due = require('./day').test(String(dueDate || '')) ? dueDate : null;
  const client = await pool.connect();
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await client.query('BEGIN');
        const number = await nextNumber(client, tenantId);
        const inv = (await client.query(
          `INSERT INTO crm_invoices (tenant_id, deal_id, estimate_id, number, kind, title, note, amount, due_date, public_token, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
          [tenantId, dealId, estimateId, number, k, String(title || '').trim().slice(0, 160) || `${KINDS[k]} — ${deal.title}`,
           String(note || '').trim().slice(0, 2000) || null, amt, due, crypto.randomBytes(24).toString('hex'), userId])).rows[0];
        await client.query('COMMIT');
        await crm.logActivity({ tenantId, dealId, kind: 'system', userId, actor: userId ? 'owner' : 'eagle_i', body: `Created invoice #${inv.number}: ${inv.title} (${money(amt)}).` });
        return inv;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        if (e.code === '23505' && /deposit_once/.test(e.constraint || '')) return null; // this estimate already has its deposit invoice
        if (e.code !== '23505' || attempt === 2) throw e;
      }
    }
  } finally {
    client.release();
  }
}

// An estimate was accepted: if it asks for money at signing, make that invoice (once).
async function depositForEstimate(estimateId) {
  const e = (await query('SELECT * FROM crm_estimates WHERE id = $1', [estimateId])).rows[0];
  if (!e || e.status !== 'accepted' || !(Number(e.deposit_pct) > 0)) return null;
  const amount = Math.round(Number(e.total) * Number(e.deposit_pct)) / 100;
  if (!(amount > 0)) return null;
  const inv = await createInvoice({
    tenantId: e.tenant_id, dealId: e.deal_id, kind: 'deposit', estimateId: e.id, amount,
    title: `${e.kind === 'design_agreement' ? 'Design agreement' : 'Deposit'} — ${e.title}`,
    dueDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
  });
  if (!inv) return (await query(`SELECT * FROM crm_invoices WHERE estimate_id = $1 AND kind = 'deposit'`, [e.id])).rows[0] || null;
  // It's ready to pay straight away from the estimate page, so it counts as sent.
  await query(`UPDATE crm_invoices SET status = 'sent', sent_at = now() WHERE id = $1`, [inv.id]);
  return (await query('SELECT * FROM crm_invoices WHERE id = $1', [inv.id])).rows[0];
}

async function listInvoices(tenantId, { dealId = null } = {}) {
  return (await query(
    `SELECT i.*, d.title AS deal_title, c.name AS contact_name FROM crm_invoices i JOIN crm_deals d ON d.id = i.deal_id JOIN crm_contacts c ON c.id = d.contact_id
     WHERE i.tenant_id = $1 AND ($2::uuid IS NULL OR i.deal_id = $2::uuid) ORDER BY i.created_at DESC LIMIT 500`, [tenantId, dealId])).rows
    .map(i => ({ ...i, overdue: i.status === 'sent' && i.due_date && new Date(String(i.due_date instanceof Date ? i.due_date.toISOString() : i.due_date).slice(0, 10) + 'T23:59:59Z') < new Date() }));
}

async function getInvoice(tenantId, id) {
  return (await query('SELECT * FROM crm_invoices WHERE id = $1 AND tenant_id = $2', [id, tenantId])).rows[0] || null;
}

async function sendInvoice({ tenantId, id, userId = null, baseUrl = '', send = sendEmail }) {
  const inv = await getInvoice(tenantId, id);
  if (!inv) throw err('Invoice not found.', 404);
  if (inv.status === 'paid' || inv.status === 'void') throw err(`This invoice is ${inv.status === 'paid' ? 'already paid' : 'cancelled'}.`);
  const deal = await crm.getDeal(tenantId, inv.deal_id);
  const to = String(deal.contact_email || '').trim();
  if (!EMAIL_RE.test(to)) throw err('This contact has no email address. Add one on the deal first.');
  const blocked = (await query(`SELECT 1 FROM outreach_suppressions WHERE tenant_id = $1 AND LOWER(email) = LOWER($2) AND reason IN ('bounced', 'complained')`, [tenantId, to])).rows[0];
  if (blocked) throw err('Email to this person bounced or was reported, so it can’t be sent by email.');
  const co = (await query(`SELECT t.company_name, bp.address, bp.email, bp.phone FROM tenants t LEFT JOIN business_profile bp ON bp.tenant_id = t.id WHERE t.id = $1`, [tenantId])).rows[0] || {};
  co.company_name = await require('./crmSubsidiaries').brandName(tenantId, inv.deal_id, co.company_name); // the project's company in the group
  const link = `${baseUrl}/i/${inv.public_token}`;
  const { say, langOf, dateIn } = require('./crmSpanish');
  const lang = langOf(deal.contact_language);
  const first = String(deal.contact_name || '').trim().split(/\s+/)[0] || say(lang, 'there');
  const due = inv.due_date ? dateIn(lang, String(inv.due_date instanceof Date ? inv.due_date.toISOString() : inv.due_date).slice(0, 10) + 'T12:00:00Z', { month: 'long', day: 'numeric', timeZone: 'UTC' }) : null;
  const v = { number: inv.number, company: co.company_name, amount: money(inv.amount), title: inv.title, due: due ? say(lang, 'inv_due', { date: due }) : '' };
  const ask = say(lang, 'questions', { phone: co.phone ? say(lang, 'or_call', { phone: co.phone }) : '' });
  await send({
    to, subject: say(lang, 'inv_subject', v).slice(0, 150),
    html: `<div style="font-family:Arial,sans-serif;font-size:17px;color:#14202b;max-width:560px;line-height:1.5"><p>${esc(say(lang, 'hi', { first }))}</p><p>${esc(say(lang, 'inv_intro', v))}</p>${inv.note ? `<p style="white-space:pre-wrap">${esc(inv.note)}</p>` : ''}<p style="margin:22px 0"><a href="${link}" style="background:#1f4e79;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:bold">${esc(say(lang, 'inv_button'))}</a></p><p>${esc(ask)}</p><p style="color:#55636f;font-size:14px">${esc(co.company_name)}${co.address ? ' · ' + esc(co.address) : ''}</p></div>`,
    text: `${say(lang, 'hi', { first })}\n\n${say(lang, 'inv_intro', v)}\n${inv.note ? '\n' + inv.note + '\n' : ''}\n${say(lang, 'inv_button')}: ${link}\n\n${ask}\n\n${co.company_name}${co.address ? ' · ' + co.address : ''}`,
    replyTo: EMAIL_RE.test(String(co.email || '')) ? co.email : undefined, fromName: co.company_name,
    fromAddress: (await require('./sendingDomain').getVerifiedFromAddress(tenantId)) || undefined
  });
  await query(`UPDATE crm_invoices SET status = 'sent', sent_at = now(), sent_to = $2, updated_at = now() WHERE id = $1`, [id, to]);
  await crm.logActivity({ tenantId, dealId: inv.deal_id, kind: 'email', userId, body: `Sent invoice #${inv.number} (${money(inv.amount)}) to ${to}.` });
  await scheduleReminders({ ...inv, status: 'sent' }, baseUrl);
  return { to, link };
}

// What a payment sets in motion.
async function recordPayment({ invoice, amount, via, sessionId = null, paymentIntent = null, userId = null }) {
  const upd = await query(
    `UPDATE crm_invoices SET status = 'paid', paid_at = now(), paid_amount = $2, paid_via = $3, stripe_session_id = COALESCE($4, stripe_session_id),
       stripe_payment_intent = COALESCE($5, stripe_payment_intent), updated_at = now() WHERE id = $1 AND status <> 'paid' RETURNING *`,
    [invoice.id, amount, PAID_VIA.includes(via) ? via : 'other', sessionId, paymentIntent]);
  if (!upd.rowCount) return null; // already recorded (the webhook and the return can both arrive)
  const inv = upd.rows[0];
  await require('./crmPlaybooks').cancelForInvoice(inv.id, 'paid');
  const viaLabel = { card: 'card', bank: 'bank transfer', check: 'check', cash: 'cash', other: 'payment' }[inv.paid_via];
  await crm.logActivity({ tenantId: inv.tenant_id, dealId: inv.deal_id, kind: 'system', actor: userId ? 'owner' : 'contact', userId, body: `Paid invoice #${inv.number}: ${money(amount)} by ${viaLabel}.` });
  if (inv.kind === 'deposit') {
    await query(`UPDATE crm_tasks SET done_at = COALESCE(done_at, now()) WHERE tenant_id = $1 AND auto_key = $2`, [inv.tenant_id, `${inv.deal_id}:deposit`]);
  }
  if (!userId) {
    const deal = await crm.getDeal(inv.tenant_id, inv.deal_id);
    await crm.addInboxItem({ tenantId: inv.tenant_id, dealId: inv.deal_id, kind: 'payment', dedupeKey: `paid:${inv.id}`, title: `${deal.contact_name} paid ${money(amount)}`, detail: `Invoice #${inv.number}: ${inv.title}` });
    const owner = (await query(
      `SELECT COALESCE(u.email, bp.email) AS e FROM crm_deals d LEFT JOIN users u ON u.id = d.owner_user_id LEFT JOIN business_profile bp ON bp.tenant_id = d.tenant_id WHERE d.id = $1`, [inv.deal_id])).rows[0];
    if (owner && EMAIL_RE.test(String(owner.e || ''))) {
      await sendEmail({ to: owner.e, subject: `Payment received: ${money(amount)} from ${deal.contact_name}`, html: `<p>${esc(deal.contact_name)} paid invoice #${inv.number} (${esc(inv.title)}): <b>${money(amount)}</b> by ${viaLabel}.</p>`, text: `${deal.contact_name} paid invoice #${inv.number} (${inv.title}): ${money(amount)} by ${viaLabel}.` }).catch(() => {});
    }
  }
  return inv;
}

async function markPaid({ tenantId, id, via = 'check', amount = null, userId }) {
  const inv = await getInvoice(tenantId, id);
  if (!inv) throw err('Invoice not found.', 404);
  if (inv.status === 'paid') throw err('This invoice is already paid.');
  if (inv.status === 'void') throw err('This invoice was cancelled.');
  const amt = amount == null || amount === '' ? Number(inv.amount) : Math.round(Number(String(amount).replace(/[$,\s]/g, '')) * 100) / 100;
  if (!(amt > 0)) throw err('Enter the amount received.');
  return recordPayment({ invoice: inv, amount: amt, via, userId });
}

async function voidInvoice({ tenantId, id, userId }) {
  const inv = await getInvoice(tenantId, id);
  if (!inv) throw err('Invoice not found.', 404);
  if (inv.status === 'paid') throw err('A paid invoice can’t be cancelled.');
  await query(`UPDATE crm_invoices SET status = 'void', updated_at = now() WHERE id = $1`, [id]);
  await require('./crmPlaybooks').cancelForInvoice(id, 'void');
  await crm.logActivity({ tenantId, dealId: inv.deal_id, kind: 'system', userId, body: `Cancelled invoice #${inv.number}.` });
}

// ---------- the homeowner's pay page ----------

async function byToken(token) {
  if (!/^[0-9a-f]{48}$/.test(String(token || ''))) return null;
  return (await query(
    `SELECT i.*, d.title AS deal_title, c.name AS contact_name, c.email AS contact_email, c.language AS contact_language FROM crm_invoices i JOIN crm_deals d ON d.id = i.deal_id
     JOIN crm_contacts c ON c.id = d.contact_id WHERE i.public_token = $1 AND i.status <> 'draft'`, [token])).rows[0] || null;
}

async function publicInvoice(token) {
  const inv = await byToken(token);
  if (!inv) return null;
  const co = (await query(`SELECT t.company_name, t.stripe_connect_ready, bp.address, bp.phone, bp.email FROM tenants t LEFT JOIN business_profile bp ON bp.tenant_id = t.id WHERE t.id = $1`, [inv.tenant_id])).rows[0] || {};
  co.company_name = await require('./crmSubsidiaries').brandName(inv.tenant_id, inv.deal_id, co.company_name);
  return {
    number: inv.number, kind: KINDS[inv.kind], kindKey: inv.kind, title: inv.title, note: inv.note, amount: Number(inv.amount), dueDate: inv.due_date,
    status: inv.status, paidAt: inv.paid_at, paidAmount: inv.paid_amount == null ? null : Number(inv.paid_amount), customer: inv.contact_name, project: inv.deal_title,
    company: { name: co.company_name, address: co.address, phone: co.phone, email: co.email },
    payOnline: !!(co.stripe_connect_ready && stripe()),
    lang: inv.contact_language || null
  };
}

// Starts a Stripe Checkout payment on the company's own account.
async function checkout({ token, baseUrl }) {
  const inv = await byToken(token);
  if (!inv) throw err('This invoice link is not valid.', 404);
  if (inv.status !== 'sent') throw err(inv.status === 'paid' ? 'This invoice is already paid. Thank you!' : 'This invoice can’t be paid online.');
  const t = (await query('SELECT stripe_connect_account_id, stripe_connect_ready FROM tenants WHERE id = $1', [inv.tenant_id])).rows[0];
  const s = stripe();
  if (!s || !t || !t.stripe_connect_ready || !t.stripe_connect_account_id) throw err('Online payment isn’t available for this invoice. Please use the payment details shown.', 400);
  const cents = Math.round(Number(inv.amount) * 100);
  const fee = Math.floor(cents * feeBps() / 10000);
  const session = await s.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card', 'us_bank_account'],
    customer_email: EMAIL_RE.test(String(inv.contact_email || '')) ? inv.contact_email : undefined,
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: cents, product_data: { name: `Invoice #${inv.number}: ${inv.title}`.slice(0, 250) } } }],
    payment_intent_data: { ...(fee ? { application_fee_amount: fee } : {}), metadata: { eagle_i_invoice: inv.id } },
    metadata: { eagle_i_invoice: inv.id },
    success_url: `${baseUrl}/i/${token}?session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/i/${token}`
  }, { stripeAccount: t.stripe_connect_account_id });
  await query('UPDATE crm_invoices SET stripe_session_id = $2 WHERE id = $1', [inv.id, session.id]);
  return { url: session.url };
}

// The homeowner came back from Stripe: check with Stripe (never trust the URL alone).
async function confirmReturn({ token, sessionId }) {
  const inv = await byToken(token);
  if (!inv || !sessionId || inv.status === 'paid') return publicInvoice(token);
  const t = (await query('SELECT stripe_connect_account_id FROM tenants WHERE id = $1', [inv.tenant_id])).rows[0];
  const s = stripe();
  if (!s || !t || !t.stripe_connect_account_id) return publicInvoice(token);
  const session = await s.checkout.sessions.retrieve(String(sessionId), { stripeAccount: t.stripe_connect_account_id });
  if (session && session.metadata && session.metadata.eagle_i_invoice === inv.id && session.payment_status === 'paid') {
    const via = (session.payment_method_types || []).includes('us_bank_account') && !(session.payment_method_types || []).includes('card') ? 'bank' : 'card';
    await recordPayment({ invoice: inv, amount: session.amount_total / 100, via, sessionId: session.id, paymentIntent: session.payment_intent });
  }
  return publicInvoice(token);
}

// Stripe's webhook for connected accounts (checkout.session.completed /
// async_payment_succeeded, which is how bank transfers finish a few days later).
async function handleConnectEvent(event) {
  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) return { handled: false };
  const session = event.data && event.data.object;
  const id = session && session.metadata && session.metadata.eagle_i_invoice;
  if (!id || session.payment_status !== 'paid') return { handled: false };
  const inv = (await query('SELECT * FROM crm_invoices WHERE id = $1', [id])).rows[0];
  const t = inv && (await query('SELECT stripe_connect_account_id FROM tenants WHERE id = $1', [inv.tenant_id])).rows[0];
  if (!inv || !t || t.stripe_connect_account_id !== event.account) return { handled: false }; // only the company's own account can mark its invoice paid
  const via = session.payment_method_types && session.payment_method_types.length === 1 && session.payment_method_types[0] === 'us_bank_account' ? 'bank' : 'card';
  await recordPayment({ invoice: inv, amount: session.amount_total / 100, via, sessionId: session.id, paymentIntent: session.payment_intent });
  return { handled: true };
}

// "Invoice due" playbooks for a sent invoice: replace any queued reminders.
async function scheduleReminders(inv, baseUrl = '') {
  return require('./crmPlaybooks').scheduleInvoiceReminders(inv, baseUrl);
}

module.exports = {
  KINDS, PAID_VIA, setStripe, connectStatus, connectLink, refreshConnect,
  createInvoice, depositForEstimate, listInvoices, getInvoice, sendInvoice, recordPayment, markPaid, voidInvoice,
  publicInvoice, checkout, confirmReturn, handleConnectEvent, byToken
};
