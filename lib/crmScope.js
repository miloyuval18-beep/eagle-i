// Who sees which projects: people without "See every project" (project managers, by
// default) see only the projects they manage or handle, or that someone under them
// does (lib/crmTeam.js projectScope). Enforced once, for every /api/crm screen:
//  - opening a project they can't see (/api/crm/deals/:id…) is "not found";
//  - anything sent back that belongs to one (a deal, job, task, invoice, file,
//    estimate, event… anything carrying its id) is taken out of the lists;
//  - a single item that belongs to one is "not found".
const { query } = require('../db');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function scopeFor(tenantId, user) {
  const allowed = await require('./crmTeam').projectScope(tenantId, user);
  if (!allowed) return null;
  const every = new Set((await query(`SELECT id FROM crm_deals WHERE tenant_id = $1`, [tenantId])).rows.map(r => r.id));
  const hidden = (id) => typeof id === 'string' && every.has(id) && !allowed.has(id);
  return { allowed, every, hidden };
}

// Is this object about a project they can't see?
function hides(scope, o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  return scope.hidden(o.deal_id) || scope.hidden(o.dealId) || scope.hidden(o.id) || scope.hidden(o.mail_deal_id);
}
function prune(scope, v, depth = 0) {
  if (depth > 8 || v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.filter(x => !hides(scope, x)).map(x => prune(scope, x, depth + 1));
  if (v instanceof Date) return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = hides(scope, x) ? null : prune(scope, x, depth + 1);
  return out;
}
// The pipeline's counts and totals, from what's left.
function recount(b) {
  if (!b || !Array.isArray(b.deals) || !b.counts) return b;
  const counts = Object.fromEntries(Object.keys(b.counts).map(k => [k, 0]));
  const values = b.values ? Object.fromEntries(Object.keys(b.values).map(k => [k, 0])) : null;
  for (const d of b.deals) { counts[d.stage] = (counts[d.stage] || 0) + 1; if (values) values[d.stage] = (values[d.stage] || 0) + Number(d.value || 0); }
  const out = { ...b, counts, ...(values ? { values } : {}) };
  if (typeof b.openValue === 'number') out.openValue = b.deals.filter(d => !['signed', 'production', 'complete', 'lost'].includes(d.stage)).reduce((n, d) => n + Number(d.value || 0), 0);
  return out;
}

// Express: after req.crmUser is known.
async function enforce(req, res) {
  const scope = await scopeFor(req.tenantId, req.crmUser);
  if (!scope) return true;
  req.projectScope = scope;
  const m = /^\/api\/crm\/(?:deals|jobs)\/([0-9a-f-]{36})(?:\/|$)/i.exec(req.originalUrl.split('?')[0]);
  if (m && scope.hidden(m[1].toLowerCase())) { res.status(404).json({ error: { message: 'That project isn’t one of yours.', code: 'not_yours' } }); return false; }
  // A file opened by its link (sent as the file, not a list).
  const f = /^\/api\/crm\/files\/([0-9a-f-]{36})(?:\/|$)/i.exec(req.originalUrl.split('?')[0]);
  if (f) {
    const row = (await query(`SELECT deal_id FROM crm_files WHERE id = $1 AND tenant_id = $2`, [f[1], req.tenantId]).catch(() => ({ rows: [] }))).rows[0];
    if (row && scope.hidden(row.deal_id)) { res.status(404).json({ error: { message: 'That project isn’t one of yours.', code: 'not_yours' } }); return false; }
  }
  const json = res.json.bind(res);
  res.json = (b) => {
    if (res.statusCode >= 400 || !b || typeof b !== 'object') return json(b);
    // A single thing that belongs to a project they can't see.
    for (const one of [b, b.estimate, b.invoice, b.file, b.event, b.task]) if (one && hides(scope, one) && !Array.isArray(one)) { res.status(404); return json({ error: { message: 'That project isn’t one of yours.', code: 'not_yours' } }); }
    return json(recount(prune(scope, b)));
  };
  return true;
}

module.exports = { scopeFor, prune, enforce, UUID };
