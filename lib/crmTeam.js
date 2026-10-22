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
  return (await query('SELECT id, tenant_id, email, name, role, app FROM users WHERE id = $1', [userId])).rows[0] || null;
}

async function listTeam(tenantId) {
  const members = (await query(
    `SELECT u.id, u.name, u.email, u.role, u.reports_to, u.created_at,
            (SELECT COUNT(*)::int FROM crm_deals d WHERE d.owner_user_id = u.id AND d.stage NOT IN ('complete', 'lost')) AS open_deals
     FROM users u WHERE u.tenant_id = $1
     ORDER BY u.created_at`, [tenantId])).rows
    .sort((a, b) => rankOf(b.role) - rankOf(a.role) || a.created_at - b.created_at)
    .map(m => ({ ...m, role_label: roleLabel(m.role) }));
  const invites = (await query(
    `SELECT id, email, name, role, reports_to, created_at, expires_at FROM crm_invites
     WHERE tenant_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`, [tenantId])).rows;
  const visibility = ((await query('SELECT team_visibility FROM tenants WHERE id = $1', [tenantId])).rows[0] || {}).team_visibility || 'chain';
  return { members, invites, visibility };
}

// ---------- who sees whom ----------

async function people(tenantId) {
  return (await query('SELECT id, name, email, role, reports_to FROM users WHERE tenant_id = $1', [tenantId])).rows;
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
  if (isManager(self.role)) {
    const every = new Set(all.map(u => u.id));
    return { all: true, ids: every, assign: every, below: new Set(all.filter(u => u.id !== self.id).map(u => u.id)), above: new Set() };
  }
  const dn = below(all, self), up = above(all, self);
  const open = ((await query('SELECT team_visibility FROM tenants WHERE id = $1', [tenantId])).rows[0] || {}).team_visibility === 'everyone';
  const ids = open ? new Set(all.map(u => u.id)) : new Set([self.id, ...dn, ...up]);
  return { all: open, ids, assign: new Set([self.id, ...dn]), below: dn, above: up };
}
async function canSee(tenantId, viewer, userId) { return (await reach(tenantId, viewer)).ids.has(userId); }
async function canAssign(tenantId, viewer, userId) { return (await reach(tenantId, viewer)).assign.has(userId); }

async function setVisibility({ tenantId, visibility }) {
  if (!['chain', 'everyone'].includes(visibility)) throw err('Pick “up and down the line” or “everyone”.');
  await query('UPDATE tenants SET team_visibility = $1 WHERE id = $2', [visibility, tenantId]);
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
  await query('UPDATE users SET role = $1 WHERE id = $2', [role, userId]);
  await tidyLines(tenantId);
  if (role === 'admin' && target.role !== 'admin') {
    await require('./crmAlerts').ownerAlert({ tenantId, actorId: actor.id, title: `${target.name || target.email} is now an admin`, detail: 'Admins can change company details, the team, automatic emails and billing.', key: `admin:${userId}:${Date.now()}` }).catch(() => {});
  }
}

// Removing someone deletes their login. Their deals become unassigned and
// their history stays on each deal.
async function removeMember({ tenantId, actor, userId }) {
  const target = await getUser(userId);
  if (!target || target.tenant_id !== tenantId) throw err('Team member not found.', 404);
  if (target.role === 'owner') throw err('The owner can’t be removed.');
  if (target.id === actor.id) throw err('You can’t remove yourself.');
  await query('DELETE FROM users WHERE id = $1 AND tenant_id = $2', [userId, tenantId]);
}

module.exports = {
  ROLES, ROLE_INFO, rankOf, roleLabel, reach, canSee, canAssign, setReportsTo, setVisibility, tidyLines, INVITE_TTL_DAYS, hashToken, isManager, getUser, listTeam, createInvite, revokeInvite, inviteInfo, acceptInvite, setRole, removeMember
};
