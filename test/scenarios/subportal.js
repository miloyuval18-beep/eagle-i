// The subs' page: what a sub sees (and never sees), files, the job assistant,
// messages to the office, links in their emails.
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
const crm = require(R + '/lib/crm'); const jobs = require(R + '/lib/crmJobs'); const portal = require(R + '/lib/crmPortal'); const sp = require(R + '/lib/crmSubPortal'); const bids = require(R + '/lib/crmBids');
const PDF = (s) => Buffer.from('%PDF-1.4 ' + s);
(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Sub Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  const t2 = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Other Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, email, phone, address) VALUES ($1, 'office@sub.test', '713-555-0100', '1 Main St, Houston TX 77002')`, [t]);
    const owner = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'moran@sub.test', 'x', 'Moran Levi', 'owner') RETURNING id`, [t])).rows[0].id;
    const job = await crm.createDeal({ tenantId: t, name: 'Maria Garcia', email: 'maria.private@home.test', phone: '713-555-9999', address: '55 Elm St, Houston TX 77007', title: 'Garcia bath', userId: owner, ownerUserId: owner });
    await crm.changeStage({ tenantId: t, dealId: job.id, stage: 'production', userId: owner });
    const bidding = await crm.createDeal({ tenantId: t, name: 'Bo Lee', email: 'bo@home.test', address: '9 Pine St, Katy TX 77494', title: 'Lee kitchen', userId: owner });
    const lost = await crm.createDeal({ tenantId: t, name: 'Al Lost', email: 'al@home.test', title: 'Lost deck', userId: owner });
    const tile = await jobs.saveVendor({ tenantId: t, body: { name: 'Coastal Tile', trade: 'Tile', email: 'tile@sub.test', phone: '832-555-0101' } });
    const rival = await jobs.saveVendor({ tenantId: t, body: { name: 'Rival Tile', trade: 'Tile', email: 'rival@sub.test' } });
    await query('DELETE FROM crm_job_items WHERE deal_id = $1', [job.id]);
    await jobs.saveItem({ tenantId: t, dealId: job.id, body: { title: 'Demolition', startDate: '2026-11-02', endDate: '2026-11-03', status: 'done' } });
    await jobs.saveItem({ tenantId: t, dealId: job.id, body: { title: 'Shower tile', startDate: '2026-11-09', endDate: '2026-11-11', status: 'todo', vendorId: tile.id } });
    await jobs.createPO({ tenantId: t, dealId: job.id, vendorId: tile.id, title: 'Thinset and grout', lines: [{ description: 'Thinset', quantity: 6, unit_cost: 32 }] });
    await query(`INSERT INTO crm_bid_requests (tenant_id, deal_id, vendor_id, token, scope, file_ids, status, amount) VALUES ($1, $2, $3, $4, 'Tile', '{}', 'submitted', 7777)`, [t, job.id, rival.id, require('crypto').randomBytes(24).toString('hex')]);
    const plan = await portal.addFile({ tenantId: t, dealId: job.id, filename: 'A1 Bath Plan.pdf', buffer: PDF('plan'), userId: owner });
    const contract = await portal.addFile({ tenantId: t, dealId: job.id, filename: 'Signed contract.pdf', buffer: PDF('contract'), userId: owner });
    assert.equal(plan.sub_shared, true, 'plans go to subs by default'); assert.equal(contract.sub_shared, false, 'contracts don’t');
    await jobs.saveSelection({ tenantId: t, dealId: job.id, body: { category: 'Shower wall tile', options: [{ name: 'Zellige white 4x4', price: 1800 }, { name: 'Subway', price: 600 }] } });
    await query(`UPDATE crm_selections SET chosen_index = 0, chosen_at = now() WHERE deal_id = $1`, [job.id]);
    const co = await jobs.createCO({ tenantId: t, dealId: job.id, title: 'Add a niche', description: 'Recessed niche 12x24 on the back wall', amount: 4321 });
    await query(`UPDATE crm_change_orders SET status = 'approved', approved_at = now() WHERE id = $1`, [co.id]);
    await query(`INSERT INTO crm_punch_items (tenant_id, deal_id, location, issue, trade) VALUES ($1, $2, 'Shower', 'Regrout the corner', 'Tile'), ($1, $2, 'Kitchen', 'Touch up paint', 'Paint')`, [t, job.id]);
    // bidding on another job, a lost one, and another company's job with the same email
    const bidFile = await portal.addFile({ tenantId: t, dealId: bidding.id, filename: 'Kitchen plan.pdf', buffer: PDF('kitchen'), userId: owner });
    await bids.sendBidRequests({ tenantId: t, dealId: bidding.id, vendorIds: [tile.id], scope: 'Backsplash 40 sf', fileIds: [bidFile.id], baseUrl: 'https://app.test', send: async (m) => { sent.push(m); } });
    await jobs.saveItem({ tenantId: t, dealId: lost.id, body: { title: 'Deck tile', startDate: '2026-12-01', endDate: '2026-12-02', status: 'todo', vendorId: tile.id } });
    await query(`UPDATE crm_deals SET stage = 'lost' WHERE id = $1`, [lost.id]);

    // 1. The bid email already carries their page link.
    assert.ok(sent.some(m => /\/s\/[0-9a-f]{48}/.test(m.html) && /assistant for questions about the job/.test(m.text)), 'bid request links their page');
    const token = await sp.subToken(t, tile.id);

    // 2. What they see.
    const { view } = await sp.subView(token, { baseUrl: 'https://app.test' });
    assert.equal(view.jobs.length, 2, 'the job and the bid, not the lost one');
    const j = view.jobs.find(x => x.title === 'Garcia bath'), b = view.jobs.find(x => x.title === 'Lee kitchen');
    assert.equal(j.status, 'on'); assert.equal(j.address, '55 Elm St, Houston TX 77007');
    assert.deepEqual(j.myPhases.map(p => p.title), ['Shower tile']); assert.equal(j.schedule.length, 2);
    assert.deepEqual(j.files.map(f => f.name), ['A1 Bath Plan.pdf']);
    assert.equal(j.selections[0].chosen, 'Zellige white 4x4');
    assert.equal(j.changes[0].title, 'Add a niche'); assert.equal(j.changes[0].details, 'Recessed niche 12x24 on the back wall');
    assert.equal(j.myPurchaseOrders[0].total, 192);
    assert.deepEqual(j.punchForMyTrade.map(p => p.item), ['Regrout the corner'], 'only punch items for their trade');
    assert.equal(j.contact.name, 'Moran Levi');
    assert.equal(b.status, 'bidding'); assert.equal(b.area, 'Katy TX 77494'); assert.ok(!('address' in b), 'no street before they win it');
    assert.deepEqual(b.files.map(f => f.name), ['Kitchen plan.pdf']);
    const all = JSON.stringify(view);
    for (const secret of ['maria.private@home.test', '713-555-9999', '7777', '4321', 'Rival Tile', 'Signed contract', '9 Pine St', 'Lost deck']) assert.ok(!all.includes(secret), `never shows ${secret}`);

    // 3. Files: only what's shared with them.
    assert.ok(await sp.subFile(token, plan.id)); assert.ok(await sp.subFile(token, bidFile.id));
    assert.equal(await sp.subFile(token, contract.id), null);
    await portal.updateFile({ tenantId: t, id: contract.id, subShared: true });
    assert.ok(await sp.subFile(token, contract.id), 'the team can share any file');
    await portal.updateFile({ tenantId: t, id: contract.id, subShared: false });
    assert.equal(await sp.subFile('f'.repeat(48), plan.id), null);

    // 4. The job assistant: answers from the facts; anything else goes to the office.
    reply = (p) => /subcontractor/.test(p) ? (/When do I start/.test(p) ? { answer: 'You start the shower tile at the Garcia bath on Mon Nov 9.', forward: false, job: 'Garcia bath' } : { answer: 'I’ve passed that to the office.', forward: true, job: 'Garcia bath' }) : {};
    const a1 = await sp.ask({ token, question: 'When do I start?' });
    assert.equal(a1.forwarded, false); assert.match(a1.answer, /Nov 9/);
    const facts = prompts[prompts.length - 1];
    for (const secret of ['maria.private@home.test', '713-555-9999', '7777', '4321']) assert.ok(!facts.includes(secret), `the assistant never sees ${secret}`);
    sent.length = 0;
    const a2 = await sp.ask({ token, question: 'Can I start a day early?' });
    assert.equal(a2.forwarded, true);
    const item = (await crm.listInbox(t)).find(i => i.kind === 'sub_question');
    assert.ok(item && item.deal_id === job.id && /Coastal Tile asked about Garcia bath/.test(item.title));
    assert.ok(sent.some(m => m.to === 'moran@sub.test' && /Can I start a day early/.test(m.text)), 'the job’s owner gets an email');
    await sp.message({ token, text: 'Tile is on site.', dealId: job.id });
    assert.ok((await crm.listInbox(t)).some(i => /Message from Coastal Tile about Garcia bath/.test(i.title)));
    assert.equal((await sp.listQuestions(t, tile.id)).length, 2);

    // 5. Their other emails carry the link too; a new link retires the old one.
    sent.length = 0;
    const po = (await jobs.listPOs(t, job.id))[0];
    await jobs.sendPO({ tenantId: t, id: po.id, send: async (m) => sent.push(m), baseUrl: 'https://app.test' });
    assert.ok(sent[0].html.includes(`/s/${token}`));
    const fresh = await sp.resetToken(t, tile.id);
    assert.equal(await sp.subView(token), null); assert.ok(await sp.subView(fresh));
    await assert.rejects(sp.subToken(t2, tile.id), /not found/, 'another company can’t make a link for this sub');
    console.log('SUB PORTAL SCENARIO PASSED');
  } catch (e) {
    console.error('SUB PORTAL SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[t, t2]]).catch(() => {});
    await pool.end();
  }
})();
