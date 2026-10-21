// The recycle bin, in Eagle I CRM.
//
// keep() runs just before something is deleted: it copies the row and every
// row that would be deleted along with it (following the database's own
// "delete with it" links), plus the links that would just be cleared (an
// email that stays but loses its deal). restore() puts all of it back in the
// same order and re-links what was cleared. Archived things (subs, products,
// partners, catalog items) are listed too; restoring un-archives them.
// Everything is kept 30 days, then purge() removes it for good.
const { query, pool } = require('../db');

const DAYS = 30;
const MAX_ROWS = 20000;
function err(message, status = 400) { const e = new Error(message); e.status = status; return e; }

// What each kind is called and how its label reads.
const KINDS = {
  deal: { table: 'crm_deals', name: 'Deal', label: (r) => r.title },
  phase: { table: 'crm_job_items', name: 'Phase', label: (r) => r.title },
  task: { table: 'crm_tasks', name: 'Task', label: (r) => r.title },
  cost: { table: 'crm_costs', name: 'Cost', label: (r) => `${r.description || 'Cost'} ($${Number(r.amount || 0).toLocaleString('en-US')})` },
  estimate: { table: 'crm_estimates', name: 'Estimate', label: (r) => `#${r.number} ${r.title || ''}`.trim() },
  chat: { table: 'crm_ai_threads', name: 'Chat', label: (r) => r.title || 'Chat' },
  event: { table: 'crm_events', name: 'Calendar', label: (r) => r.title },
  home: { table: 'crm_home_items', name: 'Home file', label: (r) => r.name },
  spend: { table: 'crm_marketing_spend', name: 'Marketing spend', label: (r) => `${r.source} ${String(r.month || '').slice(0, 7)}` },
  draw: { table: 'crm_draws', name: 'Payment schedule', label: (r) => r.title },
  file: { table: 'crm_files', name: 'File', label: (r) => r.filename },
  vendor: { table: 'crm_vendors', name: 'Sub/vendor', label: (r) => r.name, archive: true },
  product: { table: 'crm_products', name: 'Product', label: (r) => r.name, archive: true },
  partner: { table: 'crm_partners', name: 'Partner', label: (r) => r.name, archive: true },
  catalog: { table: 'crm_catalog_items', name: 'Catalog item', label: (r) => r.name, archive: true }
};

// The database's own links: which tables point at which, and what happens on delete.
let fkCache = null;
async function links() {
  if (fkCache) return fkCache;
  fkCache = (await query(
    `SELECT c.conrelid::regclass::text AS child, a.attname AS col, c.confrelid::regclass::text AS parent, pa.attname AS pcol, c.confdeltype AS rule
     FROM pg_constraint c
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
     WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1`)).rows;
  return fkCache;
}
const ident = (t) => { if (!/^[a-z_][a-z0-9_]*$/.test(t)) throw err('Bad table.'); return `"${t}"`; };

// Copies a row and everything that would go with it. Parents come first.
async function snapshot(table, id) {
  const fks = await links();
  const rows = [], relinks = [];
  const seen = new Set();
  let queue = [{ t: table, col: 'id', vals: [id] }];
  while (queue.length) {
    const next = [];
    for (const { t, col, vals } of queue) {
      if (!vals.length) continue;
      const got = (await query(`SELECT row_to_json(x) AS r FROM ${ident(t)} x WHERE ${ident(col)}::text = ANY($1::text[])`, [vals.map(String)])).rows.map(r => r.r);
      const fresh = got.filter(r => { const k = `${t}:${r.id === undefined ? JSON.stringify(r) : r.id}`; if (seen.has(k)) return false; seen.add(k); return true; });
      for (const r of fresh) rows.push({ t, r });
      if (rows.length > MAX_ROWS) throw err('That’s too big to keep in the recycle bin.');
      // Children that go with it, and links that are only cleared.
      for (const fk of fks.filter(f => f.parent === t)) {
        const parentVals = fresh.map(r => r[fk.pcol]).filter(v => v != null);
        if (!parentVals.length) continue;
        if (fk.rule === 'c') next.push({ t: fk.child, col: fk.col, vals: parentVals });
        else if (fk.rule === 'n') {
          const refs = (await query(`SELECT id, ${ident(fk.col)} AS val FROM ${ident(fk.child)} WHERE ${ident(fk.col)}::text = ANY($1::text[])`, [parentVals.map(String)]).catch(() => ({ rows: [] }))).rows;
          for (const x of refs) relinks.push({ t: fk.child, col: fk.col, id: x.id, val: x.val });
        }
      }
    }
    queue = next;
  }
  return { rows, relinks };
}

// Call just before deleting (or archiving). Returns the bin entry's id, for "Undo".
async function keep({ tenantId, kind, id, userId = null }) {
  const k = KINDS[kind];
  if (!k) throw err('Unknown kind.');
  const root = (await query(`SELECT row_to_json(x) AS r FROM ${ident(k.table)} x WHERE id::text = $1 AND tenant_id = $2`, [String(id), tenantId]).catch(() => ({ rows: [] }))).rows[0];
  if (!root) return null; // not this company's, or already gone: the delete itself will say so
  const label = String(k.label(root.r) || k.name).slice(0, 200);
  if (k.archive) {
    return (await query(`INSERT INTO crm_trash (tenant_id, kind, label, mode, root_table, root_id, deleted_by) VALUES ($1, $2, $3, 'archived', $4, $5, $6) RETURNING id`,
      [tenantId, kind, label, k.table, String(id), userId])).rows[0].id;
  }
  const { rows, relinks } = await snapshot(k.table, id);
  return (await query(`INSERT INTO crm_trash (tenant_id, kind, label, mode, root_table, root_id, rows, relinks, deleted_by) VALUES ($1, $2, $3, 'deleted', $4, $5, $6, $7, $8) RETURNING id`,
    [tenantId, kind, label, k.table, String(id), JSON.stringify(rows), JSON.stringify(relinks), userId])).rows[0].id;
}

// What's in the bin: everything for the owner and admins, your own deletions for everyone else.
async function list(tenantId, { userId = null } = {}) {
  return (await query(
    `SELECT t.id, t.kind, t.label, t.mode, t.deleted_at, COALESCE(u.name, u.email) AS who, jsonb_array_length(COALESCE(t.rows, '[]'::jsonb)) AS n
     FROM crm_trash t LEFT JOIN users u ON u.id = t.deleted_by WHERE t.tenant_id = $1 AND t.deleted_at > now() - ($2 || ' days')::interval AND ($3::uuid IS NULL OR t.deleted_by = $3)
     ORDER BY t.deleted_at DESC LIMIT 300`,
    [tenantId, String(DAYS), userId])).rows.map(r => ({ ...r, name: (KINDS[r.kind] || {}).name || r.kind, purgeOn: new Date(new Date(r.deleted_at).getTime() + DAYS * 86400000) }));
}

// Puts it back. Everything or nothing.
async function restore({ tenantId, id }) {
  const t = (await query('SELECT * FROM crm_trash WHERE id::text = $1 AND tenant_id = $2', [String(id), tenantId])).rows[0];
  if (!t) throw err('That’s no longer in the recycle bin.', 404);
  const k = KINDS[t.kind];
  if (t.mode === 'archived') {
    await query(`UPDATE ${ident(t.root_table)} SET archived = false WHERE id::text = $1 AND tenant_id = $2`, [t.root_id, tenantId]);
    await query('DELETE FROM crm_trash WHERE id = $1', [t.id]);
    return { kind: t.kind, label: t.label, id: t.root_id };
  }
  const exists = (await query(`SELECT 1 FROM ${ident(t.root_table)} WHERE id::text = $1`, [t.root_id])).rows.length;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!exists) {
      // Rows can point at each other (a payment milestone at its invoice), so a
      // row that isn't ready yet waits for the next pass.
      let todo = (t.rows || []).slice();
      for (let pass = 0; todo.length && pass < 12; pass++) {
        const later = [];
        for (const item of todo) {
          await client.query('SAVEPOINT row');
          try {
            await client.query(`INSERT INTO ${ident(item.t)} SELECT * FROM json_populate_record(NULL::${ident(item.t)}, $1) ON CONFLICT DO NOTHING`, [JSON.stringify(item.r)]);
            await client.query('RELEASE SAVEPOINT row');
          } catch (e) {
            await client.query('ROLLBACK TO SAVEPOINT row');
            if (e.code !== '23503') throw e;
            later.push(item);
          }
        }
        if (later.length === todo.length) throw new Error('some linked records are missing');
        todo = later;
      }
      for (const l of t.relinks || []) {
        await client.query(`UPDATE ${ident(l.t)} SET ${ident(l.col)} = $2 WHERE id::text = $1 AND ${ident(l.col)} IS NULL`, [String(l.id), l.val]);
      }
    }
    await client.query('DELETE FROM crm_trash WHERE id = $1', [t.id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw err(`It couldn’t be put back (${e.message}). Nothing was changed.`, 409);
  } finally { client.release(); }
  return { kind: t.kind, label: t.label, id: t.root_id, name: k ? k.name : t.kind };
}

// Keeps a copy, runs the delete, and drops the copy again if the delete didn't
// happen (not found, not allowed). Returns the bin entry's id for "Undo", or null.
async function around({ tenantId, kind, id, userId = null }, fn) {
  const binId = await keep({ tenantId, kind, id, userId }).catch(e => { console.error('[crmTrash] keep failed:', e.message); return null; });
  let ok;
  try { ok = await fn(); } catch (e) { if (binId) await query('DELETE FROM crm_trash WHERE id = $1', [binId]).catch(() => {}); throw e; }
  if (ok === false) { if (binId) await query('DELETE FROM crm_trash WHERE id = $1', [binId]).catch(() => {}); return { ok: false, undo: null }; }
  return { ok: true, undo: binId };
}

// Gone for good: one item now, or everything older than 30 days.
async function purge({ tenantId = null, id = null } = {}) {
  const gone = id
    ? (await query('DELETE FROM crm_trash WHERE id::text = $1 AND tenant_id = $2 RETURNING tenant_id, rows', [String(id), tenantId])).rows
    : (await query(`DELETE FROM crm_trash WHERE deleted_at < now() - ($1 || ' days')::interval RETURNING tenant_id, rows`, [String(DAYS)])).rows;
  // Files that were also in Google Drive go to Drive's own trash now.
  for (const g of gone) {
    for (const x of (g.rows || []).filter(x => x.t === 'crm_files' && x.r && x.r.drive_id)) {
      await require('./crmDrive').trashFile(g.tenant_id, x.r).catch(e => console.error('[crmTrash] Drive trash failed:', e.message));
    }
  }
  return gone.length;
}
async function entry(tenantId, id) {
  return (await query('SELECT id, kind, label, deleted_by FROM crm_trash WHERE id::text = $1 AND tenant_id = $2', [String(id), tenantId]).catch(() => ({ rows: [] }))).rows[0] || null;
}

module.exports = { DAYS, KINDS, keep, around, list, restore, purge, entry, snapshot };
