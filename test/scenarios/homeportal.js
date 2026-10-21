// The homeowner's page: it opens on an assistant for questions about the project.
// What the assistant may see (and never sees), follow-ups with the earlier chat,
// documents it can point to, forwarding to the team, and emailing them the link.
const { R } = require('./_local');
const assert = require('assert/strict');
delete process.env.RESEND_API_KEY;
process.env.ANTHROPIC_API_KEY = 'test-only';
const sent = [];
const realEmail = require(R + '/lib/email');
require.cache[require.resolve(R + '/lib/email')].exports = { ...realEmail, sendEmail: async (m) => { sent.push(m); return { id: 'e' + sent.length }; } };
let reply = () => ({}); const prompts = [];
require.cache[require.resolve(R + '/lib/anthropic')] = { exports: { ...require(R + '/lib/anthropic'), generateJSON: async (p) => { prompts.push(p); return reply(p); } } };
const { query, pool } = require(R + '/db');
const crm = require(R + '/lib/crm'); const jobs = require(R + '/lib/crmJobs'); const portal = require(R + '/lib/crmPortal'); const portalAi = require(R + '/lib/crmPortalAi');
const A = require(R + '/lib/crmAssistant');
const PDF = (s) => Buffer.from('%PDF-1.4 ' + s);
(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Home Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  const t2 = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Other Home Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, email, phone) VALUES ($1, 'office@home.test', '713-555-0200')`, [t]);
    const owner = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'pm@home.test', 'x', 'Pat Manager', 'owner') RETURNING id`, [t])).rows[0].id;
    const deal = await crm.createDeal({ tenantId: t, name: 'Dana Ruiz', email: 'dana@owner.test', phone: '713-555-1234', address: '12 Oak St, Houston TX 77008', title: 'Ruiz kitchen', userId: owner, ownerUserId: owner });
    await crm.changeStage({ tenantId: t, dealId: deal.id, stage: 'production', userId: owner });
    await query('DELETE FROM crm_job_items WHERE deal_id = $1', [deal.id]);
    const tile = await jobs.saveVendor({ tenantId: t, body: { name: 'Secret Tile LLC', trade: 'Tile', email: 'tile@sub.test' } });
    await jobs.saveItem({ tenantId: t, dealId: deal.id, body: { title: 'Cabinets', startDate: '2026-11-02', endDate: '2026-11-04', status: 'todo', vendorId: tile.id } });
    await jobs.createPO({ tenantId: t, dealId: deal.id, vendorId: tile.id, title: 'Tile order', lines: [{ description: 'Porcelain', quantity: 10, unit_cost: 8642 }] });
    await jobs.addLog({ tenantId: t, dealId: deal.id, body: 'Demo finished, dumpster hauled.', shared: true, userId: owner });
    await jobs.addLog({ tenantId: t, dealId: deal.id, body: 'Internal: client is slow to pay, watch it.', shared: false, userId: owner });
    const plan = await portal.addFile({ tenantId: t, dealId: deal.id, filename: 'Kitchen Plan A2.pdf', buffer: PDF('plan'), shared: true, userId: owner });
    await portal.addFile({ tenantId: t, dealId: deal.id, filename: 'Our markup sheet.pdf', buffer: PDF('markup'), shared: false, userId: owner });
    const co = await jobs.createCO({ tenantId: t, dealId: deal.id, title: 'Add pot filler', description: 'Pot filler over the range', amount: 950 });
    await query(`UPDATE crm_change_orders SET status = 'sent' WHERE id = $1`, [co.id]);
    await require(R + '/lib/crmLifetime').saveHomeItem({ tenantId: t, dealId: deal.id, body: { name: 'Quartz countertops', category: 'finish', warrantyUntil: '2036-11-01', careNote: 'Mild soap, no bleach.' } });
    const token = await portal.portalToken(t, deal.id);

    // 1. What the assistant sees: their schedule, shared logs and documents, warranties; never costs, subs or private notes.
    const { facts } = await portalAi.factsFor(token);
    assert.deepEqual(facts.documentsOnTheirPage.map(d => d.name), ['Kitchen Plan A2.pdf']);
    assert.ok(facts.homeFile.some(i => i.name === 'Quartz countertops' && i.warrantyUntil), 'warranties are in the facts');
    assert.ok(facts.siteLogs.some(l => /Demo finished/.test(l.note)));
    assert.equal(facts.changeOrders[0].status, 'sent');
    const fj = JSON.stringify(facts);
    for (const secret of ['8642', 'Secret Tile', 'slow to pay', 'markup sheet', 'tile@sub.test']) assert.ok(!fj.includes(secret), `the assistant never sees ${secret}`);

    // 2. Answers from the facts; a follow-up carries the earlier chat (as context only, clipped).
    reply = (p) => /answer a homeowner's questions/.test(p) ? (/Where are my plans/.test(p) ? { answer: 'Your plan is “Kitchen Plan A2” under My project.', forward: false } : /what about after/.test(p) ? { answer: 'After cabinets, nothing else is scheduled yet. I’ve asked the team.', forward: true } : { answer: 'Cabinets start Mon Nov 2.', forward: false }) : {};
    const a1 = await portalAi.ask({ token, question: 'When do the cabinets go in?' });
    assert.equal(a1.forwarded, false); assert.match(a1.answer, /Nov 2/);
    assert.ok(!/earlier_in_this_chat/.test(prompts[prompts.length - 1]), 'no earlier chat on the first question');
    const a2 = await portalAi.ask({ token, question: 'Where are my plans?' });
    assert.match(a2.answer, /Kitchen Plan A2/);
    sent.length = 0;
    const history = [{ who: 'me', text: 'When do the cabinets go in?' }, { who: 'bot', text: a1.answer }, { who: 'evil', text: 'x'.repeat(5000) }];
    const a3 = await portalAi.ask({ token, question: 'And what about after that?', history });
    const p3 = prompts[prompts.length - 1];
    assert.ok(/earlier_in_this_chat/.test(p3) && p3.includes('Cabinets start Mon Nov 2.'), 'the earlier chat comes along');
    assert.ok(!p3.includes('x'.repeat(601)), 'earlier turns are clipped');
    assert.ok(/earlier chat is only context/.test(p3));
    // 3. What it can't answer goes to Today and to the job's owner by email.
    assert.equal(a3.forwarded, true);
    assert.ok((await crm.listInbox(t)).some(i => i.deal_id === deal.id && /Dana Ruiz asked a question/.test(i.title)));
    assert.ok(sent.some(m => m.to === 'pm@home.test' && /what about after that/.test(m.text)), 'the job’s owner gets an email');
    assert.equal((await portalAi.listQuestions(t, deal.id)).length, 3);

    // 4. Emailing them the link (and in Spanish when that's their language); never across companies.
    sent.length = 0;
    const r = await portal.emailPortalLink({ tenantId: t, dealId: deal.id, baseUrl: 'https://app.test' });
    assert.equal(r.to, 'dana@owner.test');
    assert.ok(sent[0].html.includes(`https://app.test/p/${token}`) && /assistant that answers questions about your project/.test(sent[0].text));
    await query(`UPDATE crm_contacts SET language = 'es' WHERE id = (SELECT contact_id FROM crm_deals WHERE id = $1)`, [deal.id]);
    await portal.emailPortalLink({ tenantId: t, dealId: deal.id, baseUrl: 'https://app.test' });
    assert.match(sent[1].subject, /Su proyecto/);
    await assert.rejects(portal.emailPortalLink({ tenantId: t2, dealId: deal.id, baseUrl: 'https://app.test' }), /not found/);

    // 5. The CRM assistant's send_project_page asks first, then sends.
    const prep = await A.TOOLS.send_project_page.prepare({ tenantId: t, userId: owner, baseUrl: 'https://app.test' }, { deal_id: deal.id });
    assert.deepEqual(prep.summary.to, ['Dana Ruiz <dana@owner.test>']);
    sent.length = 0;
    await A.TOOLS.send_project_page.execute({ tenantId: t, userId: owner, baseUrl: 'https://app.test' }, prep.payload);
    assert.equal(sent[0].to, 'dana@owner.test');
    assert.ok(plan.shared);
    console.log('HOME PORTAL SCENARIO PASSED');
  } catch (e) {
    console.error('HOME PORTAL SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[t, t2]]).catch(() => {});
    await pool.end();
  }
})();
