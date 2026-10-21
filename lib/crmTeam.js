// A company's team in Eagle I CRM: who can sign in, what they may change,
// and invitations for new people.
//
// Roles:
//  - owner:  signed the company up. Everything, and can't be removed.
//  - admin:  everything the owner can, except removing the owner.
//  - member: works deals (add, move, note, Needs you). Can't change the team,
//            the company details, or the wording/switches of automatic emails,
//            since those speak for the whole company.
//
// Invitations are one-time links that expire after 7 days. Only a hash of the
// token is stored, the same as password-reset links.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool, query } = require('../db');
const { sendEmail } = require('./email');

const ROLES = ['owner', 'admin', 'member'];
const INVITABLE_ROLES = new Set(['admin', 'member']);
const INVITE_TTL_DAYS = 7;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const isManager = (role) => role === 'owner' || role === 'admin';

function err(message, status = 400) { const e = new Error(message); e.status = status; return e; }

async function getUser(userId) {
  return (await query('SELECT id, tenant_id, email, name, role FROM users WHERE id = $1', [userId])).rows[0] || null;
}

async function listTeam(tenantId) {
  const members = (await query(
    `SELECT u.id, u.name, u.email, u.role, u.created_at,
            (SELECT COUNT(*)::int FROM crm_deals d WHERE d.owner_user_id = u.id AND d.stage NOT IN ('complete', 'lost')) AS open_deals
     FROM users u WHERE u.tenant_id = $1
     ORDER BY CASE u.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.created_at`, [tenantId])).rows;
  const invites = (await query(
    `SELECT id, email, name, role, created_at, expires_at FROM crm_invites
     WHERE tenant_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`, [tenantId])).rows;
  return { members, invites };
}

async function createInvite({ tenantId, invitedBy, email, name, role = 'member', baseUrl = '', send = sendEmail }) {
  const em = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(em)) throw err('Enter a valid email address.');
  if (!INVITABLE_ROLES.has(role)) throw err('Pick admin or member.');
  const existing = (await query('SELECT tenant_id FROM users WHERE email = $1', [em])).rows[0];
  if (existing) throw err(existing.tenant_id === tenantId ? 'That person is already on your team.' : 'That email already has an Eagle I account with another company.', 409);
  // A fresh invite replaces any earlier one still open for the same address.
  await query(`UPDATE crm_invites SET revoked_at = now() WHERE tenant_id = $1 AND LOWER(email) = $2 AND accepted_at IS NULL AND revoked_at IS NULL`, [tenantId, em]);
  const token = crypto.randomBytes(32).toString('hex');
  const nm = String(name || '').trim().slice(0, 120) || null;
  await query(
    `INSERT INTO crm_invites (tenant_id, email, name, role, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' days')::interval)`,
    [tenantId, em, nm, role, hashToken(token), invitedBy, String(INVITE_TTL_DAYS)]);
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
      html: `<p>Hi${nm ? ' ' + esc(nm.split(' ')[0]) : ''},</p><p>${esc(who)} invited you to join <b>${esc(company && company.company_name)}</b> on Eagle I CRM, where the team keeps track of every lead and job.</p><p><a href="${inviteUrl}">Accept the invitation</a> (the link works for ${INVITE_TTL_DAYS} days).</p>`,
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
    if ((await client.query('SELECT 1 FROM users WHERE email = $1', [inv.email])).rows.length) throw err('That email already has an Eagle I account. Sign in instead.', 409);
    const hash = await bcrypt.hash(String(password), 12);
    // The invite link reached this address, which proves the person controls it.
    const user = (await client.query(
      `INSERT INTO users (tenant_id, email, password_hash, name, role, terms_accepted_at, email_verified)
       VALUES ($1, $2, $3, $4, $5, now(), true) RETURNING id, tenant_id, email, name, role`,
      [inv.tenant_id, inv.email, hash, nm, inv.role])).rows[0];
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
  if (!INVITABLE_ROLES.has(role)) throw err('Pick admin or member.');
  const target = await getUser(userId);
  if (!target || target.tenant_id !== tenantId) throw err('Team member not found.', 404);
  if (target.role === 'owner') throw err('The owner’s role can’t be changed.');
  if (target.id === actor.id) throw err('You can’t change your own role.');
  await query('UPDATE users SET role = $1 WHERE id = $2', [role, userId]);
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
  ROLES, INVITE_TTL_DAYS, hashToken, isManager, getUser, listTeam, createInvite, revokeInvite, inviteInfo, acceptInvite, setRole, removeMember
};
