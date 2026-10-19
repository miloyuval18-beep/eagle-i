process.env.ANTHROPIC_API_KEY = 'test-only';
const assert = require('assert/strict');
const { R } = require('./_local');
// Stand-in for the AI: answers like the real model would for this note.
require.cache[require.resolve(R + '/lib/anthropic')] = { exports: { generateJSON: async (prompt) => { assert.match(prompt, /about 150k/); return { value: 150000, next_step: 'Send the design agreement', next_step_due: '2026-10-20', site_visit: '2026-10-22T10:30' }; } } };
const { query, pool } = require(R + '/db');
const crm = require(R + '/lib/crm');
(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Voice Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    const deal = await crm.createDeal({ tenantId: t, name: 'Garcias', email: 'g@x.test' });
    const r = await crm.addNote({ tenantId: t, dealId: deal.id, body: 'Met the Garcias, kitchen and primary bath, about 150k. Visit Thursday 10:30. Send the design agreement Monday.', pickOut: true });
    assert.equal(r.picked.length, 3, JSON.stringify(r));
    const d = await crm.getDeal(t, deal.id);
    assert.equal(Number(d.value), 150000);
    assert.equal(d.stage, 'site_visit', 'booking the visit moved the deal');
    assert.equal(new Date(d.site_visit_at).toISOString(), '2026-10-22T15:30:00.000Z', '10:30 Central');
    const tasks = (await query('SELECT title, source, due_at FROM crm_tasks WHERE deal_id = $1 ORDER BY created_at', [deal.id])).rows;
    assert.ok(tasks.some(x => x.title === 'Send the design agreement' && x.source === 'voice'));
    // A second note never overwrites a value that's already there.
    await query('UPDATE crm_deals SET value = 99000 WHERE id = $1', [deal.id]);
    await crm.addNote({ tenantId: t, dealId: deal.id, body: 'Said about 150k again', pickOut: true });
    assert.equal(Number((await crm.getDeal(t, deal.id)).value), 99000);
    console.log('VOICE SCENARIO PASSED');
  } finally { await query('DELETE FROM tenants WHERE id = $1', [t]); await pool.end(); }
})().catch(e => { console.error('FAILED', e); process.exit(1); });
