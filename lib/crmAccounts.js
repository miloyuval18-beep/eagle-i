// Eagle I CRM accounts, separate from Eagle I marketing logins.
//
// Four ways in, chosen when someone creates an account at /crm/login:
//  - Create a company: a new company with them as its owner, then a guided
//    setup (crm.html) for company details, the team, Google, data and emails.
//  - Join a company: with an invitation, or the company code from the Team
//    screen. A code alone only asks: the owner or an admin lets them in and
//    picks their role and who they report to.
//  - Homeowner / sub: their own account (crm_accounts), not part of any
//    company. Once they confirm their email, every builder who has them on a
//    deal (homeowners) or in their subs list (subs) shows up on their home
//    page, with the private project or sub page each builder already shares.
//    A private link pasted in links that one too.
//
// Staff logins are users with app 'crm' (or 'both' for an owner who used one
// login for marketing and the CRM before they were separated).
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool, query } = require('../db');
const { sendEmail } = require('./email');

const BCRYPT_ROUNDS = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KINDS = ['homeowner', 'sub'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
function err(message, status = 400) { const e = new Error(message); e.status = status; return e; }

function checkBasics({ email, password, name }) {
  const em = clip(email, 200).toLowerCase();
  if (!EMAIL_RE.test(em)) throw err('Enter your email address, like name@example.com.');
  if (!password || String(password).length < 8) throw err('Pick a password of at least 8 characters.');
  const nm = clip(name, 120);
  if (!nm) throw err('Add your name.');
  return { em, nm };
}
const staffByEmail = async (em, db = { query }) => (await db.query(`SELECT id, tenant_id, password_hash FROM users WHERE lower(email) = $1 AND app IN ('crm', 'both')`, [em])).rows[0] || null;

// ---------- company code ----------

function newCode() {
  let s = '';
  for (const b of crypto.randomBytes(8)) s += CODE_CHARS[b % CODE_CHARS.length];
  return s.slice(0, 4) + '-' + s.slice(4);
}
const tidyCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');
async function joinCode(tenantId, { fresh = false } = {}) {
  if (!fresh) {
    const r = (await query('SELECT join_code FROM tenants WHERE id = $1', [tenantId])).rows[0];
    if (r && r.join_code) return r.join_code;
  }
  for (let i = 0; i < 5; i++) {
    const code = newCode();
    const ok = await query('UPDATE tenants SET join_code = $2 WHERE id = $1', [tenantId, code]).then(() => true).catch(e => { if (e.code === '23505') return false; throw e; });
    if (ok) return code;
  }
  throw err('Couldn’t make a code. Try again.', 500);
}
async function companyForCode(code) {
  const c = tidyCode(code);
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c)) return null;
  return (await query(`SELECT id, company_name FROM tenants WHERE join_code = $1 AND 'crm' = ANY(products)`, [c])).rows[0] || null;
}

// ---------- email confirmation ----------

async function sendStaffVerify(userId, baseUrl, send = sendEmail) {
  const token = crypto.randomBytes(32).toString('hex');
  const u = (await query(`UPDATE users SET email_verification_token_hash = $2, email_verification_sent_at = now() WHERE id = $1 RETURNING email`, [userId, hashToken(token)])).rows[0];
  if (!u) return;
  const url = `${baseUrl}/verify-email.html?token=${token}`;
  await send({ to: u.email, subject: 'Confirm your Eagle I CRM email', html: `<p>Welcome to Eagle I CRM! <a href="${url}">Confirm your email address</a> to keep your account secure.</p>`, text: `Welcome to Eagle I CRM! Confirm your email address: ${url}` }).catch(e => console.warn('[crmAccounts] verify email not sent:', e.message));
}
async function sendAccountVerify(accountId, baseUrl, send = sendEmail) {
  const a = (await query('SELECT id, email, kind, name, verify_sent_at FROM crm_accounts WHERE id = $1', [accountId])).rows[0];
  if (!a) throw err('Account not found.', 404);
  if (a.verify_sent_at && Date.now() - new Date(a.verify_sent_at).getTime() < 60000) throw err('We just sent one. Give it a minute, and check your spam folder.', 429);
  const token = crypto.randomBytes(32).toString('hex');
  await query('UPDATE crm_accounts SET verify_token_hash = $2, verify_sent_at = now() WHERE id = $1', [a.id, hashToken(token)]);
  const url = `${baseUrl}/crm/verify?token=${token}`;
  const what = a.kind === 'sub' ? 'the builders you work with' : 'your project';
  let sent = true;
  await send({
    to: a.email, subject: 'Confirm your email for Eagle I',
    html: `<p style="font-size:18px">Hi${a.name ? ' ' + esc(a.name.split(' ')[0]) : ''},</p><p style="font-size:18px">Tap the button to confirm this is your email. Then ${what} will show up in your account.</p><p><a href="${url}" style="display:inline-block;background:#1f4e79;color:#fff;padding:14px 22px;border-radius:8px;font-size:18px;font-weight:700;text-decoration:none">Confirm my email</a></p><p style="font-size:15px;color:#55636f">If you didn’t make an Eagle I account, ignore this email.</p>`,
    text: `Confirm your email for Eagle I: ${url}`
  }).catch(e => { sent = false; console.warn('[crmAccounts] verify email not sent:', e.message); });
  return { sent };
}
async function verifyAccount(token) {
  if (!/^[0-9a-f]{64}$/.test(String(token || ''))) return null;
  return (await query(`UPDATE crm_accounts SET email_verified = true, verify_token_hash = NULL WHERE verify_token_hash = $1 RETURNING id, kind`, [hashToken(token)])).rows[0] || null;
}

// ---------- creating an account ----------

// A new company with this person as its owner.
async function createCompany({ companyName, name, email, password, phone, baseUrl = '' }) {
  const { em, nm } = checkBasics({ email, password, name });
  const company = clip(companyName, 120);
  if (!company) throw err('Add your company’s name.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (await staffByEmail(em, client)) throw err('That email already has an Eagle I CRM account. Sign in instead, or use “Forgot password”.', 409);
    const t = (await client.query(`INSERT INTO tenants (company_name, industry, products) VALUES ($1, 'home_services', '{crm}') RETURNING id`, [company])).rows[0].id;
    await client.query('INSERT INTO business_profile (tenant_id, email, phone, founder_name) VALUES ($1, $2, $3, $4)', [t, em, clip(phone, 40) || null, nm]);
    const user = (await client.query(
      `INSERT INTO users (tenant_id, email, password_hash, name, phone, role, app, terms_accepted_at) VALUES ($1, $2, $3, $4, $5, 'owner', 'crm', now()) RETURNING id, tenant_id`,
      [t, em, await bcrypt.hash(String(password), BCRYPT_ROUNDS), nm, clip(phone, 40) || null])).rows[0];
    await client.query('COMMIT');
    await joinCode(t).catch(() => {});
    sendStaffVerify(user.id, baseUrl).catch(() => {});
    return { kind: 'staff', user };
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}

// Joining with a company code. An open invitation for this email lets them
// straight in; otherwise the owner and admins are asked.
async function requestJoin({ code, name, email, password, note, baseUrl = '' }) {
  const { em, nm } = checkBasics({ email, password, name });
  const t = await companyForCode(code);
  if (!t) throw err('That company code doesn’t match a company. Check it with whoever gave it to you (it looks like ABCD-2345).', 404);
  if (await staffByEmail(em)) throw err('That email already has an Eagle I CRM account. Sign in instead.', 409);
  const hash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
  const inv = (await query(`SELECT id, role, reports_to FROM crm_invites WHERE tenant_id = $1 AND lower(email) = $2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`, [t.id, em])).rows[0];
  if (inv) {
    // The invitation already holds their seat.
    const user = (await query(
      `INSERT INTO users (tenant_id, email, password_hash, name, role, app, reports_to, terms_accepted_at) VALUES ($1, $2, $3, $4, $5, 'crm', (SELECT id FROM users WHERE id = $6 AND tenant_id = $1), now()) RETURNING id, tenant_id`,
      [t.id, em, hash, nm, inv.role, inv.reports_to])).rows[0];
    await query('UPDATE crm_invites SET accepted_at = now() WHERE id = $1', [inv.id]);
    sendStaffVerify(user.id, baseUrl).catch(() => {});
    return { kind: 'staff', user, companyName: t.company_name };
  }
  const r = (await query(
    `INSERT INTO crm_join_requests (tenant_id, email, name, password_hash, note) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, lower(email)) WHERE status = 'pending' DO UPDATE SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash, note = EXCLUDED.note, created_at = now() RETURNING id`,
    [t.id, em, nm, hash, clip(note, 300) || null])).rows[0];
  // Tell the owner and admins: in Today, and by email.
  await require('./crm').addInboxItem({ tenantId: t.id, kind: 'team', title: `${nm} asked to join ${t.company_name}`, detail: `${em}${note ? ` · “${clip(note, 300)}”` : ''}. Let them in, pick their role and who they report to, from Account → Team.`, dedupeKey: `join:${r.id}` }).catch(() => {});
  const bosses = (await query(`SELECT email FROM users WHERE tenant_id = $1 AND role IN ('owner', 'admin')`, [t.id])).rows;
  for (const b of bosses) {
    sendEmail({ to: b.email, subject: `${nm} asked to join ${t.company_name} on Eagle I CRM`,
      html: `<p style="font-size:18px"><b>${esc(nm)}</b> (${esc(em)}) used your company code to ask to join ${esc(t.company_name)} on Eagle I CRM.${note ? `</p><p style="font-size:18px">They wrote: “${esc(clip(note, 300))}”` : ''}</p><p style="font-size:18px"><a href="${baseUrl}/crm#team">Open the Team screen</a> to let them in (and pick their role), or say no. If you don’t know them, say no.</p>`,
      text: `${nm} (${em}) asked to join ${t.company_name} on Eagle I CRM. Let them in or say no: ${baseUrl}/crm#team` }).catch(() => {});
  }
  return { pending: true, companyName: t.company_name };
}

async function listJoinRequests(tenantId) {
  return (await query(`SELECT id, email, name, note, created_at FROM crm_join_requests WHERE tenant_id = $1 AND status = 'pending' ORDER BY created_at`, [tenantId])).rows;
}
async function decideJoin({ tenantId, actor, id, approve, role = 'member', reportsTo = null, baseUrl = '' }) {
  const team = require('./crmTeam');
  const r = (await query(`SELECT * FROM crm_join_requests WHERE id = $1 AND tenant_id = $2 AND status = 'pending'`, [/^[0-9a-f-]{36}$/.test(String(id)) ? id : null, tenantId])).rows[0];
  if (!r) throw err('That request isn’t waiting any more.', 404);
  const company = (await query('SELECT company_name FROM tenants WHERE id = $1', [tenantId])).rows[0].company_name;
  if (!approve) {
    await query(`UPDATE crm_join_requests SET status = 'declined', decided_by = $2, decided_at = now(), password_hash = '' WHERE id = $1`, [r.id, actor.id]);
    await query(`UPDATE crm_inbox SET status = 'done', resolved_at = now() WHERE tenant_id = $1 AND dedupe_key = $2`, [tenantId, `join:${r.id}`]).catch(() => {});
    return { declined: true };
  }
  if (!team.ROLES.includes(role) || role === 'owner') throw err('Pick their role.');
  if (role === 'admin' && !team.isManager(actor.role)) throw err('Only the owner or an admin can let someone in as an admin.', 403);
  if (await staffByEmail(r.email)) throw err('That email already has an Eagle I CRM account.', 409);
  await require('./crmBilling').checkSeat(tenantId);
  const user = (await query(
    `INSERT INTO users (tenant_id, email, password_hash, name, role, app, terms_accepted_at) VALUES ($1, $2, $3, $4, $5, 'crm', now()) RETURNING id`,
    [tenantId, r.email, r.password_hash, r.name, role])).rows[0];
  if (reportsTo) await team.setReportsTo({ tenantId, actor, userId: user.id, reportsTo }).catch(() => {});
  await query(`UPDATE crm_join_requests SET status = 'approved', decided_by = $2, decided_at = now(), password_hash = '' WHERE id = $1`, [r.id, actor.id]);
  await query(`UPDATE crm_inbox SET status = 'done', resolved_at = now() WHERE tenant_id = $1 AND dedupe_key = $2`, [tenantId, `join:${r.id}`]).catch(() => {});
  if (role === 'admin') await require('./crmAlerts').ownerAlert({ tenantId, actorId: actor.id, title: `${r.name} joined as an admin`, detail: 'Admins can change company details, the team, automatic emails and billing.', key: `admin:${user.id}` }).catch(() => {});
  sendEmail({ to: r.email, subject: `You’re in: ${company} on Eagle I CRM`,
    html: `<p style="font-size:18px">Hi ${esc(r.name.split(' ')[0])}, ${esc(actor.name || 'your team')} let you in to ${esc(company)} on Eagle I CRM as ${/^[aeiou]/i.test(team.roleLabel(role)) ? 'an' : 'a'} ${esc(team.roleLabel(role).toLowerCase())}.</p><p style="font-size:18px"><a href="${baseUrl}/crm/login">Sign in</a> with the email and password you picked.</p>`,
    text: `You're in: ${company} on Eagle I CRM. Sign in: ${baseUrl}/crm/login` }).catch(() => {});
  sendStaffVerify(user.id, baseUrl).catch(() => {});
  return { approved: true, userId: user.id };
}

// A homeowner or sub account.
async function createAccount({ kind, name, email, password, phone, businessName, trade, baseUrl = '' }) {
  if (!KINDS.includes(kind)) throw err('Pick homeowner or sub.');
  const { em, nm } = checkBasics({ email, password, name });
  if (kind === 'sub' && !clip(businessName, 160)) throw err('Add your business name (or your own name if you work for yourself).');
  const exists = (await query('SELECT 1 FROM crm_accounts WHERE lower(email) = $1 AND kind = $2', [em, kind])).rows[0];
  if (exists) throw err(`That email already has a ${kind === 'sub' ? 'sub' : 'homeowner'} account. Sign in instead, or use “Forgot password”.`, 409);
  const a = (await query(
    `INSERT INTO crm_accounts (kind, email, password_hash, name, phone, business_name, trade) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, kind`,
    [kind, em, await bcrypt.hash(String(password), BCRYPT_ROUNDS), nm, clip(phone, 40) || null, kind === 'sub' ? clip(businessName, 160) : null, kind === 'sub' ? clip(trade, 80) || null : null])).rows[0];
  const v = await sendAccountVerify(a.id, baseUrl).catch(() => ({ sent: false }));
  return { kind, account: a, emailed: v.sent };
}

// ---------- signing in ----------

// Everyone with this email at /crm/login: a company login, a sub account, a
// homeowner account. With more than one, the person picks ({ choose }).
async function signIn({ email, password, as = null }) {
  const em = clip(email, 200).toLowerCase();
  const pw = String(password || '');
  const found = [];
  const staff = (await query(`SELECT u.id, u.tenant_id, u.password_hash, t.company_name FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE lower(u.email) = $1 AND u.app IN ('crm', 'both')`, [em])).rows[0];
  if (staff) found.push({ as: 'staff', id: staff.id, tenantId: staff.tenant_id, hash: staff.password_hash, label: `${staff.company_name} (your company)` });
  for (const a of (await query('SELECT id, kind, password_hash, business_name FROM crm_accounts WHERE lower(email) = $1 ORDER BY kind DESC', [em])).rows) {
    found.push({ as: a.kind, id: a.id, hash: a.password_hash, label: a.kind === 'sub' ? `${a.business_name || 'My business'} (sub)` : 'My home projects (homeowner)' });
  }
  const ok = [];
  for (const f of found) if (await bcrypt.compare(pw, f.hash)) ok.push(f);
  if (!found.length) await bcrypt.compare(pw, '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidin.');
  if (!ok.length) {
    // Asked to join and still waiting.
    const waiting = (await query(`SELECT r.password_hash, t.company_name FROM crm_join_requests r JOIN tenants t ON t.id = r.tenant_id WHERE lower(r.email) = $1 AND r.status = 'pending' ORDER BY r.created_at DESC`, [em])).rows;
    for (const w of waiting) if (await bcrypt.compare(pw, w.password_hash)) throw err(`Your request to join ${w.company_name} is waiting for the owner or an admin to let you in. You’ll get an email when they do.`, 403);
    const mkt = (await query(`SELECT 1 FROM users WHERE lower(email) = $1 AND app = 'marketing'`, [em])).rows[0];
    throw err(mkt && !found.length ? 'That email has an Eagle I marketing login, which is separate from Eagle I CRM. Create a CRM account, or sign in to marketing at eagle i’s main sign-in page.' : 'That email and password don’t match. Check them, or use “Forgot password”.', 401);
  }
  const pick = as ? ok.find(f => f.as === as) : ok.length === 1 ? ok[0] : null;
  if (!pick) return { choose: ok.map(f => ({ as: f.as, label: f.label })) };
  if (pick.as !== 'staff') await query('UPDATE crm_accounts SET last_login_at = now() WHERE id = $1', [pick.id]);
  return pick;
}

// "Forgot password" for /crm/login: one email with a link for each login this address has.
async function forgot({ email, baseUrl = '' }) {
  const em = clip(email, 200).toLowerCase();
  if (!EMAIL_RE.test(em)) return;
  const links = [];
  const ttl = new Date(Date.now() + 3600000);
  const staff = (await query(`SELECT u.id, t.company_name FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE lower(u.email) = $1 AND u.app IN ('crm', 'both')`, [em])).rows[0];
  if (staff) { const tk = crypto.randomBytes(32).toString('hex'); await query('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)', [staff.id, hashToken(tk), ttl]); links.push([`${staff.company_name} (your company login)`, tk]); }
  for (const a of (await query('SELECT id, kind FROM crm_accounts WHERE lower(email) = $1', [em])).rows) {
    const tk = crypto.randomBytes(32).toString('hex');
    await query('INSERT INTO password_reset_tokens (account_id, token_hash, expires_at) VALUES ($1, $2, $3)', [a.id, hashToken(tk), ttl]);
    links.push([a.kind === 'sub' ? 'Your sub account' : 'Your homeowner account', tk]);
  }
  if (!links.length) return;
  const url = (tk) => `${baseUrl}/reset-password.html?token=${tk}&app=crm`;
  await sendEmail({ to: em, subject: 'Reset your Eagle I CRM password',
    html: `<p style="font-size:18px">Someone asked to reset the password for this email. ${links.length > 1 ? 'Pick the login to reset:' : ''}</p>${links.map(([l, tk]) => `<p style="font-size:18px"><a href="${url(tk)}">Reset the password for ${esc(l)}</a></p>`).join('')}<p style="font-size:15px;color:#55636f">The link${links.length > 1 ? 's work' : ' works'} for 1 hour. If this wasn’t you, ignore this email.</p>`,
    text: links.map(([l, tk]) => `Reset the password for ${l}: ${url(tk)}`).join('\n') + '\n(Links work for 1 hour.)' }).catch(e => console.warn('[crmAccounts] reset email not sent:', e.message));
}

// ---------- a homeowner's or sub's own page ----------

async function getAccount(id) {
  return (await query('SELECT id, kind, email, name, phone, business_name, trade, license, insurance_expires, address, email_verified, setup_done_at, created_at FROM crm_accounts WHERE id = $1', [id])).rows[0] || null;
}
const ymd = (d) => (d instanceof Date ? d.toISOString() : String(d || '')).slice(0, 10);

// Homeowner: every deal at any builder with this email on it, or linked.
async function projectsFor(a, baseUrl = '') {
  const portal = require('./crmPortal');
  const rows = (await query(
    `SELECT d.id, d.tenant_id, d.title, d.stage, d.site_visit_at, p.address, t.company_name, bp.phone AS builder_phone, bp.email AS builder_email
     FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id JOIN tenants t ON t.id = d.tenant_id LEFT JOIN crm_properties p ON p.id = d.property_id LEFT JOIN business_profile bp ON bp.tenant_id = d.tenant_id
     LEFT JOIN crm_imports i ON i.id = d.import_id
     WHERE 'crm' = ANY(t.products) AND d.stage <> 'lost' AND COALESCE(i.filename, '') <> '__practice__'
       AND (($2::boolean AND lower(c.email) = lower($1)) OR d.id IN (SELECT deal_id FROM crm_account_links WHERE account_id = $3 AND deal_id IS NOT NULL))
     ORDER BY d.created_at DESC LIMIT 50`, [a.email, a.email_verified, a.id])).rows;
  const out = [];
  for (const d of rows) {
    const token = await portal.portalToken(d.tenant_id, d.id);
    out.push({ id: d.id, builder: d.company_name, builderPhone: d.builder_phone, builderEmail: d.builder_email, title: d.title, address: d.address, status: portal.HOMEOWNER_STATUS[d.stage] || 'In progress',
      nextVisit: d.site_visit_at && new Date(d.site_visit_at) > new Date() ? d.site_visit_at : null, url: `${baseUrl}/p/${token}` });
  }
  return out;
}
// Sub: every builder with this email in their subs list, or linked.
async function buildersFor(a, baseUrl = '') {
  const subs = require('./crmSubPortal');
  const rows = (await query(
    `SELECT v.id, v.tenant_id, v.name, v.trade, t.company_name, bp.phone AS builder_phone, bp.email AS builder_email,
            (SELECT COUNT(DISTINCT i.deal_id)::int FROM crm_job_items i JOIN crm_deals d ON d.id = i.deal_id WHERE i.vendor_id = v.id AND d.stage IN ('signed', 'production')) AS jobs,
            (SELECT COUNT(*)::int FROM crm_bid_requests b WHERE b.vendor_id = v.id AND b.status IN ('sent', 'viewed')) AS bids
     FROM crm_vendors v JOIN tenants t ON t.id = v.tenant_id LEFT JOIN business_profile bp ON bp.tenant_id = v.tenant_id
     WHERE 'crm' = ANY(t.products) AND NOT v.archived
       AND (($2::boolean AND lower(v.email) = lower($1)) OR v.id IN (SELECT vendor_id FROM crm_account_links WHERE account_id = $3 AND vendor_id IS NOT NULL))
     ORDER BY t.company_name LIMIT 50`, [a.email, a.email_verified, a.id])).rows;
  const out = [];
  for (const v of rows) {
    const token = await subs.subToken(v.tenant_id, v.id);
    out.push({ id: v.id, builder: v.company_name, builderPhone: v.builder_phone, builderEmail: v.builder_email, listedAs: v.name, trade: v.trade, jobs: v.jobs, bids: v.bids, url: `${baseUrl}/s/${token}` });
  }
  return out;
}
async function home(accountId, baseUrl = '') {
  const a = await getAccount(accountId);
  if (!a) throw err('Not signed in.', 401);
  const list = a.kind === 'sub' ? await buildersFor(a, baseUrl) : await projectsFor(a, baseUrl);
  return { account: { ...a, insurance_expires: a.insurance_expires ? ymd(a.insurance_expires) : null }, [a.kind === 'sub' ? 'builders' : 'projects']: list };
}

// Linking one by the private link a builder sent (whoever has the link can already see that page).
async function linkByUrl(accountId, url) {
  const a = await getAccount(accountId);
  if (!a) throw err('Not signed in.', 401);
  const m = /\/(p|s)\/([0-9a-f]{48})(?:[/?#]|$)/.exec(String(url || '').trim());
  if (!m) throw err(a.kind === 'sub' ? 'Paste the whole link from your builder’s email. It looks like https://myeaglei.com/s/…' : 'Paste the whole link from your builder’s email. It looks like https://myeaglei.com/p/…');
  if (a.kind === 'sub' && m[1] !== 's') throw err('That’s a homeowner’s project link. Paste the link to your sub page (it has /s/ in it).');
  if (a.kind === 'homeowner' && m[1] !== 'p') throw err('That’s a sub’s link. Paste the link to your project page (it has /p/ in it).');
  if (m[1] === 'p') {
    const d = (await query('SELECT id, title FROM crm_deals WHERE portal_token = $1', [m[2]])).rows[0];
    if (!d) throw err('That link doesn’t work any more. Ask your builder for a new one.', 404);
    await query('INSERT INTO crm_account_links (account_id, deal_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [a.id, d.id]);
    return { linked: d.title };
  }
  const v = (await query('SELECT v.id, t.company_name FROM crm_vendors v JOIN tenants t ON t.id = v.tenant_id WHERE v.portal_token = $1 AND NOT v.archived', [m[2]])).rows[0];
  if (!v) throw err('That link doesn’t work any more. Ask the builder for a new one.', 404);
  await query('INSERT INTO crm_account_links (account_id, vendor_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [a.id, v.id]);
  return { linked: v.company_name };
}

// Name, phone and (subs) business details. A sub's details fill in what each
// builder doesn't have yet; nothing a builder typed is changed.
async function saveProfile(accountId, b = {}, { done = false } = {}) {
  const a = await getAccount(accountId);
  if (!a) throw err('Not signed in.', 401);
  const sets = [], vals = [a.id];
  const put = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (b.name !== undefined) { if (!clip(b.name, 120)) throw err('Add your name.'); put('name', clip(b.name, 120)); }
  if (b.phone !== undefined) {
    const digits = String(b.phone || '').replace(/\D/g, '');
    if (b.phone && !(digits.length === 10 || (digits.length === 11 && digits[0] === '1'))) throw err('That phone number doesn’t look right. Use 10 digits, like 713-555-0100.');
    put('phone', clip(b.phone, 40) || null);
  }
  if (b.address !== undefined) put('address', clip(b.address, 200) || null);
  if (a.kind === 'sub') {
    if (b.businessName !== undefined) { if (!clip(b.businessName, 160)) throw err('Add your business name.'); put('business_name', clip(b.businessName, 160)); }
    if (b.trade !== undefined) put('trade', clip(b.trade, 80) || null);
    if (b.license !== undefined) put('license', clip(b.license, 80) || null);
    if (b.insuranceExpires !== undefined) {
      const day = b.insuranceExpires && require('./day').test(b.insuranceExpires) ? b.insuranceExpires : null;
      if (b.insuranceExpires && !day) throw err('Pick the date your insurance runs out.');
      put('insurance_expires', day);
    }
  }
  if (done) sets.push('setup_done_at = COALESCE(setup_done_at, now())');
  if (sets.length) await query(`UPDATE crm_accounts SET ${sets.join(', ')} WHERE id = $1`, vals);
  const now = await getAccount(a.id);
  if (now.kind === 'sub' && now.email_verified) {
    await query(
      `UPDATE crm_vendors v SET phone = COALESCE(NULLIF(v.phone, ''), $2), trade = COALESCE(NULLIF(v.trade, ''), $3), license_no = COALESCE(NULLIF(v.license_no, ''), $4),
              insurance_expires = CASE WHEN v.insurance_expires IS NULL OR v.insurance_expires < $5::date THEN COALESCE($5::date, v.insurance_expires) ELSE v.insurance_expires END
       WHERE NOT v.archived AND (lower(v.email) = lower($1) OR v.id IN (SELECT vendor_id FROM crm_account_links WHERE account_id = $6 AND vendor_id IS NOT NULL))`,
      [now.email, now.phone, now.trade, now.license, now.insurance_expires, now.id]);
  }
  return now;
}

async function changePassword({ accountId, current, password }) {
  const a = (await query('SELECT password_hash FROM crm_accounts WHERE id = $1', [accountId])).rows[0];
  if (!a) throw err('Not signed in.', 401);
  if (!(await bcrypt.compare(String(current || ''), a.password_hash))) throw err('Your current password isn’t right.');
  if (!password || String(password).length < 8) throw err('Pick a new password of at least 8 characters.');
  await query('UPDATE crm_accounts SET password_hash = $2 WHERE id = $1', [accountId, await bcrypt.hash(String(password), BCRYPT_ROUNDS)]);
}

module.exports = {
  KINDS, tidyCode, joinCode, companyForCode, createCompany, requestJoin, listJoinRequests, decideJoin, createAccount, signIn, forgot,
  sendStaffVerify, sendAccountVerify, verifyAccount, getAccount, home, linkByUrl, saveProfile, changePassword
};
