// A company's team in Eagle I CRM: who can sign in, what they may change,
// and invitations for new people.
//
// Roles (ROLE_INFO, highest first):
//  - owner:  signed the company up. Everything, and can't be removed.
//  - admin:  everything the owner can, except removing the owner.
//  - project manager, superintendent, sales, office, member: work deals and
//    jobs. They can't change the team, the company details, or the wording
//    and switches of automatic emails, since those speak for the whole company.
//
// Who sees whose schedule (calendar, tasks, visits): each person can report
// to someone ranked above them. You see the people below you in your line
// and the people above you in it, so it works both ways. Someone who reports
// to no one is under the owner and admins. The owner and admins see everyone,
// and the owner can let everyone see everyone's instead (tenants.team_visibility).
//
// Invitations are one-time links that expire after 7 days. Only a hash of the
// token is stored, the same as password-reset links.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool, query } = require('../db');
const { sendEmail } = require('./email');

const ROLE_INFO = {
  owner: { label: 'Owner', rank: 100, about: 'Signed the company up. Can do everything.' },
  admin: { label: 'Admin', rank: 80, about: 'Can do everything except remove the owner: the team, company details, automatic emails and billing. Sees everyone’s schedule.' },
  project_manager: { label: 'Project manager', rank: 60, about: 'Runs jobs. Sees and plans the schedules of the people under them.' },
  superintendent: { label: 'Superintendent', rank: 50, about: 'Runs the job site. Sees and plans the schedules of the people under them.' },
  sales: { label: 'Sales', rank: 40, about: 'Works leads, site visits and estimates.' },
  office: { label: 'Office', rank: 40, about: 'Keeps the paperwork, invoices and calendar moving.' },
  member: { label: 'Team member', rank: 40, about: 'Works deals and jobs.' }
};
const ROLES = Object.keys(ROLE_INFO);

// What each person may do. Every role starts with its defaults (ROLE_DEFAULTS);
// the owner or an admin can then tick or untick each one on the person's card.
const PERMS = [
  { key: 'team', label: 'Manage the team', help: 'Invite people, let people in, change roles and permissions.' },
  { key: 'settings', label: 'Company details and settings', help: 'Company details, Google and Drive, payments setup, the price catalog, referral, marketing and homeowner-page settings.' },
  { key: 'emails', label: 'Automatic emails', help: 'Change, turn on, pause or skip the emails Eagle I sends on its own, and pipeline settings.' },
  { key: 'billing', label: 'Plan and billing', help: 'Choose or change Eagle I’s plan.' },
  { key: 'all_projects', label: 'See every project', help: 'Every deal and job. Without it they see only the projects they manage or handle, or that someone under them does.' },
  { key: 'see_all', label: 'See everyone’s schedule', help: 'Everyone’s calendar, tasks, visits and email follow-ups, not just the people above and below them.' },
  { key: 'reports', label: 'Company reports', help: 'Weekly reports, win/loss and everyone’s coaching.' },
  { key: 'money', label: 'See money', help: 'Invoices, payments, payment schedules, cash flow and job costs.' },
  { key: 'estimates', label: 'Make and send estimates', help: 'Estimates, proposals and change orders.' },
  { key: 'invoices', label: 'Send invoices and record payments', help: 'Make and send invoices and mark them paid.' },
  { key: 'subs', label: 'Work with subs and suppliers', help: 'Add and remove subs, send bid requests, purchase orders and sub pages.' },
  { key: 'delete', label: 'Delete deals and cancel invoices', help: 'Delete deals, cancel invoices, and put back or empty anyone’s recycle bin.' },
  { key: 'data', label: 'Bring in and download data', help: 'Bring in spreadsheets, practice customers, merge duplicates, download everything.' }
];
const PERM_KEYS = PERMS.map(p => p.key);
const all = (on) => Object.fromEntries(PERM_KEYS.map(k => [k, on]));
const some = (keys) => Object.fromEntries(PERM_KEYS.map(k => [k, keys.includes(k)]));
const ROLE_DEFAULTS = {
  owner: all(true),
  admin: all(true),
  // Project managers see only the projects they manage (or handle, or someone under them does).
  project_manager: some(['reports', 'money', 'estimates', 'invoices', 'subs']),
  superintendent: some(['all_projects', 'subs']),
  sales: some(['all_projects', 'estimates']),
  office: some(['all_projects', 'money', 'invoices', 'subs', 'data']),
  // What team members could always do, so nobody loses anything.
  member: some(['all_projects', 'money', 'estimates', 'invoices', 'subs'])
};
// A person's permissions: their role's defaults, with any adjustments on top. The owner always has everything.
function permsOf(user) {
  const role = user && ROLE_DEFAULTS[user.role] ? user.role : 'member';
  const base = ROLE_DEFAULTS[role];
  if (role === 'owner' || !user || !user.permissions || typeof user.permissions !== 'object') return { ...base };
  const out = { ...base };
  for (const k of PERM_KEYS) if (typeof user.permissions[k] === 'boolean') out[k] = user.permissions[k];
  return out;
}
const can = (user, key) => !!permsOf(user)[key];
// Oversight: email this person is only copied on keeps them in the loop (no
// reminders, nothing on their calendar) unless it's sent to them or uses their
// name (lib/crmEmailWatch.js). On by default for the owner and admins.
const oversightOf = (user) => !!user && (typeof user.oversight === 'boolean' ? user.oversight : ['owner', 'admin'].includes(user.role));
async function setOversight({ tenantId, actor, userId, on }) {
  const target = await getUser(userId);
  if (!target || target.tenant_id !== tenantId) throw err('Team member not found.', 404);
  if (target.id !== actor.id) {
    if (!can(actor, 'team')) throw err(denyText('team'), 403);
    if (target.role === 'owner') throw err('Only the owner can change this for themselves.', 403);
    if (target.role === 'admin' && !isManager(actor.role)) throw err('Only the owner or an admin can change this for an admin.', 403);
  }
  const value = !!on === ['owner', 'admin'].includes(target.role) ? null : !!on;
  await query('UPDATE users SET oversight = $2 WHERE id = $1', [userId, value]);
  if (target.id !== actor.id) await require('./crmAudit').log({ tenantId, actor, action: 'permissions', targetId: userId, targetName: target.name || target.email, detail: on ? 'Emails they’re only copied on keep them in the loop' : 'Emails they’re copied on are treated like any other' });
  return { oversight: !!on };
}
const denyText = (key) => { const p = PERMS.find(x => x.key === key); return `You don’t have permission for this (${p ? p.label.toLowerCase() : key}). Ask the owner or an admin.`; };
// For people without "See money": dollar figures come out of what they're sent
// (any number under a money-sounding key becomes null). Returns a copy.
const MONEY_KEY = /(^|_|[a-z])(value|values|amount|total|totals|price|cost|costs|revenue|margin|budget|contract|paid|balance|spend|spent|collected|owed|owing|backlog|profit|deposit|subtotal|tax|allowance|rate|actual|billed)s?($|_|[A-Z])/i;
// Dollar amounts written inside text ("Deposit ($7,000.00)", "Budget around $95k") too.
const DOLLARS = /-?\$\s?-?\d[\d,]*(\.\d+)?\s?(k|m|K|M)?\b/g;
function hideMoney(x, depth = 0) {
  if (depth > 8 || x == null) return x;
  if (typeof x === 'string') return x.replace(DOLLARS, '$ —');
  if (Array.isArray(x)) return x.map(v => hideMoney(v, depth + 1));
  if (typeof x !== 'object' || x instanceof Date) return x;
  const out = {};
  for (const [k, v] of Object.entries(x)) {
    if (MONEY_KEY.test(k) && (typeof v === 'number' || (typeof v === 'string' && /^-?\$?[\d,.]+$/.test(v.trim())))) out[k] = null;
    else if (MONEY_KEY.test(k) && v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(n => typeof n === 'number' || n == null)) out[k] = null;
    else out[k] = hideMoney(v, depth + 1);
  }
  return out;
}

// Express: only people with this permission (req.crmUser is set by routes/crm.js).
const need = (key) => (req, res, next) => can(req.crmUser, key) ? next() : res.status(403).json({ error: { message: denyText(key), code: 'permission' } });
const INVITABLE_ROLES = new Set(ROLES.filter(r => r !== 'owner'));
const rankOf = (role) => (ROLE_INFO[role] || ROLE_INFO.member).rank;
const roleLabel = (role) => (ROLE_INFO[role] || ROLE_INFO.member).label;
const PICK_ROLE = 'Pick one of: ' + ROLES.filter(r => r !== 'owner').map(roleLabel).join(', ') + '.';
const INVITE_TTL_DAYS = 7;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const isManager = (role) => role === 'owner' || role === 'admin';

function err(message, status = 400) { const e = new Error(message); e.status = status; return e; }

async function getUser(userId) {
  return (await query('SELECT id, tenant_id, email, name, role, app, permissions, oversight, disabled_at FROM users WHERE id = $1', [userId])).rows[0] || null;
}

async function listTeam(tenantId) {
  const members = (await query(
    `SELECT u.id, u.name, u.email, u.role, u.reports_to, u.permissions AS custom, u.oversight, u.disabled_at, u.created_at,
            (SELECT COUNT(*)::int FROM crm_deals d WHERE d.owner_user_id = u.id AND d.stage NOT IN ('complete', 'lost')) AS open_deals
     FROM users u WHERE u.tenant_id = $1
     ORDER BY u.created_at`, [tenantId])).rows
    .sort((a, b) => rankOf(b.role) - rankOf(a.role) || a.created_at - b.created_at)
    .map(m => ({ ...m, role_label: roleLabel(m.role), permissions: permsOf({ role: m.role, permissions: m.custom }), custom: !!m.custom && m.role !== 'owner', oversight: oversightOf(m) }));
  const invites = (await query(
    `SELECT id, email, name, role, reports_to, created_at, expires_at FROM crm_invites
     WHERE tenant_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`, [tenantId])).rows;
  const visibility = ((await query('SELECT team_visibility FROM tenants WHERE id = $1', [tenantId])).rows[0] || {}).team_visibility || 'chain';
  return { members, invites, visibility };
}

// ---------- who sees whom ----------

async function people(tenantId) {
  return (await query('SELECT id, name, email, role, reports_to, permissions FROM users WHERE tenant_id = $1', [tenantId])).rows;
}

// Everyone below this person in their line: the people who report to them,
// the people who report to those people, and so on.
function below(all, viewer) {
  const out = new Set();
  const queue = [viewer.id];
  while (queue.length) {
    const x = queue.shift();
    for (const u of all) if (u.reports_to === x && u.id !== viewer.id && !out.has(u.id)) { out.add(u.id); queue.push(u.id); }
  }
  return out;
}
// Everyone above this person: whoever they report to, and on up, plus the
// owner and admins (everyone is under them in the end).
function above(all, viewer) {
  const byId = new Map(all.map(u => [u.id, u]));
  const out = new Set();
  let cur = byId.get(viewer.id);
  for (let i = 0; cur && cur.reports_to && i < 50; i++) {
    const up = byId.get(cur.reports_to); if (!up || out.has(up.id) || up.id === viewer.id) break;
    out.add(up.id); cur = up;
  }
  for (const u of all) if (u.id !== viewer.id && isManager(u.role)) out.add(u.id);
  return out;
}

// { all: true } or { ids: Set } of whose schedule this person may see, and
// { assign: Set } of whose calendar they may put things on (their own and below).
async function reach(tenantId, viewer) {
  const me = viewer && viewer.id ? viewer : null;
  if (!me) return { all: false, ids: new Set(), assign: new Set(), below: new Set(), above: new Set() };
  const all = await people(tenantId);
  const self = all.find(u => u.id === me.id) || me;
  if (can(self, 'see_all')) {
    const every = new Set(all.map(u => u.id));
    return { all: true, ids: every, assign: every, below: new Set(all.filter(u => u.id !== self.id).map(u => u.id)), above: new Set() };
  }
  const dn = below(all, self), up = above(all, self);
  const open = ((await query('SELECT team_visibility FROM tenants WHERE id = $1', [tenantId])).rows[0] || {}).team_visibility === 'everyone';
  const ids = open ? new Set(all.map(u => u.id)) : new Set([self.id, ...dn, ...up]);
  return { all: open, ids, assign: new Set([self.id, ...dn]), below: dn, above: up };
}
// Which projects this person may see: null for every one ("See every project"), or the
// Set of deal ids they manage or handle, or someone under them does.
async function projectScope(tenantId, viewer) {
  if (!viewer || can(viewer, 'all_projects')) return null;
  const r = await reach(tenantId, viewer);
  const ids = [viewer.id, ...r.below];
  return new Set((await query(`SELECT id FROM crm_deals WHERE tenant_id = $1 AND (pm_user_id = ANY($2::uuid[]) OR owner_user_id = ANY($2::uuid[]))`, [tenantId, ids])).rows.map(x => x.id));
}
async function canSee(tenantId, viewer, userId) { return (await reach(tenantId, viewer)).ids.has(userId); }
async function canAssign(tenantId, viewer, userId) { return (await reach(tenantId, viewer)).assign.has(userId); }

async function setVisibility({ tenantId, visibility, actor = null }) {
  if (!['chain', 'everyone'].includes(visibility)) throw err('Pick “up and down the line” or “everyone”.');
  await query('UPDATE tenants SET team_visibility = $1 WHERE id = $2', [visibility, tenantId]);
  await require('./crmAudit').log({ tenantId, actor, action: 'visibility', detail: visibility === 'everyone' ? 'Everyone sees everyone’s schedule' : 'Up and down each person’s line' });
}

// Who this person reports to. Must be on the team and ranked above them, and
// null = no one (they're under the owner and admins).
async function setReportsTo({ tenantId, actor, userId, reportsTo }) {
  const all = await people(tenantId);
  const target = all.find(u => u.id === userId);
  if (!target) throw err('Team member not found.', 404);
  if (target.role === 'owner') throw err('The owner doesn’t report to anyone.');
  const to = reportsTo || null;
  if (to) {
    const boss = all.find(u => u.id === to);
    if (!boss) throw err('That person isn’t on the team.', 404);
    if (boss.id === target.id) throw err('Someone can’t report to themselves.');
    if (rankOf(boss.role) <= rankOf(target.role)) throw err(`${boss.name || boss.email} (${roleLabel(boss.role)}) isn’t above ${target.name || target.email} (${roleLabel(target.role)}). Pick someone in a higher role, or change a role first.`);
    // Ranks only go up a line, so it can never loop back round.
  }
  await query('UPDATE users SET reports_to = $1 WHERE id = $2 AND tenant_id = $3', [to, userId, tenantId]);
  if ((target.reports_to || null) !== to) { const boss = to && all.find(u => u.id === to); await require('./crmAudit').log({ tenantId, actor, action: 'reports_to', targetId: userId, targetName: target.name || target.email, detail: boss ? `Now reports to ${boss.name || boss.email}` : 'Now reports to the owner and admins' }); }
}

// After a role change, nobody may report to someone at or below their own rank.
async function tidyLines(tenantId) {
  const all = await people(tenantId);
  const byId = new Map(all.map(u => [u.id, u]));
  for (const u of all) {
    const b = u.reports_to && byId.get(u.reports_to);
    if (u.reports_to && (!b || rankOf(b.role) <= rankOf(u.role) || u.role === 'owner')) await query('UPDATE users SET reports_to = NULL WHERE id = $1', [u.id]);
  }
}

async function createInvite({ tenantId, invitedBy, email, name, role = 'member', reportsTo = null, baseUrl = '', send = sendEmail }) {
  const em = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(em)) throw err('Enter a valid email address.');
  if (!INVITABLE_ROLES.has(role)) throw err(PICK_ROLE);
  if (reportsTo) {
    const boss = (await query('SELECT id, role FROM users WHERE id = $1 AND tenant_id = $2', [/^[0-9a-f-]{36}$/.test(String(reportsTo)) ? reportsTo : null, tenantId])).rows[0];
    if (!boss) throw err('The person they’ll report to isn’t on the team.', 404);
    if (rankOf(boss.role) <= rankOf(role)) throw err(`They can only report to someone in a higher role than ${roleLabel(role)}.`);
  }
  const existing = (await query(`SELECT tenant_id FROM users WHERE lower(email) = $1 AND app IN ('crm', 'both')`, [em])).rows[0];
  if (existing) throw err(existing.tenant_id === tenantId ? 'That person is already on your team.' : 'That email already has an Eagle I CRM account with another company.', 409);
  // A fresh invite replaces any earlier one still open for the same address.
  await query(`UPDATE crm_invites SET revoked_at = now() WHERE tenant_id = $1 AND LOWER(email) = $2 AND accepted_at IS NULL AND revoked_at IS NULL`, [tenantId, em]);
  const token = crypto.randomBytes(32).toString('hex');
  const nm = String(name || '').trim().slice(0, 120) || null;
  await query(
    `INSERT INTO crm_invites (tenant_id, email, name, role, token_hash, invited_by, expires_at, reports_to)
     VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' days')::interval, $8)`,
    [tenantId, em, nm, role, hashToken(token), invitedBy, String(INVITE_TTL_DAYS), reportsTo || null]);
  const inviteUrl = `${baseUrl}/crm/join?token=${token}`;
  const company = (await query('SELECT company_name FROM tenants WHERE id = $1', [tenantId])).rows[0];
  const inviter = await getUser(invitedBy);
  const who = (inviter && (inviter.name || inviter.email)) || 'Your team';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let emailed = true;
  try {
    await send({
      to: em,
      subject: `${who} invited you to ${company ? company.company_name : 'their company'} on Eagle I CRM`,
      html: `<p>Hi${nm ? ' ' + esc(nm.split(' ')[0]) : ''},</p><p>${esc(who)} invited you to join <b>${esc(company && company.company_name)}</b> on Eagle I CRM as ${/^[aeiou]/i.test(roleLabel(role)) ? 'an' : 'a'} ${esc(roleLabel(role).toLowerCase())}, where the team keeps track of every lead and job.</p><p><a href="${inviteUrl}">Accept the invitation</a> (the link works for ${INVITE_TTL_DAYS} days).</p>`,
      text: `${who} invited you to join ${company && company.company_name} on Eagle I CRM. Accept the invitation (link works for ${INVITE_TTL_DAYS} days): ${inviteUrl}`
    });
  } catch (e) {
    emailed = false; // the owner still gets the link to pass on by hand
  }
  await require('./crmAudit').log({ tenantId, actor: inviter, action: 'invite', targetName: nm ? `${nm} (${em})` : em, detail: roleLabel(role) });
  return { inviteUrl, emailed };
}

async function revokeInvite({ tenantId, id }) {
  return (await query(`UPDATE crm_invites SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`, [id, tenantId])).rowCount > 0;
}

async function inviteInfo(token) {
  const r = (await query(
    `SELECT i.email, i.name, i.role, t.company_name FROM crm_invites i JOIN tenants t ON t.id = i.tenant_id
     WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`, [hashToken(token)])).rows[0];
  return r || null;
}

// Creates the login and joins the company. Returns the new user.
async function acceptInvite({ token, name, password }) {
  if (!password || String(password).length < 8) throw err('Pick a password of at least 8 characters.');
  const nm = String(name || '').trim().slice(0, 120);
  if (!nm) throw err('Add your name so your team knows who did what.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inv = (await client.query(
      `SELECT * FROM crm_invites WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`, [hashToken(token)])).rows[0];
    if (!inv) throw err('This invitation link is invalid, already used, or has expired. Ask for a new one.');
    if ((await client.query(`SELECT 1 FROM users WHERE lower(email) = $1 AND app IN ('crm', 'both')`, [inv.email])).rows.length) throw err('That email already has an Eagle I CRM account. Sign in instead.', 409);
    const hash = await bcrypt.hash(String(password), 12);
    // The invite link reached this address, which proves the person controls it.
    const user = (await client.query(
      `INSERT INTO users (tenant_id, email, password_hash, name, role, terms_accepted_at, email_verified, reports_to, app)
       VALUES ($1, $2, $3, $4, $5, now(), true, (SELECT id FROM users WHERE id = $6 AND tenant_id = $1), 'crm') RETURNING id, tenant_id, email, name, role`,
      [inv.tenant_id, inv.email, hash, nm, inv.role, inv.reports_to])).rows[0];
    await client.query('UPDATE crm_invites SET accepted_at = now() WHERE id = $1', [inv.id]);
    await client.query('COMMIT');
    return user;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function setRole({ tenantId, actor, userId, role }) {
  if (!INVITABLE_ROLES.has(role)) throw err(PICK_ROLE);
  const target = await getUser(userId);
  if (!target || target.tenant_id !== tenantId) throw err('Team member not found.', 404);
  if (target.role === 'owner') throw err('The owner’s role can’t be changed.');
  if (target.id === actor.id) throw err('You can’t change your own role.');
  if (role === 'admin' && !isManager(actor.role)) throw err('Only the owner or an admin can make someone an admin.', 403);
  if (target.role === 'admin' && !isManager(actor.role)) throw err('Only the owner or an admin can change an admin’s role.', 403);
  // A new role starts from that role's default permissions.
  await query('UPDATE users SET role = $1, permissions = NULL, oversight = NULL WHERE id = $2', [role, userId]);
  if (target.role !== role) await require('./crmAudit').log({ tenantId, actor, action: 'role', targetId: userId, targetName: target.name || target.email, detail: `${roleLabel(target.role)} → ${roleLabel(role)} (permissions back to the ${roleLabel(role).toLowerCase()} defaults)` });
  await tidyLines(tenantId);
  if (role === 'admin' && target.role !== 'admin') {
    await require('./crmAlerts').ownerAlert({ tenantId, actorId: actor.id, title: `${target.name || target.email} is now an admin`, detail: 'Admins can change company details, the team, automatic emails and billing.', key: `admin:${userId}:${Date.now()}` }).catch(() => {});
  }
}

// Ticking or unticking permissions on someone's card. Nobody changes their
// own, the owner's are fixed, and you can only give what you have yourself.
async function setPermissions({ tenantId, actor, userId, permissions }) {
  const target = await getUser(userId);
  if (!target || target.tenant_id !== tenantId) throw err('Team member not found.', 404);
  if (target.role === 'owner') throw err('The owner can always do everything.');
  if (target.id === actor.id) throw err('You can’t change your own permissions. Ask the owner or another admin.');
  if (target.role === 'admin' && !isManager(actor.role)) throw err('Only the owner or an admin can change an admin’s permissions.', 403);
  if (permissions === null) {
    await query('UPDATE users SET permissions = NULL WHERE id = $1', [userId]);
    await require('./crmAudit').log({ tenantId, actor, action: 'permissions', targetId: userId, targetName: target.name || target.email, detail: `Back to the ${roleLabel(target.role).toLowerCase()} defaults` });
    return permsOf({ role: target.role });
  }
  if (!permissions || typeof permissions !== 'object') throw err('Tick the permissions they should have.');
  const now = permsOf(target);
  const mine = permsOf(actor);
  const next = { ...now };
  for (const k of PERM_KEYS) {
    if (typeof permissions[k] !== 'boolean') continue;
    if (permissions[k] && !now[k] && !mine[k]) throw err(`You can’t give “${PERMS.find(p => p.key === k).label}” because you don’t have it yourself.`, 403);
    next[k] = permissions[k];
  }
  const defaults = ROLE_DEFAULTS[target.role] || ROLE_DEFAULTS.member;
  const same = PERM_KEYS.every(k => next[k] === defaults[k]);
  await query('UPDATE users SET permissions = $2 WHERE id = $1', [userId, same ? null : JSON.stringify(next)]);
  const changes = PERM_KEYS.filter(k => next[k] !== now[k]).map(k => `${next[k] ? 'can now' : 'can no longer'}: ${PERMS.find(p => p.key === k).label.toLowerCase()}`);
  if (changes.length) await require('./crmAudit').log({ tenantId, actor, action: 'permissions', targetId: userId, targetName: target.name || target.email, detail: changes.join('; ') });
  if (next.team && !now.team) await require('./crmAlerts').ownerAlert({ tenantId, actorId: actor.id, title: `${target.name || target.email} can now manage the team`, detail: 'They can invite people, let people in, and change roles and permissions.', key: `perm-team:${userId}:${Date.now()}` }).catch(() => {});
  return next;
}

// ---------- turning someone off, and handing over their work ----------

// Off: they can't sign in (and are signed out everywhere at once), their
// history and work stay, and they don't take a seat. Back on any time.
async function setActive({ tenantId, actor, userId, on }) {
  const target = await getUser(userId);
  if (!target || target.tenant_id !== tenantId) throw err('Team member not found.', 404);
  if (target.role === 'owner') throw err('The owner can’t be turned off.');
  if (target.id === actor.id) throw err('You can’t turn yourself off.');
  if (target.role === 'admin' && !isManager(actor.role)) throw err('Only the owner or an admin can turn off an admin.', 403);
  if (on) {
    if (!target.disabled_at) return { on: true };
    await require('./crmBilling').checkSeat(tenantId);
    await query('UPDATE users SET disabled_at = NULL WHERE id = $1', [userId]);
  } else {
    await query('UPDATE users SET disabled_at = COALESCE(disabled_at, now()) WHERE id = $1', [userId]);
    await query(`DELETE FROM session WHERE sess->>'userId' = $1`, [String(userId)]).catch(() => {});
    await query('DELETE FROM crm_trusted_devices WHERE user_id = $1', [userId]).catch(() => {});
  }
  await require('./crmAudit').log({ tenantId, actor, action: on ? 'turned_on' : 'turned_off', targetId: userId, targetName: target.name || target.email });
  return { on: !!on };
}

// Everything open that's theirs goes to someone else: deals they own, site
// visits, open tasks, job phases not done, appointments still to come, the
// people who report to them, and new leads if they were the one getting them.
async function handover({ tenantId, actor, fromId, toId }) {
  const from = await getUser(fromId), to = await getUser(toId);
  if (!from || from.tenant_id !== tenantId) throw err('Team member not found.', 404);
  if (!to || to.tenant_id !== tenantId) throw err('Pick who gets their work.', 404);
  if (from.id === to.id) throw err('Pick someone else to get their work.');
  if (to.disabled_at) throw err(`${to.name || to.email} is turned off. Pick someone who’s working.`);
  const n = {};
  n.deals = (await query(`UPDATE crm_deals SET owner_user_id = $3 WHERE tenant_id = $1 AND owner_user_id = $2 AND stage NOT IN ('complete', 'lost')`, [tenantId, from.id, to.id])).rowCount;
  n.visits = (await query(`UPDATE crm_deals SET site_visit_user_id = $3 WHERE tenant_id = $1 AND site_visit_user_id = $2 AND site_visit_at > now()`, [tenantId, from.id, to.id])).rowCount;
  n.tasks = (await query(`UPDATE crm_tasks SET assignee_user_id = $3 WHERE tenant_id = $1 AND assignee_user_id = $2 AND done_at IS NULL`, [tenantId, from.id, to.id])).rowCount;
  n.phases = (await query(`UPDATE crm_job_items SET assignee_user_id = $3 WHERE tenant_id = $1 AND assignee_user_id = $2 AND status <> 'done'`, [tenantId, from.id, to.id])).rowCount;
  n.appointments = (await query(`UPDATE crm_events SET user_id = $3 WHERE tenant_id = $1 AND user_id = $2 AND ends_at > now()`, [tenantId, from.id, to.id])).rowCount;
  // Their reports now report to whoever takes over, if that's a step up for them; otherwise to the owner and admins.
  const reports = (await query('SELECT id, role FROM users WHERE tenant_id = $1 AND reports_to = $2', [tenantId, from.id])).rows;
  for (const r of reports) await query('UPDATE users SET reports_to = $2 WHERE id = $1', [r.id, rankOf(to.role) > rankOf(r.role) && r.id !== to.id ? to.id : null]);
  n.reports = reports.length;
  const crm = require('./crm');
  const st = await crm.getSettings(tenantId);
  if (st.leadOwnerUserId === from.id) { await crm.saveSettings(tenantId, { leadOwnerUserId: to.id }); n.newLeads = true; }
  await require('./crmAudit').log({ tenantId, actor, action: 'handover', targetId: from.id, targetName: from.name || from.email,
    detail: !(n.deals || n.visits || n.tasks || n.phases || n.appointments || n.reports || n.newLeads) ? `To ${to.name || to.email}: nothing open to hand over.` : `To ${to.name || to.email}: ${n.deals} deals, ${n.visits} visits, ${n.tasks} tasks, ${n.phases} job phases, ${n.appointments} appointments${n.reports ? `, ${n.reports} people who reported to them` : ''}${n.newLeads ? ', and new leads' : ''}.` });
  return n;
}

// Removing someone deletes their login. Their deals become unassigned and
// their history stays on each deal.
async function removeMember({ tenantId, actor, userId }) {
  const target = await getUser(userId);
  if (!target || target.tenant_id !== tenantId) throw err('Team member not found.', 404);
  if (target.role === 'owner') throw err('The owner can’t be removed.');
  if (target.id === actor.id) throw err('You can’t remove yourself.');
  if (target.role === 'admin' && !isManager(actor.role)) throw err('Only the owner or an admin can remove an admin.', 403);
  await query('DELETE FROM users WHERE id = $1 AND tenant_id = $2', [userId, tenantId]);
  await require('./crmAudit').log({ tenantId, actor, action: 'removed', targetId: userId, targetName: target.name || target.email });
}

module.exports = {
  setActive, handover,
  hideMoney,
  PERMS, PERM_KEYS, ROLE_DEFAULTS, permsOf, can, oversightOf, setOversight, need, denyText, setPermissions,
  projectScope, ROLES, ROLE_INFO, rankOf, roleLabel, reach, canSee, canAssign, setReportsTo, setVisibility, tidyLines, INVITE_TTL_DAYS, hashToken, isManager, getUser, listTeam, createInvite, revokeInvite, inviteInfo, acceptInvite, setRole, removeMember
};
