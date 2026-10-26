// The step-by-step tips that pop up the first time someone opens a screen
// (crm.html crGuide, crm-home.html). { seen: ['pipeline', 'deal', ...], off: true|false }
const { query } = require('../db');
const KEY = /^[a-z][a-z0-9_-]{0,39}$/;
const clean = (t) => ({ seen: Array.isArray(t && t.seen) ? t.seen.filter(k => KEY.test(String(k))).slice(0, 200) : [], off: !!(t && t.off) });

// { seen: 'key' } marks one; { off: true|false } turns them all off or on; { reset: true } shows them all again.
async function update(table, id, b = {}) {
  if (!['users', 'crm_accounts'].includes(table)) throw new Error('bad table');
  const cur = clean((await query(`SELECT tips FROM ${table} WHERE id = $1`, [id])).rows[0]?.tips);
  if (b.reset) { cur.seen = []; cur.off = false; }
  if (typeof b.off === 'boolean') cur.off = b.off;
  if (b.seen && KEY.test(String(b.seen)) && !cur.seen.includes(String(b.seen))) cur.seen.push(String(b.seen));
  await query(`UPDATE ${table} SET tips = $2 WHERE id = $1`, [id, JSON.stringify(clean(cur))]);
  return clean(cur);
}
module.exports = { clean, update };
