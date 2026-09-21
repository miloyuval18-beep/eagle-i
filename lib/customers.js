// Past customers: a list the company imports (or builds from leads it won) and
// can email, plus the safeguards that make that acceptable.
//
//  - The company confirms, at import, that these are people it has done
//    business with or who asked to hear from it. The confirmation is stored.
//  - Every email carries the company's address and an unsubscribe link, and
//    honours the same opt-out list as vendor outreach: someone who unsubscribes
//    (or whose address bounces, or who marks it as spam) is never emailed again.
//  - Nothing is sent without the owner reviewing the exact recipients and text
//    and confirming; a daily limit applies to the whole company.
const crypto = require('crypto');
const { query } = require('../db');
const { sendEmail } = require('./email');
const outreach = require('./vendorOutreach');
const tpl = require('./outreachTemplate');
const { leadFirstName } = require('./leadSequence');
const { domainAcceptsMail } = require('./emailVerification');

const MAX_PER_IMPORT = 5000;
const MAX_PER_TENANT = 20000;
const DAILY_CAP = Math.max(1, parseInt(process.env.CUSTOMER_EMAIL_DAILY_CAP, 10) || 200);
const MAX_MESSAGE = 3000;
const SEND_SPACING_MS = 600;
const ATTESTATION = 'I confirm these are people who have done business with my company or who asked to hear from it.';

const CONTROL = /[\u0000-\u001f]/g;
const clean = (s, n) => String(s == null ? '' : s).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const fail = (message, status, code) => { const e = new Error(message); e.status = status; if (code) e.code = code; return e; };

function nameFromEmail(email) {
  const local = email.split('@')[0].replace(/[._-]+/g, ' ').replace(/[0-9]+/g, '').trim();
  return local ? local.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : email;
}

async function importRows(tenantId, rows, { attested, source = 'import' } = {}) {
  if (attested !== true) throw fail('Please confirm these are people you have done business with, or who asked to hear from you.', 400, 'attestation_required');
  if (!Array.isArray(rows) || !rows.length) throw fail('There are no rows to import.', 400);
  if (rows.length > MAX_PER_IMPORT) throw fail(`Import up to ${MAX_PER_IMPORT} people at a time.`, 400);
  const have = (await query('SELECT COUNT(*)::int AS n FROM customers WHERE tenant_id = $1', [tenantId])).rows[0].n;
  const room = MAX_PER_TENANT - have;
  if (room <= 0) throw fail(`Your list is at its limit of ${MAX_PER_TENANT} people.`, 400);

  const seen = new Set();
  const result = { added: 0, duplicates: 0, invalid: 0, overLimit: 0 };
  for (const raw of rows) {
    if (result.added >= room) { result.overLimit++; continue; }
    const email = String(raw && raw.email || '').trim().toLowerCase();
    if (!outreach.EMAIL_RE.test(email) || email.length > 200) { result.invalid++; continue; }
    if (seen.has(email)) { result.duplicates++; continue; }
    seen.add(email);
    const name = clean(raw.name, 120) || nameFromEmail(email);
    const phone = clean(raw.phone, 40) || null;
    const r = await query(
      `INSERT INTO customers (tenant_id, name, email, phone, source) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, lower(email)) DO NOTHING RETURNING id`, [tenantId, name, email, phone, source]);
    if (r.rows.length) result.added++; else result.duplicates++;
  }
  if (result.added) await query('INSERT INTO customer_imports (tenant_id, added, attestation) VALUES ($1, $2, $3)', [tenantId, result.added, source === 'lead' ? 'Leads the company marked as won.' : ATTESTATION]);
  return result;
}

async function importWonLeads(tenantId) {
  const leads = (await query("SELECT name, email, phone FROM leads WHERE tenant_id = $1 AND status = 'won' AND email IS NOT NULL AND email <> ''", [tenantId])).rows;
  if (!leads.length) return { added: 0, duplicates: 0, invalid: 0, found: 0 };
  const r = await importRows(tenantId, leads, { attested: true, source: 'lead' });
  return { ...r, found: leads.length };
}

async function listCustomers(tenantId, { search = '', limit = 50, offset = 0 } = {}) {
  const params = [tenantId];
  let where = 'c.tenant_id = $1';
  if (search && search.trim()) { params.push('%' + search.trim().slice(0, 80) + '%'); where += ` AND (c.name ILIKE $${params.length} OR c.email ILIKE $${params.length})`; }
  params.push(Math.min(200, Math.max(1, limit)), Math.max(0, offset));
  const rows = (await query(
    `SELECT c.id, c.name, c.email, c.phone, c.source, c.created_at,
            (SELECT s.reason FROM outreach_suppressions s WHERE s.tenant_id = c.tenant_id AND LOWER(s.email) = LOWER(c.email) LIMIT 1) AS suppressed,
            (SELECT MAX(e.created_at) FROM customer_emails e WHERE e.tenant_id = c.tenant_id AND LOWER(e.to_email) = LOWER(c.email) AND e.status = 'sent') AS last_emailed,
            COUNT(*) OVER() AS total_count
     FROM customers c WHERE ${where} ORDER BY c.created_at DESC, c.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows;
  const totals = (await query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM outreach_suppressions s WHERE s.tenant_id = c.tenant_id AND LOWER(s.email) = LOWER(c.email)))::int AS opted_out
     FROM customers c WHERE c.tenant_id = $1`, [tenantId])).rows[0];
  return {
    customers: rows.map(r => ({ id: Number(r.id), name: r.name, email: r.email, phone: r.phone, source: r.source, addedAt: r.created_at, suppressed: r.suppressed || null, lastEmailed: r.last_emailed || null })),
    matching: rows[0] ? Number(rows[0].total_count) : 0, total: totals.total, optedOut: totals.opted_out, emailable: totals.total - totals.opted_out
  };
}

async function deleteCustomers(tenantId, { ids, all }) {
  if (all === true) return (await query('DELETE FROM customers WHERE tenant_id = $1', [tenantId])).rowCount;
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 5000);
  if (!list.length) return 0;
  return (await query('DELETE FROM customers WHERE tenant_id = $1 AND id = ANY($2)', [tenantId, list])).rowCount;
}

async function sentInLast24h(tenantId) {
  return (await query("SELECT COUNT(*)::int AS n FROM customer_emails WHERE tenant_id = $1 AND status = 'sent' AND created_at > now() - interval '24 hours'", [tenantId])).rows[0].n;
}

// Who a campaign would and would not reach, and why. ids omitted = everyone.
async function screen(tenantId, ids) {
  const params = [tenantId];
  let where = 'tenant_id = $1';
  if (Array.isArray(ids)) { params.push(ids.map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, MAX_PER_TENANT)); where += ` AND id = ANY($${params.length})`; }
  const rows = (await query(`SELECT id, name, email FROM customers WHERE ${where} ORDER BY id`, params)).rows;
  const supp = new Map((await query('SELECT LOWER(email) AS e, reason FROM outreach_suppressions WHERE tenant_id = $1', [tenantId])).rows.map(x => [x.e, x.reason]));
  const stillOk = [];
  const skipped = [];
  for (const r of rows) {
    const email = r.email.toLowerCase();
    if (!outreach.EMAIL_RE.test(email)) skipped.push({ id: Number(r.id), email, name: r.name, reason: 'invalid_email' });
    else if (supp.has(email)) skipped.push({ id: Number(r.id), email, name: r.name, reason: supp.get(email) === 'unsubscribed' ? 'opted_out' : supp.get(email) });
    else stillOk.push({ id: Number(r.id), email, name: r.name });
  }
  const domains = [...new Set(stillOk.map(c => c.email.split('@')[1]))];
  const dead = new Set();
  await Promise.all(Array.from({ length: Math.min(10, domains.length) }, async () => {
    while (domains.length) { const d = domains.pop(); if ((await domainAcceptsMail(d)) === false) dead.add(d); }
  }));
  const sendable = [];
  for (const c of stillOk) (dead.has(c.email.split('@')[1]) ? skipped.push({ ...c, reason: 'domain_cannot_receive_mail' }) : sendable.push(c));
  return { sendable, skipped };
}

function checkMessage({ subject, message }) {
  const subj = outreach.cleanSubject(subject);
  const text = String(message == null ? '' : message).trim();
  if (!subj) throw fail('Add a subject line.', 400);
  if (!text || text.length > MAX_MESSAGE) throw fail(`The message needs 1 to ${MAX_MESSAGE} characters.`, 400);
  const leftover = (subj + '\n' + text).replace(/\{name\}/g, '').match(/\{[a-z_]+\}/);
  if (leftover) throw fail(`The email still contains ${leftover[0]}. Remove it or fill it in before sending.`, 400, 'unresolved_token');
  return { subject: subj, message: text };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// One batch of at most 25. Re-screens everyone (never trusts the preview), stops at the daily limit.
async function sendBatch({ tenantId, ids, subject, message, baseUrl, campaignId, send = sendEmail, spacingMs = SEND_SPACING_MS }) {
  const checked = checkMessage({ subject, message });
  if (!Array.isArray(ids) || !ids.length || ids.length > 25) throw fail('Send between 1 and 25 people per request.', 400);
  const ctx = await outreach.getSenderContext(tenantId);
  if (!ctx) throw fail('Tenant not found.', 404);
  if ((ctx.profile.address || '').trim().length < 8) throw fail('Add your business address in your Company Profile first; it is required in the footer of commercial email.', 400, 'address_required');

  const { sendable, skipped } = await screen(tenantId, ids);
  const used = await sentInLast24h(tenantId);
  const room = Math.max(0, DAILY_CAP - used);
  const toSend = sendable.slice(0, room);
  const results = [...skipped, ...sendable.slice(room).map(r => ({ ...r, reason: 'daily_cap' }))].map(r => ({ id: r.id, email: r.email, status: 'skipped', reason: r.reason }));
  const campaign = campaignId || crypto.randomUUID();

  for (let i = 0; i < toSend.length; i++) {
    if (i > 0) await sleep(spacingMs);
    const c = toSend[i];
    const body = tpl.fillName(checked.message, leadFirstName(c.name));
    const subj = tpl.fillName(checked.subject, leadFirstName(c.name));
    const emailId = crypto.randomUUID();
    const unsubscribeUrl = outreach.buildUnsubscribeUrl(baseUrl || '', tenantId, c.email);
    const { html, text } = outreach.composeEmail({ message: body, companyName: ctx.companyName, profile: ctx.profile, unsubscribeUrl });
    let sent, err;
    try {
      sent = await send({
        to: c.email, subject: subj, html, text, fromName: ctx.companyName, fromAddress: ctx.fromAddress,
        replyTo: ctx.profile.email && outreach.EMAIL_RE.test(ctx.profile.email) ? ctx.profile.email : undefined,
        headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
      });
    } catch (e) { err = e; }
    await query(
      `INSERT INTO customer_emails (id, tenant_id, customer_id, to_email, name, subject, message, campaign_id, status, error, resend_email_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [emailId, tenantId, c.id, c.email, c.name, subj, body, campaign, err ? 'failed' : 'sent', err ? err.message : null, sent && sent.id ? sent.id : null]);
    results.push({ id: c.id, email: c.email, status: err ? 'failed' : 'sent', error: err ? err.message : undefined });
  }
  return {
    campaignId: campaign, results,
    sent: results.filter(r => r.status === 'sent').length, failed: results.filter(r => r.status === 'failed').length,
    skipped: results.filter(r => r.status === 'skipped').length, remaining: Math.max(0, room - toSend.length)
  };
}

async function sendTest({ tenantId, subject, message, baseUrl, send = sendEmail }) {
  const checked = checkMessage({ subject, message });
  const ctx = await outreach.getSenderContext(tenantId);
  if (!ctx) throw fail('Tenant not found.', 404);
  const account = (await query('SELECT u.email FROM users u WHERE u.tenant_id = $1 ORDER BY u.created_at ASC LIMIT 1', [tenantId])).rows[0];
  const to = [ctx.profile.email, account && account.email].find(e => e && outreach.EMAIL_RE.test(String(e).trim()));
  if (!to) throw fail('Add an email address to your Company Profile first.', 400);
  if ((ctx.profile.address || '').trim().length < 8) throw fail('Add your business address in your Company Profile first; it goes in the footer.', 400, 'address_required');
  const unsubscribeUrl = outreach.buildUnsubscribeUrl(baseUrl || '', tenantId, to);
  const { html, text } = outreach.composeEmail({ message: tpl.fillName(checked.message, 'Alex'), companyName: ctx.companyName, profile: ctx.profile, unsubscribeUrl });
  await send({ to: to.trim(), subject: `[Preview] ${tpl.fillName(checked.subject, 'Alex')}`, html, text, fromName: ctx.companyName, fromAddress: ctx.fromAddress });
  return { to: to.trim() };
}

async function starterTemplates(tenantId) {
  const ctx = await outreach.getSenderContext(tenantId);
  if (!ctx) return [];
  const vars = { company: ctx.companyName, phone: ctx.profile.phone || '', email: ctx.profile.email || '', founder: ctx.profile.founder_name || '' };
  const r = (t) => tpl.renderTemplate(t, vars);
  return [
    { key: 'reactivation', label: 'Checking in with past customers', subject: r('Checking in from {company}'),
      message: r('Hi {name},\n\nIt has been a while since we worked together, and I wanted to check in. How is everything holding up? If anything needs attention, or you are thinking about your next project, we would be glad to help.\n\nJust reply to this email or call {phone}.') },
    { key: 'seasonal', label: 'Seasonal note', subject: r('A quick note from {company}'),
      message: r('Hi {name},\n\nAs the season changes, it is a good time to think about upkeep and any projects you have been putting off. If a walkthrough or a free estimate would help, just reply to this email.\n\nThank you for being one of our customers.') },
    { key: 'referral', label: 'Ask for a referral', subject: r('A small favor from {company}'),
      message: r('Hi {name},\n\nThank you again for choosing {company}. If you know a friend, neighbor or family member planning a project, we would be grateful for an introduction. Just reply with their name and we will take great care of them.') }
  ];
}

module.exports = {
  MAX_PER_IMPORT, MAX_PER_TENANT, DAILY_CAP, MAX_MESSAGE, ATTESTATION,
  importRows, importWonLeads, listCustomers, deleteCustomers, screen, sendBatch, sendTest, starterTemplates, checkMessage, sentInLast24h
};
