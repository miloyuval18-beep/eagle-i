process.env.ANTHROPIC_API_KEY = 'test-only';
const assert = require('assert/strict');
const { R } = require('./_local');
let aiCalls = 0;
require.cache[require.resolve(R + '/lib/anthropic')] = { exports: { generateJSON: async (prompt, max, opts) => { aiCalls++; assert.equal(opts.images[0].mediaType, 'image/png'); return { vendor: 'Home Depot #455', date: '2026-10-14', total: 412.37, category: 'materials', description: 'Drywall screws and mud' }; } } };
const { query, pool } = require(R + '/db');
const crm = require(R + '/lib/crm'); const est = require(R + '/lib/crmEstimates'); const jobs = require(R + '/lib/crmJobs'); const costs = require(R + '/lib/crmCosts');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Cost Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    const deal = await crm.createDeal({ tenantId: t, name: 'Pat', title: 'Kitchen', stage: 'proposal' });
    // Budget from the accepted estimate: cost 40,000, price 50,000.
    const e = await est.createEstimate({ tenantId: t, dealId: deal.id });
    await est.saveEstimate({ tenantId: t, id: e.id, body: { title: 'Kitchen', lines: [{ description: 'Everything', quantity: 1, unit_cost: 40000, markup_pct: 25 }] } });
    await query(`UPDATE crm_estimates SET status = 'sent', sent_at = now() WHERE id = $1`, [e.id]);
    await est.acceptByToken({ token: (await est.getEstimate(t, e.id)).public_token, name: 'Pat Smith' });
    let s = await costs.summary(t, deal.id);
    assert.equal(s.budget, 40000); assert.equal(s.contract, 50000); assert.equal(s.actual, 0);
    // A receipt photo: AI reads it, the photo stays team-only.
    const r = await costs.addReceipt({ tenantId: t, dealId: deal.id, filename: 'r.png', dataBase64: PNG });
    assert.equal(Number(r.cost.amount), 412.37); assert.equal(r.cost.vendor_name, 'Home Depot #455'); assert.equal(r.cost.source, 'receipt');
    assert.equal(r.file.shared, false, 'receipts are never shown to the homeowner');
    // Labor: hours × rate.
    const lab = await costs.addCost({ tenantId: t, dealId: deal.id, category: 'labor', hours: 16, rate: 45, description: 'Framing crew' });
    assert.equal(Number(lab.amount), 720);
    // A received purchase order becomes a cost, once.
    const po = await jobs.createPO({ tenantId: t, dealId: deal.id, title: 'Cabinets', lines: [{ description: 'Cabinet set', quantity: 1, unit_cost: 9000 }], category: 'materials' });
    await jobs.setPOStatus({ tenantId: t, id: po.id, status: 'sent' });
    assert.equal((await costs.summary(t, deal.id)).committed, 9000);
    await jobs.setPOStatus({ tenantId: t, id: po.id, status: 'received' });
    await jobs.setPOStatus({ tenantId: t, id: po.id, status: 'received' });
    s = await costs.summary(t, deal.id);
    assert.equal(s.actual, 10132.37);
    assert.equal(s.committed, 0);
    // An approved change order adds to the budget and the contract.
    const co = await jobs.createCO({ tenantId: t, dealId: deal.id, title: 'Pot filler', amount: 1200, cost: 600 });
    await query(`UPDATE crm_change_orders SET status = 'approved' WHERE id = $1`, [co.id]);
    await query(`UPDATE crm_deals SET value = value + 1200 WHERE id = $1`, [deal.id]);
    s = await costs.summary(t, deal.id);
    assert.equal(s.budget, 40600); assert.equal(s.contract, 51200);
    // Spending ahead of the work: 14 phases, 1 done (7%), spend pushed to 50% of budget.
    await query(`UPDATE crm_job_items SET status = 'done' WHERE id = (SELECT id FROM crm_job_items WHERE deal_id = $1 ORDER BY position LIMIT 1)`, [deal.id]);
    await costs.addCost({ tenantId: t, dealId: deal.id, category: 'subcontract', amount: 10200, description: 'Electrician' });
    s = await costs.summary(t, deal.id);
    assert.equal(s.overPace, true, JSON.stringify(s));
    assert.ok((await crm.listInbox(t)).some(i => i.kind === 'over_budget'));
    // The accountant's export.
    const csv = await costs.exportCsv({ tenantId: t, kind: 'costs', from: '2026-01-01', to: '2026-12-31' });
    assert.match(csv, /^Date,Vendor,Category,Description,Amount/);
    assert.match(csv, /"Home Depot #455"|Home Depot #455/);
    assert.match(csv, /720\.00/);
    console.log('COST SCENARIO PASSED (AI calls: ' + aiCalls + ')');
  } finally { await query('DELETE FROM tenants WHERE id = $1', [t]); await pool.end(); }
})().catch(e => { console.error('FAILED', e); process.exit(1); });
