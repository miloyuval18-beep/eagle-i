// Catching mistakes before they happen: a deal that's already in the
// pipeline (same email, phone, name or house), and stage moves that look
// wrong (signed with no signed estimate, complete with open work or unpaid
// invoices, lost after being paid, moving backwards). Never across companies.
const { R } = require('./_local');
const assert = require('assert/strict');
const crypto = require('crypto');
delete process.env.RESEND_API_KEY; delete process.env.ANTHROPIC_API_KEY;
const { query, pool } = require(R + '/db');
const crm = require(R + '/lib/crm'), jobs = require(R + '/lib/crmJobs');

(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Oops Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  const t2 = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Other Oops Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    const owner = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'moran@oops.test', 'x', 'Moran', 'owner') RETURNING id`, [t])).rows[0].id;
    const deal = await crm.createDeal({ tenantId: t, name: 'Ana Ruiz', email: 'Ana@Owner.test', phone: '(713) 555-0142', address: '12 Oak St, Houston TX 77008', title: 'Ruiz kitchen', userId: owner });

    // 1. Duplicates by email (any case), phone (any format), name, or street.
    const d = (b) => crm.findDuplicates({ tenantId: t, ...b });
    assert.equal((await d({ email: 'ana@owner.TEST' }))[0].id, deal.id);
    assert.match((await d({ email: 'ana@owner.test' }))[0].why, /same email/);
    assert.match((await d({ phone: '713.555.0142' }))[0].why, /same phone/);
    assert.match((await d({ phone: '+1 713 555 0142' }))[0].why, /same phone/);
    assert.match((await d({ name: 'ana ruiz' }))[0].why, /same name/);
    assert.match((await d({ address: '12 Oak St, Houston' }))[0].why, /same address/);
    assert.deepEqual(await d({ name: 'Bo Lee', email: 'bo@x.test' }), []);
    // Only what was typed counts: an empty box never "matches".
    const bo = await crm.createDeal({ tenantId: t, name: 'Bo Lee', title: 'Lee bath', userId: owner });
    assert.equal((await d({ name: 'bo lee' })).find(x => x.id === bo.id).why, 'same name');
    assert.equal((await d({ email: 'ana@owner.test' })).find(x => x.id === deal.id).why, 'same email');
    assert.deepEqual(await d({ name: 'An' }), [], 'too little to go on');
    assert.deepEqual(await crm.findDuplicates({ tenantId: t2, email: 'ana@owner.test' }), [], 'never another company’s');
    assert.equal((await d({ email: 'ana@owner.test' }))[0].stage, 'New lead');

    // 2. Stage moves that look wrong.
    const w = (stage, id = deal.id, tenant = t) => crm.stageWarnings({ tenantId: tenant, dealId: id, stage });
    assert.match((await w('signed')).join(), /no estimate/i);
    const est = await require(R + '/lib/crmEstimates').createEstimate({ tenantId: t, dealId: deal.id, userId: owner });
    assert.match((await w('signed')).join(), /signed by the homeowner yet/);
    await query(`UPDATE crm_estimates SET status = 'accepted' WHERE id = $1`, [est.id]);
    assert.deepEqual(await w('signed'), [], 'a signed estimate: nothing to warn about');
    await crm.changeStage({ tenantId: t, dealId: deal.id, stage: 'production', userId: owner });
    await query('DELETE FROM crm_job_items WHERE deal_id = $1', [deal.id]);
    await jobs.saveItem({ tenantId: t, dealId: deal.id, body: { title: 'Paint' } });
    await require(R + '/lib/crmPhotoAi').addPunch({ tenantId: t, dealId: deal.id, issue: 'Scuff on door' });
    const inv = await require(R + '/lib/crmPayments').createInvoice({ tenantId: t, dealId: deal.id, title: 'Final', amount: 4200, userId: owner });
    const done = (await w('complete')).join(' | ');
    assert.match(done, /1 phase isn’t marked done/); assert.match(done, /1 punch list item is still open/); assert.match(done, /1 invoice \(\$4,200\) isn’t paid/);
    await query(`UPDATE crm_invoices SET status = 'paid' WHERE id = $1`, [inv.id]);
    const lost = (await w('lost')).join(' | ');
    assert.match(lost, /already paid an invoice/); assert.match(lost, /already under contract/);
    assert.match((await w('qualified')).join(), /moves it back from “In production”/);
    assert.deepEqual(await w('signed', deal.id, t2), [], 'another company gets nothing');
    console.log('MISTAKES SCENARIO PASSED');
  } catch (e) {
    console.error('MISTAKES SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[t, t2]]).catch(() => {});
    await pool.end();
  }
})();
