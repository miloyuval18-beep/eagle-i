// What homeowner and sub accounts get beyond their list of projects or builders.
//
// Always on:
//  - waitingFor: a homeowner's "Waiting for you" list across every builder:
//    estimates to sign, change orders to approve, selections to choose and
//    invoices to pay, each linking to the page the builder already shares.
//
// Each company switches these on for itself (Company details → Homeowners and
// subs; all off until then):
//  - invites:   "Invite to Eagle I" on a deal (homeowner) or a sub.
//  - notices:   an email to people who have an account when something new
//               shows up that wasn't already emailed to them (an update posted
//               on their project; a sub's dates moved).
//  - insurance: subs upload their insurance certificate from their account;
//               the builder sees it on the sub, with the date it runs out.
const { query } = require('../db');
const { sendEmail } = require('./email');

const FEATURES = {
  invites: { label: '“Invite to Eagle I” buttons', help: 'On a deal and on a sub: email them an invitation to make their own free Eagle I account, where everything you share with them is in one place.' },
  notices: { label: 'Emails to people with an account', help: 'When you post an update on a project, or move a sub’s dates, people who have an Eagle I account get a short email pointing to it (only things that weren’t already emailed to them).' },
  insurance: { label: 'Subs upload their insurance certificate', help: 'Subs with an Eagle I account can upload their certificate; you see it on the sub with the date it runs out, and get a note in Today.' }
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ymd = (d) => (d instanceof Date ? d.toISOString() : String(d || '')).slice(0, 10);
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
function err(message, status = 400) { const e = new Error(message); e.status = status; return e; }

// ---------- the company's switches ----------

async function features(tenantId) {
  const r = (await query('SELECT crm_settings FROM business_profile WHERE tenant_id = $1', [tenantId])).rows[0];
  const a = (r && r.crm_settings && r.crm_settings.accounts) || {};
  return Object.fromEntries(Object.keys(FEATURES).map(k => [k, a[k] === true]));
}
async function setFeatures(tenantId, patch, actor = null) {
  const cur = await features(tenantId);
  const next = { ...cur };
  for (const k of Object.keys(FEATURES)) if (typeof (patch || {})[k] === 'boolean') next[k] = patch[k];
  await query(`UPDATE business_profile SET crm_settings = COALESCE(crm_settings, '{}'::jsonb) || jsonb_build_object('accounts', $2::jsonb) WHERE tenant_id = $1`, [tenantId, JSON.stringify(next)]);
  const changed = Object.keys(FEATURES).filter(k => next[k] !== cur[k]);
  if (changed.length) await require('./crmAudit').log({ tenantId, actor, action: 'settings', detail: changed.map(k => `${FEATURES[k].label}: ${next[k] ? 'on' : 'off'}`).join('; ') });
  return next;
}

// ---------- "Waiting for you" (homeowners) ----------

// deals: [{ id, url, builder, title }] from crmAccounts.projectsFor.
async function waitingFor(deals) {
  if (!deals.length) return [];
  const ids = deals.map(d => d.id);
  const byId = new Map(deals.map(d => [d.id, d]));
  const out = [];
  const est = (await query(`SELECT e.deal_id, e.number, e.kind, e.title, e.total, e.public_token, e.valid_until, e.sent_at FROM crm_estimates e WHERE e.deal_id = ANY($1::uuid[]) AND e.status = 'sent' AND e.sent_at IS NOT NULL ORDER BY e.sent_at`, [ids])).rows;
  for (const e of est) {
    const d = byId.get(e.deal_id);
    out.push({ kind: 'estimate', builder: d.builder, project: d.title, title: `${e.kind === 'design_agreement' ? 'Design agreement' : 'Estimate'} #${e.number}${e.title ? ': ' + e.title : ''}`,
      detail: `${money(e.total)}${e.valid_until ? ` · good until ${new Date(ymd(e.valid_until) + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}`,
      due: e.valid_until ? ymd(e.valid_until) : null, url: `/e/${e.public_token}`, action: 'Read and sign' });
  }
  const cos = (await query(`SELECT deal_id, number, title, amount FROM crm_change_orders WHERE deal_id = ANY($1::uuid[]) AND status = 'sent' ORDER BY sent_at`, [ids])).rows;
  for (const c of cos) {
    const d = byId.get(c.deal_id);
    out.push({ kind: 'change_order', builder: d.builder, project: d.title, title: `Change order #${c.number}: ${c.title}`,
      detail: `${Number(c.amount) < 0 ? 'Credit of ' + money(-c.amount) : 'Adds ' + money(c.amount)}`, due: null, url: d.url, action: 'Approve or decline' });
  }
  const sels = (await query(`SELECT deal_id, category, due_date FROM crm_selections WHERE deal_id = ANY($1::uuid[]) AND chosen_index IS NULL AND jsonb_array_length(COALESCE(options, '[]'::jsonb)) > 0 ORDER BY due_date NULLS LAST`, [ids])).rows;
  for (const s of sels) {
    const d = byId.get(s.deal_id);
    out.push({ kind: 'selection', builder: d.builder, project: d.title, title: `Choose: ${s.category}`,
      detail: s.due_date ? `By ${new Date(ymd(s.due_date) + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}` : 'When you’re ready', due: s.due_date ? ymd(s.due_date) : null, url: d.url, action: 'Choose' });
  }
  const inv = (await query(`SELECT deal_id, number, title, amount, due_date, public_token FROM crm_invoices WHERE deal_id = ANY($1::uuid[]) AND status = 'sent' ORDER BY due_date NULLS LAST`, [ids])).rows;
  for (const i of inv) {
    const d = byId.get(i.deal_id);
    const late = i.due_date && ymd(i.due_date) < new Date().toISOString().slice(0, 10);
    out.push({ kind: 'invoice', builder: d.builder, project: d.title, title: `Invoice #${i.number}: ${i.title}`,
      detail: `${money(i.amount)}${i.due_date ? (late ? ' · was due ' : ' · due ') + new Date(ymd(i.due_date) + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}`,
      due: i.due_date ? ymd(i.due_date) : null, late: !!late, url: `/i/${i.public_token}`, action: 'See and pay' });
  }
  // Late or soonest first; things with no date after.
  return out.sort((a, b) => (b.late === true) - (a.late === true) || (a.due || '9999') .localeCompare(b.due || '9999'));
}

// ---------- invitations to make an account ----------

async function accountFor(email, kind) {
  if (!EMAIL_RE.test(String(email || ''))) return null;
  return (await query('SELECT id, email_verified, created_at FROM crm_accounts WHERE lower(email) = lower($1) AND kind = $2', [email, kind])).rows[0] || null;
}
async function inviteStatus({ tenantId, dealId = null, vendorId = null }) {
  const f = await features(tenantId);
  const who = dealId
    ? (await query('SELECT c.email, c.name FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id WHERE d.id = $1 AND d.tenant_id = $2', [dealId, tenantId])).rows[0]
    : (await query('SELECT email, COALESCE(contact_name, name) AS name FROM crm_vendors WHERE id = $1 AND tenant_id = $2', [vendorId, tenantId])).rows[0];
  if (!who) throw err('Not found.', 404);
  const a = await accountFor(who.email, dealId ? 'homeowner' : 'sub');
  return { on: f.invites, email: who.email || null, name: who.name, hasAccount: !!(a && a.email_verified), started: !!(a && !a.email_verified) };
}
async function sendInvite({ tenantId, dealId = null, vendorId = null, actor, baseUrl = '', send = sendEmail }) {
  const st = await inviteStatus({ tenantId, dealId, vendorId });
  if (!st.on) throw err('Switch on “Invite to Eagle I” in Company details first.');
  if (!EMAIL_RE.test(String(st.email || ''))) throw err(`There’s no email address for ${st.name || 'them'}. Add one first.`);
  if (st.hasAccount) throw err(`${st.name || 'They'} already ${st.name ? 'has' : 'have'} an Eagle I account.`);
  const kind = dealId ? 'homeowner' : 'sub';
  const co = (await query('SELECT t.company_name, bp.email, bp.phone FROM tenants t LEFT JOIN business_profile bp ON bp.tenant_id = t.id WHERE t.id = $1', [tenantId])).rows[0] || {};
  const link = `${baseUrl}/crm/login?type=${kind}&email=${encodeURIComponent(st.email)}#signup`;
  const what = kind === 'homeowner' ? 'your project: updates, visits, estimates, invoices, photos and messages' : 'every job you do with us: dates, plans, bid requests and messages';
  try { await send({ to: st.email, subject: `${co.company_name} invited you to Eagle I`, fromName: co.company_name, replyTo: EMAIL_RE.test(String(co.email || '')) ? co.email : undefined,
    html: `<p style="font-size:18px">Hi${st.name ? ' ' + esc(String(st.name).split(' ')[0]) : ''},</p><p style="font-size:18px">${esc(co.company_name)} uses Eagle I to keep ${what} in one place. Make your free account with this email address and it’s all there${kind === 'sub' ? ', together with any other builders you work with who use Eagle I' : ''}.</p><p><a href="${link}" style="display:inline-block;background:#1f4e79;color:#fff;padding:14px 22px;border-radius:8px;font-size:18px;font-weight:700;text-decoration:none">Make my free account</a></p><p style="font-size:15px;color:#55636f">No account needed: the links ${esc(co.company_name)} sends you keep working either way.${co.phone ? ` Questions? Call ${esc(co.phone)}.` : ''}</p>`,
    text: `${co.company_name} uses Eagle I to keep ${what} in one place. Make your free account: ${link}` }); }
  catch (e) { console.warn('[crmAccountFeatures] invite not sent:', e.message); throw err('The invitation couldn’t be sent right now. Try again in a few minutes.', 503); }
  await require('./crmAudit').log({ tenantId, actor, action: 'settings', detail: `Invited ${st.name || st.email} to make an Eagle I ${kind} account` });
  return { sent: true, to: st.email };
}

// ---------- emails to people who have an account ----------

// Sent only if the company switched it on, the person has a confirmed account,
// and the same thing wasn't sent in the last 12 hours.
async function notify({ tenantId, email, kind, key, subject, line, baseUrl = '', send = sendEmail }) {
  try {
    if (!(await features(tenantId)).notices) return false;
    const a = await accountFor(email, kind);
    if (!a || !a.email_verified) return false;
    if ((await query(`SELECT 1 FROM crm_account_notices WHERE account_id = $1 AND key = $2 AND created_at > now() - interval '12 hours'`, [a.id, key])).rows.length) return false;
    await query('INSERT INTO crm_account_notices (account_id, tenant_id, key) VALUES ($1, $2, $3)', [a.id, tenantId, key]);
    const co = (await query('SELECT t.company_name, bp.email FROM tenants t LEFT JOIN business_profile bp ON bp.tenant_id = t.id WHERE t.id = $1', [tenantId])).rows[0] || {};
    const url = `${baseUrl || require('./appUrl').appUrl()}/crm/home`;
    await send({ to: email, subject, fromName: co.company_name, replyTo: EMAIL_RE.test(String(co.email || '')) ? co.email : undefined,
      html: `<p style="font-size:18px">${esc(line)}</p><p><a href="${url}" style="display:inline-block;background:#1f4e79;color:#fff;padding:14px 22px;border-radius:8px;font-size:18px;font-weight:700;text-decoration:none">Open my Eagle I</a></p><p style="font-size:14px;color:#55636f">You get these because you have an Eagle I account and ${esc(co.company_name)} turned them on.</p>`,
      text: `${line}\n\nOpen your Eagle I: ${url}` });
    return true;
  } catch (e) { console.warn('[crmAccountFeatures] notice not sent:', e.message); return false; }
}
// An update posted on a project and not emailed by the builder.
async function onUpdatePosted({ tenantId, dealId, baseUrl = '' }) {
  const d = (await query('SELECT d.title, c.email, t.company_name FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id JOIN tenants t ON t.id = d.tenant_id WHERE d.id = $1 AND d.tenant_id = $2', [dealId, tenantId])).rows[0];
  if (!d || !d.email) return false;
  return notify({ tenantId, email: d.email, kind: 'homeowner', key: `update:${dealId}`, subject: `New update on ${d.title} from ${d.company_name}`, line: `${d.company_name} posted a new update on ${d.title}.`, baseUrl });
}
// A sub's phase moved to new dates.
async function onPhaseMoved({ before, after, baseUrl = '' }) {
  if (!after || !after.vendor_id || after.status === 'done') return false;
  const moved = ymd(before && before.start_date) !== ymd(after.start_date) || ymd(before && before.end_date) !== ymd(after.end_date) || (before && before.vendor_id) !== after.vendor_id;
  if (!moved || !after.start_date) return false;
  const v = (await query('SELECT v.email, d.title AS job, t.company_name FROM crm_vendors v JOIN crm_deals d ON d.id = $2 JOIN tenants t ON t.id = v.tenant_id WHERE v.id = $1', [after.vendor_id, after.deal_id])).rows[0];
  if (!v || !v.email) return false;
  const day = (x) => new Date(ymd(x) + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return notify({ tenantId: after.tenant_id, email: v.email, kind: 'sub', key: `phase:${after.id}:${ymd(after.start_date)}`, subject: `${v.company_name}: ${after.title} on ${v.job} is now ${day(after.start_date)}`,
    line: `${v.company_name} set ${after.title} on ${v.job} for ${day(after.start_date)}${after.end_date && ymd(after.end_date) !== ymd(after.start_date) ? ` to ${day(after.end_date)}` : ''}.` });
}

// ---------- a sub's insurance certificate ----------

const OK_TYPES = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic' };
const sniff = (buf) => buf.slice(0, 4).toString() === '%PDF' ? 'application/pdf' : buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : buf.slice(1, 4).toString() === 'PNG' ? 'image/png' : buf.slice(4, 12).toString().includes('ftyp') ? 'image/heic' : null;
// The builders (with insurance switched on) that this sub works with.
async function insuranceBuilders(account) {
  return (await query(
    `SELECT v.id AS vendor_id, v.tenant_id, v.name, t.company_name FROM crm_vendors v JOIN tenants t ON t.id = v.tenant_id JOIN business_profile bp ON bp.tenant_id = v.tenant_id
     WHERE NOT v.archived AND (bp.crm_settings->'accounts'->>'insurance')::boolean = true
       AND (($2::boolean AND lower(v.email) = lower($1)) OR v.id IN (SELECT vendor_id FROM crm_account_links WHERE account_id = $3 AND vendor_id IS NOT NULL))`,
    [account.email, account.email_verified, account.id])).rows;
}
async function uploadInsurance({ accountId, filename, dataBase64, expires }) {
  const a = (await query('SELECT * FROM crm_accounts WHERE id = $1', [accountId])).rows[0];
  if (!a || a.kind !== 'sub') throw err('Only a sub’s account can upload insurance.', 403);
  const builders = await insuranceBuilders(a);
  if (!builders.length) throw err('None of your builders asked for certificates through Eagle I yet.');
  const buf = Buffer.from(String(dataBase64 || ''), 'base64');
  if (!buf.length) throw err('Pick the certificate file.');
  if (buf.length > 8 * 1024 * 1024) throw err('That file is over 8 MB. Take a smaller photo, or save it as a PDF.');
  const type = sniff(buf);
  if (!type) throw err('Upload a PDF or a photo (JPG, PNG or HEIC).');
  const day = expires && require('./day').test(expires) ? expires : null;
  if (!day) throw err('Pick the date the insurance runs out (it’s on the certificate).');
  if (day < new Date().toISOString().slice(0, 10)) throw err('That date has already passed. Upload your current certificate.');
  const name = String(filename || 'certificate').replace(/[^\w .()-]+/g, '_').slice(0, 120) || 'certificate';
  const f = (await query('INSERT INTO crm_account_files (account_id, kind, filename, content_type, data, expires) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [a.id, 'insurance', name, type, buf, day])).rows[0];
  await query(`UPDATE crm_accounts SET insurance_expires = $2 WHERE id = $1`, [a.id, day]);
  const crm = require('./crm');
  const nice = new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  for (const b of builders) {
    await query('UPDATE crm_vendors SET insurance_expires = $2 WHERE id = $1 AND (insurance_expires IS NULL OR insurance_expires < $2::date)', [b.vendor_id, day]);
    await crm.addInboxItem({ tenantId: b.tenant_id, kind: 'insurance', title: `${b.name} uploaded a new insurance certificate`, detail: `It runs out ${nice}. Open the sub in Jobs to see it.`, dedupeKey: `ins-upload:${f.id}:${b.vendor_id}` }).catch(() => {});
  }
  return { id: f.id, expires: day, builders: builders.map(b => b.company_name) };
}
// The newest certificate a sub uploaded, for a builder who has insurance switched on.
async function certificateFor({ tenantId, vendorId }) {
  if (!(await features(tenantId)).insurance) return null;
  const v = (await query('SELECT id, email FROM crm_vendors WHERE id = $1 AND tenant_id = $2', [vendorId, tenantId])).rows[0];
  if (!v) return null;
  return (await query(
    `SELECT f.id, f.filename, f.content_type, f.expires, f.created_at FROM crm_account_files f JOIN crm_accounts a ON a.id = f.account_id
     WHERE f.kind = 'insurance' AND a.kind = 'sub' AND ((a.email_verified AND lower(a.email) = lower($1)) OR a.id IN (SELECT account_id FROM crm_account_links WHERE vendor_id = $2))
     ORDER BY f.created_at DESC LIMIT 1`, [v.email || '', v.id])).rows[0] || null;
}
async function certificateFile({ tenantId, vendorId }) {
  const c = await certificateFor({ tenantId, vendorId });
  if (!c) return null;
  return (await query('SELECT filename, content_type, data FROM crm_account_files WHERE id = $1', [c.id])).rows[0];
}

module.exports = { FEATURES, features, setFeatures, waitingFor, inviteStatus, sendInvite, notify, onUpdatePosted, onPhaseMoved, insuranceBuilders, uploadInsurance, certificateFor, certificateFile };
