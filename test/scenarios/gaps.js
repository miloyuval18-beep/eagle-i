// What no other test reached: deleting, archiving and undoing things, lead
// emails forwarded in, the weekly owner report, the sub's page link by email,
// playbook previews, Today's done/snooze, and the AI message limit. Each one
// works on its own company and does nothing to another.
const { R } = require('./_local');
const assert = require('assert/strict');
const crypto = require('crypto');
delete process.env.RESEND_API_KEY; delete process.env.ANTHROPIC_API_KEY;
const sent = [];
const realEmail = require(R + '/lib/email');
require.cache[require.resolve(R + '/lib/email')].exports = { ...realEmail, sendEmail: async (m) => { sent.push(m); return { id: 'e' + sent.length }; } };
const { query, pool } = require(R + '/db');
const L = (m) => require(R + '/lib/' + m);
const crm = L('crm'), jobs = L('crmJobs'), tasks = L('crmTasks'), pay = L('crmPayments'), est = L('crmEstimates');

(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Gaps Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  const t2 = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Other Gaps Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, phone, email, address) VALUES ($1, '713-555-0100', 'office@gaps.test', '1 Main St, Houston TX 77002')`, [t]);
    const owner = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'moran@gaps.test', 'x', 'Moran', 'owner') RETURNING id`, [t])).rows[0].id;
    const deal = await crm.createDeal({ tenantId: t, name: 'Ana Ruiz', email: 'ana@owner.test', title: 'Ruiz kitchen', userId: owner, ownerUserId: owner });

    // 1. Deleting and archiving: own company yes, another company's ids no.
    const task = await tasks.createTask({ tenantId: t, dealId: deal.id, title: 'Overdue thing', dueAt: new Date(Date.now() - 86400000), assigneeUserId: owner });
    assert.equal(await tasks.overdueCount(t, owner), 1);
    assert.equal(await tasks.deleteTask({ tenantId: t2, id: task.id }), false, 'not from another company');
    assert.equal(await tasks.deleteTask({ tenantId: t, id: task.id }), true);
    assert.equal(await tasks.overdueCount(t, owner), 0);
    const item = await jobs.saveItem({ tenantId: t, dealId: deal.id, body: { title: 'Paint' } });
    assert.equal(await jobs.deleteItem({ tenantId: t2, id: item.id }), false);
    assert.equal(await jobs.deleteItem({ tenantId: t, id: item.id }), true);
    const v = await jobs.saveVendor({ tenantId: t, body: { name: 'Gulf Framing', email: 'gulf@sub.test' } });
    assert.equal(await jobs.archiveVendor({ tenantId: t2, id: v.id }), false);
    assert.equal(await jobs.archiveVendor({ tenantId: t, id: v.id }), true);
    assert.equal((await query('SELECT archived FROM crm_vendors WHERE id = $1', [v.id])).rows[0].archived, true);
    const sel = await jobs.saveSelection({ tenantId: t, dealId: deal.id, body: { category: 'Tile', options: [{ name: 'A', price: 0 }] } });
    await query('UPDATE crm_selections SET chosen_index = 0, chosen_at = now() WHERE id = $1', [sel.id]);
    assert.equal(await jobs.clearChoice({ tenantId: t2, id: sel.id }), false);
    assert.equal(await jobs.clearChoice({ tenantId: t, id: sel.id }), true);
    assert.equal((await query('SELECT chosen_index FROM crm_selections WHERE id = $1', [sel.id])).rows[0].chosen_index, null);
    const cat = await est.saveCatalogItem({ tenantId: t, body: { name: 'Drywall sheet', unit: 'ea', unit_cost: 12, category: 'materials' } });
    assert.ok((await est.listCatalog(t)).some(c => c.id === cat.id));
    assert.equal((await est.listCatalog(t2)).length, 0);
    await est.archiveCatalogItem({ tenantId: t2, id: cat.id });
    assert.ok((await est.listCatalog(t)).some(c => c.id === cat.id), 'another company can’t archive it');
    await est.archiveCatalogItem({ tenantId: t, id: cat.id });
    assert.ok(!(await est.listCatalog(t)).some(c => c.id === cat.id));
    const e1 = await est.createEstimate({ tenantId: t, dealId: deal.id, userId: owner });
    assert.equal((await est.listEstimates(t, { dealId: deal.id })).length, 1);
    await assert.rejects(est.deleteEstimate({ tenantId: t2, id: e1.id }), /Only drafts/);
    await query(`UPDATE crm_estimates SET status = 'sent' WHERE id = $1`, [e1.id]);
    await assert.rejects(est.deleteEstimate({ tenantId: t, id: e1.id }), /Only drafts/, 'a sent estimate stays');
    await query(`UPDATE crm_estimates SET status = 'draft' WHERE id = $1`, [e1.id]);
    await est.deleteEstimate({ tenantId: t, id: e1.id });
    assert.equal((await est.listEstimates(t)).length, 0);
    const cost = await L('crmCosts').addCost({ tenantId: t, dealId: deal.id, amount: 50, description: 'Screws' });
    assert.ok((await L('crmCosts').overview(t)));
    assert.ok(!(await L('crmCosts').deleteCost({ tenantId: t2, id: cost.id })));
    assert.ok(await L('crmCosts').deleteCost({ tenantId: t, id: cost.id }));
    const partner = await L('crmLifetime').savePartner({ tenantId: t, body: { name: 'Realtor Rita', kind: 'realtor' } });
    await assert.rejects(L('crmLifetime').setReferrer({ tenantId: t2, dealId: deal.id, partnerId: partner.id }), /Partner not found/);
    await L('crmLifetime').setReferrer({ tenantId: t, dealId: deal.id, partnerId: partner.id });
    assert.equal((await query('SELECT partner_id FROM crm_deals WHERE id = $1', [deal.id])).rows[0].partner_id, partner.id);
    await L('crmLifetime').archivePartner({ tenantId: t, id: partner.id });
    const home = await L('crmLifetime').saveHomeItem({ tenantId: t, dealId: deal.id, body: { name: 'Water heater', category: 'appliance' } });
    await L('crmLifetime').deleteHomeItem({ tenantId: t2, id: home.id });
    assert.ok((await query('SELECT 1 FROM crm_home_items WHERE id = $1', [home.id])).rows.length, 'another company can’t delete it');
    await L('crmLifetime').deleteHomeItem({ tenantId: t, id: home.id });
    assert.ok(!(await query('SELECT 1 FROM crm_home_items WHERE id = $1', [home.id])).rows.length);
    const product = await L('crmProducts').saveProduct({ tenantId: t, body: { name: 'Quartz', category: 'Counters', price: 60 } });
    assert.equal(await L('crmProducts').productPhoto(t2, product.id), null, 'no photo for another company');
    await L('crmProducts').archiveProduct({ tenantId: t, id: product.id });
    const punch = await L('crmPhotoAi').addPunch({ tenantId: t, dealId: deal.id, issue: 'Scuff on door', location: 'Hall' });
    assert.ok((await L('crmPhotoAi').listPunch(t, deal.id)).some(p => p.id === punch.id));
    assert.equal((await L('crmPhotoAi').listPunch(t2, deal.id)).length, 0);
    await assert.rejects(L('crmPhotoAi').addPunch({ tenantId: t2, dealId: deal.id, issue: 'x' }), /not found/i);
    const spend = await L('crmMarketing').saveSpend({ tenantId: t, source: 'google_ads', month: '2026-09', amount: 500 });
    await L('crmMarketing').deleteSpend({ tenantId: t2, id: spend.id });
    assert.equal((await L('crmMarketing').listSpend(t)).length, 1);
    await L('crmMarketing').deleteSpend({ tenantId: t, id: spend.id });
    assert.equal((await L('crmMarketing').listSpend(t)).length, 0);
    assert.deepEqual(await L('crmAssist').listImports(t2), []);
    assert.deepEqual(await L('crmEstimateAi').listTakeoffs(t2, deal.id), []);
    assert.equal(await L('crmSubs').subConfirmOn(t), false);

    // 2. Cancelling invoices: not a paid one, never another company's.
    const inv = await pay.createInvoice({ tenantId: t, dealId: deal.id, title: 'Deposit', amount: 1000, userId: owner });
    await assert.rejects(pay.voidInvoice({ tenantId: t2, id: inv.id }), /not found/);
    await pay.voidInvoice({ tenantId: t, id: inv.id, userId: owner });
    assert.equal((await query('SELECT status FROM crm_invoices WHERE id = $1', [inv.id])).rows[0].status, 'void');
    const inv2 = await pay.createInvoice({ tenantId: t, dealId: deal.id, title: 'Final', amount: 2000, userId: owner });
    await query(`UPDATE crm_invoices SET status = 'paid' WHERE id = $1`, [inv2.id]);
    await assert.rejects(pay.voidInvoice({ tenantId: t, id: inv2.id }), /paid invoice/);

    // 3. Today: done and snooze, only your own company's items, and nothing else.
    await crm.addInboxItem({ tenantId: t, dealId: deal.id, kind: 'note', title: 'Look at this', dedupeKey: 'gap1' });
    const ib = (await query(`SELECT id FROM crm_inbox WHERE tenant_id = $1 AND dedupe_key = 'gap1'`, [t])).rows[0].id;
    assert.equal(await crm.actOnInbox({ tenantId: t2, id: ib, action: 'done' }), false);
    assert.equal(await crm.actOnInbox({ tenantId: t, id: ib, action: 'snooze', days: 99 }), true, 'odd snooze lengths become 1 day');
    assert.ok(!(await crm.listInbox(t)).some(i => i.id === ib), 'snoozed items leave Today');
    assert.equal(await crm.actOnInbox({ tenantId: t, id: ib, action: 'done' }), true);
    await assert.rejects(crm.actOnInbox({ tenantId: t, id: ib, action: 'explode' }), /Unknown action/);

    // 4. A lead email forwarded to the company's own address becomes a deal; the rest don't.
    const intake = L('crmIntake');
    const key = await intake.getIntakeKey(t);
    const houzz = { subject: 'New message from a Houzz user', from: 'no-reply@houzz.com', text: 'Name: Priya Shah\nEmail: priya@owner.test\nPhone: 713-555-0142\nWe want to remodel our kitchen this spring.' };
    const r1 = await intake.intakeEmail({ key, full: houzz, baseUrl: 'https://app.test' });
    assert.equal(r1.ok, true);
    const lead = await crm.getDeal(t, r1.dealId);
    assert.equal(lead.contact_email || lead.email || (await query('SELECT c.email FROM crm_contacts c JOIN crm_deals d ON d.contact_id = c.id WHERE d.id = $1', [r1.dealId])).rows[0].email, 'priya@owner.test');
    assert.equal((await query('SELECT source FROM crm_deals WHERE id = $1', [r1.dealId])).rows[0].source, 'houzz');
    assert.equal((await intake.intakeEmail({ key, full: { subject: 'Your invoice', from: 'billing@vendor.test', text: 'Thanks for your payment.' } })).reason, 'not_a_lead');
    assert.equal((await intake.intakeEmail({ key: 'nope', full: houzz })).reason, 'unknown_key');
    assert.equal((await intake.parseLeadEmail({ subject: 'Angi lead', from: 'leads@angi.com', text: 'Call 832-555-0199 about a bath' })).source, 'angi');

    // 5. The sub's page link by email, playbook previews, the weekly owner report.
    const v2 = await jobs.saveVendor({ tenantId: t, body: { name: 'Bright Electric', email: 'jobs@bright.test', contact_name: 'Bo' } });
    const v3 = await jobs.saveVendor({ tenantId: t, body: { name: 'No Email Plumbing' } });
    sent.length = 0;
    assert.equal((await L('crmSubPortal').emailLink({ tenantId: t, vendorId: v2.id, baseUrl: 'https://app.test' })).to, 'jobs@bright.test');
    assert.match(sent[0].text, /https:\/\/app\.test\/s\/[0-9a-f]+/);
    await assert.rejects(L('crmSubPortal').emailLink({ tenantId: t, vendorId: v3.id, baseUrl: 'x' }), /email address first/);
    await assert.rejects(L('crmSubPortal').emailLink({ tenantId: t2, vendorId: v2.id, baseUrl: 'x' }), /not found/);
    const pbs = await L('crmPlaybooks').listPlaybooks(t);
    sent.length = 0;
    const pv = await L('crmPlaybooks').sendPreview({ tenantId: t, id: pbs[0].id, baseUrl: 'https://app.test', send: async (m) => { sent.push(m); } });
    assert.equal(pv.to, 'office@gaps.test'); assert.match(sent[0].subject, /^\[Preview\]/);
    await assert.rejects(L('crmPlaybooks').sendPreview({ tenantId: t2, id: pbs[0].id }), /not found/i);
    await L('crmPlaybooks').resetPlaybook({ tenantId: t, id: pbs[0].id });
    // Monday 9am Central: one report per company, once.
    const sunday = new Date('2026-10-26T14:00:00Z'); // Monday 9am Central
    const reportsSent = [];
    await L('crmReports').processWeeklyReports({ now: sunday, send: async (m) => reportsSent.push(m), appUrl: 'https://app.test' });
    await L('crmReports').processWeeklyReports({ now: sunday, send: async (m) => reportsSent.push(m), appUrl: 'https://app.test' });
    assert.equal(reportsSent.filter(m => m.to === 'moran@gaps.test').length, 1, 'once per week');
    const wk = (await query('SELECT week_start FROM crm_weekly_summaries WHERE tenant_id = $1', [t])).rows[0];
    assert.ok(await L('crmReports').getReport(t, wk.week_start.toISOString ? wk.week_start.toISOString().slice(0, 10) : wk.week_start) !== undefined);
    assert.equal(await L('crmReports').getReport(t2, '2026-10-19'), null);

    // 6. Google: one person's mailbox switched off, then the whole connection removed.
    await query(`INSERT INTO crm_google_connections (tenant_id, kind, domain, admin_email, status) VALUES ($1, 'workspace', 'gaps.test', 'moran@gaps.test', 'connected')`, [t]);
    const mb = (await query(`INSERT INTO crm_mailboxes (tenant_id, email, included) VALUES ($1, 'moran@gaps.test', true) RETURNING id`, [t])).rows[0].id;
    assert.equal(await L('crmGoogle').setIncluded({ tenantId: t2, id: mb, included: false }), false);
    assert.equal(await L('crmGoogle').setIncluded({ tenantId: t, id: mb, included: false }), true);
    await L('crmGoogle').disconnect(t);
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM crm_mailboxes WHERE tenant_id = $1', [t])).rows[0].n, 0);

    // 7. The AI message limit only bites when billing is on.
    delete process.env.STRIPE_SECRET_KEY;
    await L('crmBilling').checkAi(t);
    console.log('GAPS SCENARIO PASSED');
  } catch (e) {
    console.error('GAPS SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[t, t2]]).catch(() => {});
    await pool.end();
  }
})();
