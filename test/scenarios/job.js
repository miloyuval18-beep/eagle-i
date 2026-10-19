const assert = require('assert/strict');
const { R } = require('./_local');
const { query, pool } = require(R + '/db');
const crm = require(R + '/lib/crm'); const jobs = require(R + '/lib/crmJobs');
const sent = []; const send = async (m) => { sent.push(m); return { id: 'x' }; };
(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Job Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, address) VALUES ($1, '1001 S Dairy Ashford, Houston TX 77077')`, [t]);
    const deal = await crm.createDeal({ tenantId: t, name: 'Sam Lee', title: 'Bath', stage: 'proposal', address: '9 Elm St, Houston TX 77024' });
    // A company template is used for the next job.
    await crm.changeStage({ tenantId: t, dealId: deal.id, stage: 'signed' });
    const sched = await jobs.listSchedule(t, deal.id);
    await query('DELETE FROM crm_job_items WHERE id <> ALL($1::uuid[]) AND deal_id = $2', [sched.slice(0, 3).map(s => s.id), deal.id]);
    const saved = await jobs.saveTemplateFromJob({ tenantId: t, dealId: deal.id });
    assert.equal(saved.phases, 3);
    const d2 = await crm.createDeal({ tenantId: t, name: 'Ann', title: 'Deck' });
    await crm.changeStage({ tenantId: t, dealId: d2.id, stage: 'signed' });
    assert.equal((await jobs.listSchedule(t, d2.id)).length, 3, 'uses the saved template');
    // Signing again doesn't add a second schedule.
    await crm.changeStage({ tenantId: t, dealId: d2.id, stage: 'proposal' });
    await crm.changeStage({ tenantId: t, dealId: d2.id, stage: 'signed' });
    assert.equal((await jobs.listSchedule(t, d2.id)).length, 3);
    // Purchase order email to the vendor.
    const v = await jobs.saveVendor({ tenantId: t, body: { name: 'Gulf Lumber', email: 'orders@gulf.test', insuranceExpires: '2020-01-01' } });
    const po = await jobs.createPO({ tenantId: t, dealId: deal.id, vendorId: v.id, title: 'Lumber', lines: [{ description: '2x4', quantity: 10, unit_cost: 4 }], neededBy: '2026-11-01' });
    await jobs.sendPO({ tenantId: t, id: po.id, send });
    assert.equal(sent[0].to, 'orders@gulf.test');
    assert.match(sent[0].text, /9 Elm St/); assert.match(sent[0].text, /Total: \$40\.00/);
    // Expired insurance lands in Needs you, once.
    assert.ok((await jobs.scanVendorInsurance()).flagged >= 1);
    assert.equal((await jobs.scanVendorInsurance()).flagged, 0);
    assert.ok((await crm.listInbox(t)).some(i => i.kind === 'vendor_insurance' && /Gulf Lumber/.test(i.title)));
    console.log('JOB SCENARIO PASSED');
  } finally { await query('DELETE FROM tenants WHERE id = $1', [t]); await pool.end(); }
})().catch(e => { console.error('FAILED', e); process.exit(1); });
