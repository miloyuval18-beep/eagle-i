// The owner's activity log: who changed what. Roles, permissions, who reports
// to whom, people invited, let in, turned off or removed, work handed over,
// deletes, imports, downloads and company settings. Never fails what it records.
const { query } = require('../db');

const LABELS = {
  role: 'Changed a role', permissions: 'Changed permissions', reports_to: 'Changed who someone reports to',
  invite: 'Invited someone', invite_cancel: 'Cancelled an invitation', join_approved: 'Let someone in', join_declined: 'Said no to someone',
  turned_off: 'Turned someone off', turned_on: 'Turned someone back on', removed: 'Removed someone', handover: 'Handed over work',
  visibility: 'Changed who sees whose schedule', deleted: 'Deleted', restored: 'Put back from the recycle bin', purged: 'Emptied from the recycle bin',
  company: 'Changed company details', emails: 'Changed automatic emails', settings: 'Changed settings', import: 'Brought in data', import_undo: 'Undid an import',
  export: 'Downloaded all data', two_step: 'Two-step sign-in', signed_in_new: 'Signed in on a new device'
};

async function log({ tenantId, actor = null, action, targetId = null, targetName = null, detail = null }) {
  try {
    let name = actor ? (actor.name || actor.email || null) : null;
    if (actor && actor.id && !name) name = ((await query('SELECT COALESCE(name, email) AS n FROM users WHERE id = $1', [actor.id])).rows[0] || {}).n || null;
    await query(`INSERT INTO crm_audit (tenant_id, actor_id, actor_name, action, target_id, target_name, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, actor && actor.id ? actor.id : null, name, String(action).slice(0, 40), targetId ? String(targetId) : null, targetName ? String(targetName).slice(0, 200) : null, detail ? String(detail).slice(0, 1000) : null]);
  } catch (e) { console.warn('[crmAudit] not recorded:', e.message); }
}

// Newest first. { person } narrows to what one person did or had done to them.
async function list(tenantId, { person = null, before = null, limit = 60 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 60, 1), 200);
  const rows = (await query(
    `SELECT id, actor_id, actor_name, action, target_id, target_name, detail, created_at FROM crm_audit
     WHERE tenant_id = $1 AND ($2::uuid IS NULL OR actor_id = $2 OR target_id = $2::text) AND ($3::bigint IS NULL OR id < $3)
     ORDER BY id DESC LIMIT $4`, [tenantId, /^[0-9a-f-]{36}$/.test(String(person || '')) ? person : null, /^\d+$/.test(String(before || '')) ? before : null, lim])).rows;
  return rows.map(r => ({ ...r, label: LABELS[r.action] || r.action }));
}

module.exports = { LABELS, log, list };
