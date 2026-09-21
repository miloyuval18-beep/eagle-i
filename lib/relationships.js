// The relationship tracker: for each business the user is working with, a
// stage, notes, a next follow-up date and an "already my vendor" flag.
//
// Stages move forward on their own from what really happens — an email is sent
// (contacted), a real reply arrives (replied) — but never backward, and never
// off "passed"; meetings and working relationships are recorded by the user.
const { query } = require('../db');

const STAGES = ['new', 'contacted', 'replied', 'meeting', 'working', 'passed'];
const STAGE_LABELS = { new: 'Not contacted', contacted: 'Contacted', replied: 'Replied', meeting: 'Meeting set', working: 'Working together', passed: 'Not a fit' };

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;
const clean = (s, max) => String(s == null ? '' : s).replace(CONTROL_CHARS, '').trim().slice(0, max);
const MAX_NOTES = 4000;
const fail = (message, status) => { const e = new Error(message); e.status = status; return e; };

const dateOnly = (d) => (d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : null);
const present = (r) => ({
  id: Number(r.id), source: r.source, sourceId: r.source_id == null ? null : Number(r.source_id),
  name: r.vendor_name, email: r.email, phone: r.phone, stage: r.stage, stageLabel: STAGE_LABELS[r.stage] || r.stage,
  notes: r.notes, nextFollowUp: dateOnly(r.next_follow_up),
  isMyVendor: !!r.is_my_vendor, createdAt: r.created_at, updatedAt: r.updated_at
});

// Called when a first email goes out to a directory business.
async function noteOutreach({ tenantId, source, sourceId, vendorName, email }) {
  await query(
    `INSERT INTO vendor_relationships (tenant_id, source, source_id, vendor_name, email, stage)
     VALUES ($1, $2, $3, $4, $5, 'contacted')
     ON CONFLICT (tenant_id, source, source_id) WHERE source_id IS NOT NULL
     DO UPDATE SET stage = CASE WHEN vendor_relationships.stage = 'new' THEN 'contacted' ELSE vendor_relationships.stage END,
                   email = COALESCE(vendor_relationships.email, EXCLUDED.email), updated_at = now()`,
    [tenantId, source, sourceId, clean(vendorName, 200) || email, email]);
}

// Called when a real (not automatic) reply arrives for an email sent to a directory business.
async function noteReply({ tenantId, source, sourceId }) {
  if (!source || !sourceId) return;
  await query(
    `UPDATE vendor_relationships SET stage = 'replied', updated_at = now()
     WHERE tenant_id = $1 AND source = $2 AND source_id = $3 AND stage IN ('new', 'contacted')`,
    [tenantId, source, sourceId]);
}

async function list(tenantId, { stage, due } = {}) {
  const conds = ['tenant_id = $1'];
  const params = [tenantId];
  if (stage === 'mine') conds.push('is_my_vendor');
  else if (stage && STAGES.includes(stage)) { params.push(stage); conds.push(`stage = $${params.length}`); }
  if (due) conds.push("next_follow_up IS NOT NULL AND next_follow_up <= CURRENT_DATE AND stage <> 'passed'");
  const r = await query(
    `SELECT * FROM vendor_relationships WHERE ${conds.join(' AND ')}
     ORDER BY (next_follow_up IS NULL), next_follow_up ASC, updated_at DESC LIMIT 500`, params);
  return r.rows.map(present);
}

async function summary(tenantId) {
  const r = await query('SELECT stage, COUNT(*)::int AS n FROM vendor_relationships WHERE tenant_id = $1 GROUP BY stage', [tenantId]);
  const d = await query(
    "SELECT COUNT(*)::int AS due FROM vendor_relationships WHERE tenant_id = $1 AND next_follow_up IS NOT NULL AND next_follow_up <= CURRENT_DATE AND stage <> 'passed'", [tenantId]);
  const m = await query('SELECT COUNT(*)::int AS n FROM vendor_relationships WHERE tenant_id = $1 AND is_my_vendor', [tenantId]);
  const byStage = Object.fromEntries(STAGES.map(s => [s, 0]));
  for (const x of r.rows) byStage[x.stage] = x.n;
  return { byStage, dueToday: d.rows[0].due, mine: m.rows[0].n };
}

function validateDate(v) {
  if (v === null || v === '' || v === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || Number.isNaN(Date.parse(v))) throw fail('Dates look like 2026-10-15.', 400);
  return String(v);
}

async function updateById(tenantId, id, p) {
  const sets = [];
  const vals = [];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (p.stage !== undefined) { if (!STAGES.includes(p.stage)) throw fail('Unknown stage.', 400); add('stage', p.stage); }
  if (p.notes !== undefined) add('notes', clean(p.notes, MAX_NOTES));
  if (p.nextFollowUp !== undefined) add('next_follow_up', validateDate(p.nextFollowUp));
  if (p.isMyVendor !== undefined) add('is_my_vendor', !!p.isMyVendor);
  if (p.name !== undefined) { const n = clean(p.name, 200); if (!n) throw fail('A name is required.', 400); add('vendor_name', n); }
  if (p.email !== undefined) add('email', clean(p.email, 200) || null);
  if (p.phone !== undefined) add('phone', clean(p.phone, 40) || null);
  if (!sets.length) {
    const cur = (await query('SELECT * FROM vendor_relationships WHERE id = $1 AND tenant_id = $2', [id, tenantId])).rows[0];
    if (!cur) throw fail('Not found.', 404);
    return present(cur);
  }
  vals.push(id, tenantId);
  const r = await query(`UPDATE vendor_relationships SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length - 1} AND tenant_id = $${vals.length} RETURNING *`, vals);
  if (!r.rows.length) throw fail('Not found.', 404);
  return present(r.rows[0]);
}

// Creates or updates a tracked business. Directory businesses are keyed by (source, sourceId); manual ones are new rows.
async function upsert(tenantId, p) {
  if (p.stage !== undefined && !STAGES.includes(p.stage)) throw fail('Unknown stage.', 400);
  const nextFollowUp = p.nextFollowUp === undefined ? undefined : validateDate(p.nextFollowUp);
  const source = p.source ? clean(p.source, 20) : 'manual';
  const sourceId = p.sourceId ? Number(p.sourceId) : null;
  const name = clean(p.name, 200);
  if (!name) throw fail('A name is required.', 400);
  const notes = p.notes === undefined ? undefined : clean(p.notes, MAX_NOTES);
  const email = p.email === undefined ? undefined : (clean(p.email, 200) || null);
  const phone = p.phone === undefined ? undefined : (clean(p.phone, 40) || null);

  if (sourceId) {
    const existing = (await query('SELECT id FROM vendor_relationships WHERE tenant_id = $1 AND source = $2 AND source_id = $3', [tenantId, source, sourceId])).rows[0];
    if (existing) return updateById(tenantId, existing.id, { stage: p.stage, notes, nextFollowUp, isMyVendor: p.isMyVendor, email, phone });
  }
  const r = await query(
    `INSERT INTO vendor_relationships (tenant_id, source, source_id, vendor_name, email, phone, stage, notes, next_follow_up, is_my_vendor)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [tenantId, source, sourceId, name, email || null, phone || null, p.stage || 'new', notes || '', nextFollowUp || null, !!p.isMyVendor]);
  return present(r.rows[0]);
}

async function remove(tenantId, id) {
  return (await query('DELETE FROM vendor_relationships WHERE id = $1 AND tenant_id = $2', [id, tenantId])).rowCount;
}

module.exports = { STAGES, STAGE_LABELS, noteOutreach, noteReply, list, summary, upsert, updateById, remove };
