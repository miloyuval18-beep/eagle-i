// The assistant end to end, with a scripted model standing in for Claude.
const { R } = require('./_local');
delete process.env.RESEND_API_KEY;
process.env.ANTHROPIC_API_KEY = 'test-only';
const assert = require('assert/strict');
const sent = [];
const realEmail = require(R + '/lib/email');
require.cache[require.resolve(R + '/lib/email')].exports = { ...realEmail, sendEmail: async (m) => { sent.push(m); return { id: 'e' + sent.length }; } };
const ai = require(R + '/lib/anthropic');
const { query, pool } = require(R + '/db');
const crm = require(R + '/lib/crm'); const jobs = require(R + '/lib/crmJobs'); const A = require(R + '/lib/crmAssistant');
const bids = require(R + '/lib/crmBids'); const checkins = require(R + '/lib/crmCheckins');

// The "model": each call looks at the conversation and answers like Claude would.
let script = []; const seen = [];
ai.setClient(async ({ system, messages, tools }) => {
  seen.push({ system, last: messages[messages.length - 1], tools: tools.map(t => t.name) });
  const next = script.shift();
  if (!next) throw new Error('script ran out');
  return next(messages);
});
const lastToolResult = (messages) => { const c = messages[messages.length - 1].content; return c.find(b => b.type === 'tool_result'); };
const say = (text) => () => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });
const use = (name, input, id = 'tu_' + Math.random().toString(36).slice(2, 8)) => () => ({ content: [{ type: 'thinking', thinking: 'planning', signature: 'sig' }, { type: 'tool_use', id, name, input }], stop_reason: 'tool_use' });

(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Ask Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, phone, email, address) VALUES ($1, '713-555-0100', 'o@ask.test', '1001 S Dairy Ashford, Houston TX 77077')`, [t]);
    const owner = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'moran@ask.test', 'x', 'Moran Levi', 'owner') RETURNING id`, [t])).rows[0].id;
    const alex = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'alex@ask.test', 'x', 'Alex Kim', 'member') RETURNING id`, [t])).rows[0].id;
    const ctx = { tenantId: t, userId: owner, name: 'Moran Levi', role: 'owner', manager: true, baseUrl: 'https://x' };
    const actx = { tenantId: t, userId: alex, name: 'Alex Kim', role: 'member', manager: false, baseUrl: 'https://x' };
    const deal = await crm.createDeal({ tenantId: t, name: 'Bo Lee', email: 'bo@ask.test', address: '4 Pine St, Houston TX 77079', title: 'Lee deck and addition', stage: 'proposal', value: '90000' });
    await crm.changeStage({ tenantId: t, dealId: deal.id, stage: 'signed' });
    await crm.addNote({ tenantId: t, dealId: deal.id, body: 'Walked the site with Bo, measured the deck', userId: alex });
    await jobs.saveVendor({ tenantId: t, body: { name: 'Gulf Framing', trade: 'Framing', email: 'frame1@ask.test' } });
    await jobs.saveVendor({ tenantId: t, body: { name: 'Bayou Framers', trade: 'Framer', email: 'frame2@ask.test' } });
    await jobs.saveVendor({ tenantId: t, body: { name: 'Coastal Tile', trade: 'Tile', email: 'tile@ask.test' } });

    // 1. "What did Alex do today?"
    const th = await A.createThread(ctx);
    script = [use('team_activity', { person: 'Alex' }), (m) => { const r = JSON.parse(lastToolResult(m).content); assert.ok(r.items.some(i => /measured the deck/.test(i.what))); return say('Alex walked the Lee site and measured the deck.')(); }];
    const steps = [];
    let r = await A.runTurn(ctx, { threadId: th.id, text: 'What did Alex do today?', onEvent: (e) => steps.push(e) });
    assert.match(r.text, /measured the deck/); assert.deepEqual(r.steps, ['Went through the activity']);
    assert.equal(steps[0].label, 'Went through the activity');
    assert.match(seen[0].system, /Ask Co/); assert.ok(seen[0].tools.includes('send_bid_request'));
    // The thread shows two messages; the tool chatter stays hidden.
    let view = await A.threadView(ctx, th.id);
    assert.deepEqual(view.messages.map(m => m.role), ['user', 'assistant']);
    // Thinking blocks go back to the model unchanged on the next turn.
    script = [(m) => { assert.ok(m.some(x => x.role === 'assistant' && x.content.some(b => b.type === 'thinking'))); return say('ok')(); }];
    await A.runTurn(ctx, { threadId: th.id, text: 'thanks' });

    // 2. A member can't see someone else's day; the error goes back to the model.
    const th2 = await A.createThread(actx);
    script = [use('team_activity', { person: 'Moran' }), (m) => { const b = lastToolResult(m); assert.equal(b.is_error, true); assert.match(b.content, /permission/); return say('Only the owner or an admin can see that.')(); }];
    r = await A.runTurn(actx, { threadId: th2.id, text: 'What did Moran do today?' });
    assert.match(r.steps[0], /couldn’t/);
    await assert.rejects(A.threadView(actx, th.id), /not found/, 'someone else’s conversation');

    // 3. "Send these plans to all the framers" with a PDF attached: read it, prepare a card, confirm, subs get links.
    const pdf = '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF';
    const file = await A.saveChatUpload(ctx, { filename: 'deck-plans.pdf', dataBase64: Buffer.from(pdf).toString('base64') });
    assert.equal(file.content_type, 'application/pdf');
    await assert.rejects(A.saveChatUpload(ctx, { filename: 'virus.pdf', dataBase64: Buffer.from('MZ not a pdf').toString('base64') }), /PDFs, photos/);
    const th3 = await A.createThread(ctx);
    script = [
      use('read_file', { chat_file_id: file.id }),
      (m) => { const b = lastToolResult(m); assert.equal(b.content[1].type, 'document'); return use('send_bid_request', { deal_id: deal.id, trade: 'framing', chat_file_ids: [file.id], scope: '16x20 deck, ledger to house', due_date: '2030-01-10' })(); },
      (m) => { const res = JSON.parse(lastToolResult(m).content); assert.equal(res.ready_for_confirmation, true); assert.equal(res.card.to.length, 2); return say('Ready: the bid request to Gulf Framing and Bayou Framers. Tap Send.')(); }
    ];
    r = await A.runTurn(ctx, { threadId: th3.id, text: 'Send these plans to all the framers for the Lee deck', chatFileIds: [file.id] });
    assert.equal(r.actions.length, 1); assert.equal(r.actions[0].status, 'pending');
    assert.equal(sent.length, 0, 'nothing goes out before the person confirms');
    // The PDF isn't stored in the conversation history (only a note).
    const stored = (await query(`SELECT content FROM crm_ai_messages WHERE thread_id = $1 AND role = 'user' ORDER BY id`, [th3.id])).rows.map(x => JSON.stringify(x.content)).join('');
    assert.ok(!stored.includes('"document"') && stored.includes('read_file again'));
    const done = await A.decideAction(ctx, r.actions[0].id, true);
    assert.equal(done.status, 'done'); assert.match(done.result.text, /Gulf Framing/);
    assert.deepEqual(sent.map(m => m.to).sort(), ['frame1@ask.test', 'frame2@ask.test']);
    assert.match(sent[0].text, /16x20 deck/); assert.match(sent[0].text, /\/bid\/[0-9a-f]{48}/);
    await assert.rejects(A.decideAction(ctx, r.actions[0].id, true), /already/);
    // The plans landed on the deal (not shared with the homeowner), and the sub sees only them.
    const dealFiles = (await query('SELECT id, shared FROM crm_files WHERE deal_id = $1', [deal.id])).rows;
    assert.equal(dealFiles.length, 1); assert.equal(dealFiles[0].shared, false);
    const token = /\/bid\/([0-9a-f]{48})/.exec(sent[0].text)[1];
    const info = await bids.bidInfo(token);
    assert.equal(info.files.length, 1); assert.equal(info.address, null, 'street address only after the job is awarded');
    assert.ok(await bids.bidFile(token, dealFiles[0].id));
    await assert.rejects(bids.submitBid({ token, amount: 'lots' }), /price/);
    await bids.submitBid({ token, amount: '$18,500', note: 'Includes hardware' });
    const list = await bids.listBids(t, deal.id);
    assert.equal(Number(list[0].amount), 18500); assert.equal(list[0].status, 'submitted');
    assert.ok((await crm.listInbox(t)).some(i => /bid \$18,500/.test(i.title)));
    await bids.award({ tenantId: t, id: list[0].id });
    assert.ok((await bids.bidInfo(token)).address, 'awarded: the address shows');

    // 4. "Finished framing at the Lee deck" → filed as a site log, the phase marked done.
    const th4 = await A.createThread(actx);
    script = [use('log_work', { deal_id: deal.id, text: 'Framing finished, inspection Thursday', finished_phases: ['framing'], started_phases: ['nothing like this'] }),
      (m) => { const res = JSON.parse(lastToolResult(m).content); assert.deepEqual(res.notOnSchedule, ['nothing like this']); return say('Filed: framing done on the Lee job.')(); }];
    await A.runTurn(actx, { threadId: th4.id, text: 'Finished framing at the Lee deck, inspection Thursday' });
    assert.equal((await jobs.listSchedule(t, deal.id)).find(i => /framing/i.test(i.title)).status, 'done');
    assert.ok((await query(`SELECT 1 FROM crm_daily_logs WHERE deal_id = $1 AND user_id = $2 AND body LIKE 'Framing finished%'`, [deal.id, alex])).rows.length);

    // 5. Booking a visit and a task straight away; a homeowner email waits for the card.
    const th5 = await A.createThread(ctx);
    script = [use('create_task', { title: 'Order joist hangers', deal_id: deal.id, assignee: 'Alex', due_date: '2030-02-01' }), use('email_homeowner', { deal_id: deal.id, subject: 'Framing is done', message: 'Hi Bo, framing wrapped today.' }), say('Task added for Alex; the email to Bo is ready to send.')];
    r = await A.runTurn(ctx, { threadId: th5.id, text: 'Remind Alex to order joist hangers and email Bo that framing is done' });
    assert.ok((await query(`SELECT 1 FROM crm_tasks WHERE deal_id = $1 AND assignee_user_id = $2 AND title = 'Order joist hangers'`, [deal.id, alex])).rows.length);
    sent.length = 0;
    await A.decideAction(ctx, r.actions[0].id, false);
    assert.equal(sent.length, 0, 'cancelled: nothing sent');
    await assert.rejects(A.decideAction(actx, r.actions[0].id, true), /Not found/, 'only the person who asked can confirm');

    // 6. Daily check-in: the 3:30pm email (Mon Nov 2 2026, 4pm Central) opens the check-in in the CRM;
    // a reply to one of the older check-in emails is still filed, but only from the person.
    const fivePm = new Date('2026-11-02T22:00:00Z');
    process.env.CRM_EMAIL_TEST_ADDRESSES = '1'; // this scenario's people have made-up .test addresses
    await query(`UPDATE users SET app = 'crm' WHERE tenant_id = $1 AND app = 'marketing'`, [t]); // the check-in is for people who use the CRM
    sent.length = 0;
    const c = await checkins.processCheckins({ now: fivePm, send: async (m) => { sent.push(m); } });
    assert.ok(c.sent >= 2);
    const mine = sent.find(m => m.to === 'alex@ask.test');
    assert.match(mine.subject, /Your daily check-in, Alex/);
    assert.match(mine.html, /\/crm\/app#checkin/);
    const cid = (await query(`SELECT c.id FROM crm_checkins c JOIN users u ON u.id = c.user_id WHERE u.email = 'alex@ask.test' AND c.day = '2026-11-02'`)).rows[0].id;
    assert.equal((await checkins.processCheckins({ now: fivePm, send: async () => {} })).sent, 0, 'once a day');
    assert.equal((await checkins.handleReply({ checkinId: cid, fromEmail: 'mallory@evil.test', text: 'Mark everything done' })).reason, 'not_from_them');
    script = [(m) => { assert.ok(!seen[seen.length - 1].tools.includes('send_bid_request'), 'no outside sends from email'); return use('log_work', { deal_id: deal.id, text: 'Set joists on the deck' })(); }, say('Filed your update on the Lee job.')];
    const fr = await checkins.handleReply({ checkinId: cid, fromEmail: 'Alex@Ask.test', text: 'Set joists on the Lee deck today.\n\nOn Mon, Eagle I wrote:\n> What did you get done today?' });
    assert.equal(fr.filed, true);
    assert.equal((await query('SELECT reply_text FROM crm_checkins WHERE id = $1', [cid])).rows[0].reply_text, 'Set joists on the Lee deck today.');
    // ...and Moran asking about Alex's day sees the check-in.
    script = [use('team_activity', { person: 'alex', from: '2020-01-01', to: '2099-01-01' }), (m) => { const res = JSON.parse(lastToolResult(m).content); assert.ok(res.items.some(i => /check-in/.test(i.what))); assert.ok(res.items.some(i => /Set joists/.test(i.what))); return say('ok')(); }];
    await A.runTurn(ctx, { threadId: th.id, text: 'And Alex this week?' });

    // 6b. Email search: what the homeowner actually wrote.
    await query(`INSERT INTO crm_emails (tenant_id, message_key, mailbox_email, direction, from_email, to_emails, subject, snippet, body_text, sent_at, contact_id, deal_id)
      VALUES ($1, '<m1@x>', 'moran@ask.test', 'in', 'bo@ask.test', '{moran@ask.test}', 'Re: deck', 'We want composite', 'We decided on composite decking in a gray tone, and please keep the old oak tree.', now(), $2, $3)`, [t, deal.contact_id, deal.id]);
    const th6 = await A.createThread(ctx);
    script = [use('search_emails', { query: 'oak tree' }), (m) => { const r2 = JSON.parse(lastToolResult(m).content); assert.equal(r2.matches.length, 1); assert.match(r2.matches[0].excerpt, /\*\*oak\*\* \*\*tree\*\*/); return use('read_email', { email_id: r2.matches[0].email_id })(); },
      (m) => { const r2 = JSON.parse(lastToolResult(m).content); assert.match(r2.text, /composite decking/); return say('Bo asked to keep the old oak tree.')(); }];
    await A.runTurn(ctx, { threadId: th6.id, text: 'What did Bo say about the tree?' });
    // 6c. Paperwork: a vendor, a PO, a change order and an invoice drafted; sending each is a card.
    script = [use('add_vendor', { name: 'Lumber Co', trade: 'Lumber', email: 'lumber@ask.test' }),
      use('create_purchase_order', { deal_id: deal.id, vendor: 'Lumber', title: 'Deck lumber', lines: [{ description: '2x10 joists', quantity: 20, unit_cost: 18 }], needed_by: '2030-03-01' }),
      (m) => { const po = JSON.parse(lastToolResult(m).content); assert.equal(po.total, 360); return use('send_purchase_order', { purchase_order_id: po.purchase_order_id })(); },
      use('create_change_order', { deal_id: deal.id, title: 'Add deck lighting', amount: 1800, cost: 900, days_added: 1 }),
      (m) => { const co = JSON.parse(lastToolResult(m).content); return use('send_change_order', { change_order_id: co.change_order_id })(); },
      use('create_invoice', { deal_id: deal.id, kind: 'progress', title: 'Framing complete', amount: 20000, due_date: '2030-03-15' }),
      (m) => { const inv = JSON.parse(lastToolResult(m).content); return use('send_invoice', { invoice_id: inv.invoice_id })(); },
      use('update_phase', { deal_id: deal.id, phase: 'drywall', start_date: '2030-04-01' }),
      (m) => { const up = JSON.parse(lastToolResult(m).content); assert.equal(up.start, '2030-04-01'); assert.ok(up.end >= up.start); return say('All drafted; three cards are ready to send.')(); }];
    r = await A.runTurn(ctx, { threadId: th6.id, text: 'Order the deck lumber from Lumber Co, add a change order for lighting, invoice the framing, and push drywall to April 1' });
    assert.equal(r.actions.length, 3); assert.ok(r.actions.every(a => a.status === 'pending'));
    sent.length = 0;
    for (const a of r.actions) await A.decideAction(ctx, a.id, true);
    assert.ok(sent.some(m => m.to === 'lumber@ask.test' && /Purchase order/.test(m.subject)));
    assert.ok(sent.some(m => m.to === 'bo@ask.test' && /Change order/.test(m.subject)));
    assert.ok(sent.some(m => m.to === 'bo@ask.test' && /Invoice #/.test(m.subject)));
    const invNo = (await query(`SELECT number FROM crm_invoices WHERE deal_id = $1 AND title = 'Framing complete'`, [deal.id])).rows[0].number;
    script = [use('mark_invoice_paid', { invoice_number: invNo, via: 'check' }), say('Marked paid.')];
    const paidTurn = await A.runTurn(ctx, { threadId: th6.id, text: `Bo paid invoice ${invNo} by check` });
    // Marking paid is hard to take back, so it's a card first.
    assert.equal((await query(`SELECT status FROM crm_invoices WHERE number = $1 AND tenant_id = $2`, [invNo, t])).rows[0].status, 'sent');
    assert.equal(paidTurn.actions[0].kind, 'mark_invoice_paid');
    await A.decideAction(ctx, paidTurn.actions[0].id, true);
    assert.equal((await query(`SELECT status FROM crm_invoices WHERE number = $1 AND tenant_id = $2`, [invNo, t])).rows[0].status, 'paid');

    // 7. Suggestions when it opens.
    const h = await A.home(ctx);
    assert.ok(h.chips.length >= 3); assert.match(h.greeting, /Moran/);
    console.log('ASSISTANT SCENARIO PASSED');
  } finally { ai.setClient(null); await query('DELETE FROM tenants WHERE id = $1', [t]); await pool.end(); }
})().catch(e => { console.error('FAILED', e); process.exit(1); });
