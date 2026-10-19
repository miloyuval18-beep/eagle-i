const { R } = require('./_local');
const assert = require('assert/strict');
const { query, pool } = require(R + '/db');
const crm = require(R + '/lib/crm');
const pb = require(R + '/lib/crmPlaybooks');
const sent = []; const send = async (m) => { sent.push(m); return { id: 'fake-' + sent.length }; };
(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Scenario Homes', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, phone, email, address, founder_name) VALUES ($1, '713-555-0100', 'owner@scenario.test', '1001 S Dairy Ashford, Houston TX 77077', 'Levi')`, [t]);
    // An old lead from before the CRM existed, marked contacted.
    const old = (await query(`INSERT INTO leads (tenant_id, name, email, phone, message, status, created_at, updated_at) VALUES ($1, 'Old Lead', 'old@x.test', '7135550199', 'bathroom', 'contacted', now() - interval '10 days', now() - interval '9 days') RETURNING *`, [t])).rows[0];
    assert.equal(await crm.backfillLeads(t), 1);
    assert.equal(await crm.backfillLeads(t), 0, 'backfill is idempotent');
    let p = await crm.listPipeline(t);
    assert.equal(p.deals[0].stage, 'qualified');

    // A new landing-page lead becomes a deal; the same person again is matched to the same contact.
    const lead = (await query(`INSERT INTO leads (tenant_id, name, email, phone, message) VALUES ($1, 'maria garcia', 'maria@x.test', '(713) 555-0101', 'Kitchen remodel please') RETURNING *`, [t])).rows[0];
    const deal = await crm.createDealFromLead(lead);
    assert.equal(deal.title, 'maria — kitchen');
    assert.equal(await crm.createDealFromLead(lead), null, 'one deal per lead');
    const c2 = await crm.findOrCreateContact({ tenantId: t, name: 'Maria G', email: 'MARIA@x.test' });
    assert.equal(c2.id, deal.contact_id);

    // Speed-to-lead: after 30 minutes untouched, it shows up in Needs you (once).
    let scan = await crm.scanExceptions({ now: new Date(Date.now() + 31 * 60000) });
    assert.ok(scan.waiting >= 1);
    scan = await crm.scanExceptions({ now: new Date(Date.now() + 32 * 60000) });
    assert.equal(scan.waiting, 0, 'no duplicate');
    assert.equal((await crm.listInbox(t)).filter(i => i.kind === 'waiting_lead').length, 1);

    // Playbooks: seeded off; nothing is scheduled until approved.
    let list = await pb.listPlaybooks(t);
    assert.equal(list.length, 13);
    assert.ok(list.every(x => !x.enabled && !x.approved));
    await crm.changeStage({ tenantId: t, dealId: deal.id, stage: 'site_visit' });
    assert.equal((await query(`SELECT COUNT(*)::int n FROM crm_playbook_sends WHERE deal_id = $1`, [deal.id])).rows[0].n, 0);
    // Moving it out of New picked it up: lead status synced, waiting item resolved.
    assert.equal((await query('SELECT status FROM leads WHERE id = $1', [lead.id])).rows[0].status, 'contacted');
    assert.equal((await crm.listInbox(t)).filter(i => i.kind === 'waiting_lead').length, 0);

    // Approve the proposal follow-up, then move the deal to proposal: 3 emails scheduled.
    const prop = list.find(x => x.key === 'proposal_follow_up');
    await pb.approvePlaybook({ tenantId: t, id: prop.id });
    await crm.changeStage({ tenantId: t, dealId: deal.id, stage: 'proposal' });
    let rows = (await query(`SELECT * FROM crm_playbook_sends WHERE deal_id = $1 ORDER BY step`, [deal.id])).rows;
    assert.equal(rows.length, 3);
    // Not due yet -> nothing sent.
    let r = await pb.processDueSends({ send, now: new Date() });
    assert.equal(r.sent, 0);
    // A weekday 10am Central, 4 days later: email 1 goes out.
    const tue = new Date(rows[0].due_at); tue.setUTCDate(tue.getUTCDate() + 1);
    while (!require(R + '/lib/followUps').inSendWindow(tue)) tue.setUTCHours(tue.getUTCHours() + 1);
    r = await pb.processDueSends({ send, now: tue });
    assert.equal(r.sent, 1, JSON.stringify(r));
    assert.equal(sent[0].to, 'maria@x.test');
    assert.equal(sent[0].subject, 'Your proposal from Scenario Homes');
    assert.match(sent[0].text, /Hi Maria/);
    assert.match(sent[0].text, /unsubscribe/i);
    assert.match(sent[0].text, /Dairy Ashford/);

    // Editing the wording withdraws approval and cancels what was waiting.
    const edited = JSON.parse(JSON.stringify((await query('SELECT steps FROM crm_playbooks WHERE id = $1', [prop.id])).rows[0].steps));
    edited[1].message += ' P.S. new line';
    const sv = await pb.savePlaybook({ tenantId: t, id: prop.id, steps: edited });
    assert.equal(sv.changed, true);
    rows = (await query(`SELECT status, cancel_reason FROM crm_playbook_sends WHERE deal_id = $1 ORDER BY step`, [deal.id])).rows;
    assert.deepEqual(rows.map(x => x.status), ['sent', 'cancelled', 'cancelled']);
    await assert.rejects(pb.setEnabled({ tenantId: t, id: prop.id, enabled: true }), /Approve/);

    // Reply handling: re-approve, re-enter the stage, send, then a "not now" reply stops the rest.
    await pb.approvePlaybook({ tenantId: t, id: prop.id });
    await crm.changeStage({ tenantId: t, dealId: deal.id, stage: 'site_visit' });
    await crm.changeStage({ tenantId: t, dealId: deal.id, stage: 'proposal' });
    rows = (await query(`SELECT * FROM crm_playbook_sends WHERE deal_id = $1 AND status = 'pending' ORDER BY step`, [deal.id])).rows;
    assert.equal(rows.length, 3, 'a new visit to the stage schedules fresh emails');
    const rep = await pb.recordReply({ sendId: rows[0].id, text: 'Not right now, thanks', category: 'not_now' });
    assert.equal(rep.negative, true);
    assert.equal((await query(`SELECT COUNT(*)::int n FROM crm_playbook_sends WHERE deal_id = $1 AND status = 'pending'`, [deal.id])).rows[0].n, 0);
    assert.ok((await crm.listInbox(t)).some(i => i.kind === 'negative_reply'));

    // Paused: due emails wait instead of sending, and are not cancelled.
    const welcome = list.find(x => x.key === 'welcome_aboard');
    await pb.approvePlaybook({ tenantId: t, id: welcome.id });
    await crm.saveSettings(t, { paused: true });
    await crm.changeStage({ tenantId: t, dealId: deal.id, stage: 'signed' });
    r = await pb.processDueSends({ send, onlyDealId: deal.id });
    assert.equal(r.sent, 0); assert.equal(r.deferred, 1);
    await crm.saveSettings(t, { paused: false });
    r = await pb.processDueSends({ send, onlyDealId: deal.id });
    assert.equal(r.sent, 1);
    assert.equal(sent[sent.length - 1].subject, 'Welcome to Scenario Homes');
    assert.equal((await query('SELECT status FROM leads WHERE id = $1', [lead.id])).rows[0].status, 'won');

    // Opted-out addresses never get scheduled emails.
    const d3 = await crm.createDeal({ tenantId: t, name: 'Opted Out', email: 'no@x.test', stage: 'new' });
    await query(`INSERT INTO outreach_suppressions (tenant_id, email, reason) VALUES ($1, 'no@x.test', 'unsubscribed')`, [t]);
    await crm.changeStage({ tenantId: t, dealId: d3.id, stage: 'signed' });
    assert.equal((await query(`SELECT COUNT(*)::int n FROM crm_playbook_sends WHERE deal_id = $1`, [d3.id])).rows[0].n, 0);

    // Lead inbox -> pipeline sync.
    const lead2 = (await query(`INSERT INTO leads (tenant_id, name, email) VALUES ($1, 'Sync Test', 'sync@x.test') RETURNING *`, [t])).rows[0];
    const d4 = await crm.createDealFromLead(lead2);
    await crm.syncFromLeadStatus({ tenantId: t, leadId: lead2.id, status: 'lost' });
    assert.equal((await crm.getDeal(t, d4.id)).stage, 'lost');

    // Stalled: a qualified deal with no activity for 8 days shows up once.
    await query(`UPDATE crm_deals SET last_activity_at = now() - interval '8 days' WHERE id = $1`, [p.deals[0].id]);
    scan = await crm.scanExceptions();
    assert.ok(scan.stalled >= 1);
    assert.equal((await crm.scanExceptions()).stalled, 0);

    // Bounce on a CRM email suppresses the address.
    const sid = (await query(`SELECT id, resend_email_id FROM crm_playbook_sends WHERE status = 'sent' AND tenant_id = $1 LIMIT 1`, [t])).rows[0];
    const ev = await require(R + '/lib/deliveryEvents').processDeliveryEvent({ type: 'email.bounced', data: { email_id: sid.resend_email_id, bounce: { type: 'Permanent' } } });
    assert.equal(ev.handled, true); assert.equal(ev.status, 'bounced');

    // Weekly summary: real counts, sent once.
    const s = await crm.buildWeeklySummary(t, { start: new Date(Date.now() - 7 * 86400000), end: new Date(Date.now() + 86400000) });
    assert.equal(s.newLeads, 2); // maria + sync test (the old lead is 10 days old; deals added by hand don't count)
    assert.equal(s.signedCount, 2);
    const monday = new Date('2026-10-19T14:00:00Z');
    const w1 = await crm.processWeeklySummaries({ now: monday, send });
    const w2 = await crm.processWeeklySummaries({ now: monday, send });
    assert.ok(w1.sent >= 1); assert.equal(w2.sent, 0);
    console.log('ALL SCENARIO CHECKS PASSED. Emails captured:', sent.map(m => m.to + ' | ' + m.subject).join('\n  '));
  } finally {
    await query('DELETE FROM tenants WHERE id = $1', [t]);
    await pool.end();
  }
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
