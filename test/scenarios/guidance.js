// Guidance: one search for everything (only this company's, chats only your
// own), the next step on a deal in plain words as it moves along, and
// practice customers that can't be emailed and come out with one tap.
const { R } = require('./_local');
const assert = require('assert/strict');
const crypto = require('crypto');
delete process.env.RESEND_API_KEY; delete process.env.ANTHROPIC_API_KEY;
const { query, pool } = require(R + '/db');
const L = (m) => require(R + '/lib/' + m);
const crm = L('crm'), jobs = L('crmJobs'), search = L('crmSearch').search;

(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Guide Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  const t2 = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Other Guide Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    const owner = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'moran@guide.test', 'x', 'Moran', 'owner') RETURNING id`, [t])).rows[0].id;
    const alex = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'alex@guide.test', 'x', 'Alex', 'member') RETURNING id`, [t])).rows[0].id;
    const deal = await crm.createDeal({ tenantId: t, name: 'Ana Ruiz', email: 'ana@owner.test', phone: '713-555-0142', address: '12 Oak St, Houston TX 77008', title: 'Ruiz kitchen', userId: owner, ownerUserId: owner });
    await jobs.saveVendor({ tenantId: t, body: { name: 'Gulf Framing', trade: 'Framing', email: 'gulf@sub.test' } });
    const inv = await L('crmPayments').createInvoice({ tenantId: t, dealId: deal.id, title: 'Deposit', amount: 5000, userId: owner });
    await L('crmPortal').addFile({ tenantId: t, dealId: deal.id, filename: 'Kitchen Plan A2.pdf', buffer: Buffer.from('%PDF-1.4 x'), userId: owner });
    const chat = await L('crmAssistant').createThread({ tenantId: t, userId: owner }, 'Ruiz cabinets question');

    // 1. Search: by name, street, phone digits, invoice number, file, sub; chats only your own; never another company.
    const kinds = async (q, who = owner) => (await search({ tenantId: t, userId: who, q })).results.map(r => r.type);
    assert.ok((await kinds('ruiz')).includes('deal'));
    assert.ok((await kinds('Oak St')).includes('deal'));
    assert.ok((await kinds('0142')).includes('deal'), 'last digits of the phone');
    assert.ok((await kinds('#' + inv.number)).includes('invoice'));
    const invRes = (await search({ tenantId: t, userId: owner, q: String(inv.number) })).results.find(r => r.type === 'invoice');
    assert.match(invRes.sub, /Draft \(not sent\)/, 'statuses in plain words');
    assert.ok((await kinds('plan a2')).includes('file'));
    assert.ok((await kinds('framing')).includes('vendor'));
    assert.ok((await kinds('cabinets question')).includes('chat'));
    assert.ok(!(await kinds('cabinets question', alex)).includes('chat'), 'someone else’s chat never shows');
    assert.deepEqual((await search({ tenantId: t2, userId: owner, q: 'ruiz' })).results, [], 'never another company');
    assert.deepEqual((await search({ tenantId: t, userId: owner, q: 'r' })).results, [], 'too short');
    assert.ok(Array.isArray((await search({ tenantId: t, userId: owner, q: '%_\\' })).results), 'odd characters are just characters');

    // 2. The next step follows the deal.
    const next = async () => (await crm.nextStep(t, deal.id)).text;
    await query('UPDATE crm_deals SET first_response_at = NULL WHERE id = $1', [deal.id]); // a lead that came in by itself
    assert.match(await next(), /hasn’t heard from you yet/);
    await query('UPDATE crm_deals SET first_response_at = now(), stage = $2 WHERE id = $1', [deal.id, 'qualified']);
    assert.match(await next(), /write the estimate/);
    const est = await L('crmEstimates').createEstimate({ tenantId: t, dealId: deal.id, userId: owner });
    assert.match(await next(), new RegExp(`Estimate #${est.number} is a draft`));
    await query(`UPDATE crm_estimates SET status = 'sent', sent_at = now() - interval '6 days' WHERE id = $1`, [est.id]);
    const waiting = await crm.nextStep(t, deal.id);
    assert.match(waiting.text, /Waiting on Ana to sign/); assert.equal(waiting.tone, 'warn');
    await query(`UPDATE crm_estimates SET status = 'accepted' WHERE id = $1`, [est.id]);
    await query(`UPDATE crm_deals SET stage = 'signed' WHERE id = $1`, [deal.id]);
    await query('DELETE FROM crm_job_items WHERE deal_id = $1', [deal.id]);
    assert.match(await next(), /Lay out the job schedule/);
    await jobs.saveItem({ tenantId: t, dealId: deal.id, body: { title: 'Framing', startDate: '2026-11-02', endDate: '2026-11-04' } });
    assert.match(await next(), /Next on the job: Framing, starting Monday, Nov 2/);
    await query(`UPDATE crm_invoices SET status = 'sent', due_date = now()::date - 5 WHERE id = $1`, [inv.id]);
    assert.match(await next(), /past due/);
    await L('crmTasks').createTask({ tenantId: t, dealId: deal.id, title: 'Call the inspector', dueAt: new Date(Date.now() - 86400000), assigneeUserId: owner });
    assert.match(await next(), /Overdue: “Call the inspector”/, 'an overdue task comes first');
    assert.equal(await crm.nextStep(t2, deal.id), null, 'another company gets nothing');

    // 3. Practice customers: no email addresses, a job with a schedule, all removed with one tap.
    const as = L('crmAssist');
    const p = await as.practiceStart({ tenantId: t, userId: owner });
    assert.equal(p.deals, 4);
    await assert.rejects(as.practiceStart({ tenantId: t, userId: owner }), /already/);
    const prac = (await query(`SELECT d.id, d.title, c.email FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id WHERE d.import_id = $1`, [p.id])).rows;
    assert.equal(prac.length, 4);
    assert.ok(prac.every(x => x.email === null && /\(practice\)/.test(x.title)), 'never an email address on a practice customer');
    const job = prac.find(x => /Whole-home/.test(x.title));
    assert.ok((await query('SELECT COUNT(*)::int AS n FROM crm_job_items WHERE deal_id = $1', [job.id])).rows[0].n >= 3);
    const r = await as.practiceRemove(t);
    assert.equal(r.removed, 4);
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM crm_deals WHERE tenant_id = $1 AND title LIKE '%(practice)%'`, [t])).rows[0].n, 0);
    assert.equal((await as.practiceInfo(t)).on, false);
    assert.ok(await crm.getDeal(t, deal.id), 'real customers stay');
    console.log('GUIDANCE SCENARIO PASSED');
  } catch (e) {
    console.error('GUIDANCE SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[t, t2]]).catch(() => {});
    await pool.end();
  }
})();
