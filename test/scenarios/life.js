delete process.env.ANTHROPIC_API_KEY; delete process.env.RESEND_API_KEY;
const assert = require('assert/strict');
const { R } = require('./_local');
const { query, pool } = require(R + '/db');
const crm = require(R + '/lib/crm'); const pb = require(R + '/lib/crmPlaybooks'); const life = require(R + '/lib/crmLifetime');
const intake = require(R + '/lib/crmIntake'); const portal = require(R + '/lib/crmPortal'); const jobs = require(R + '/lib/crmJobs');
const sent = []; const send = async (m) => { sent.push(m); return { id: 'x' + sent.length }; };
const WED_NOON = new Date('2026-10-21T17:00:00Z');
const dealOf = async (t, email) => (await query(`SELECT d.* FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id WHERE c.email = $2 AND d.tenant_id = $1 ORDER BY d.created_at DESC LIMIT 1`, [t, email])).rows[0];
// Everything due goes now; a routine follow-up held for "one a day" goes the next day.
const flush = async (dealId) => {
  await query(`UPDATE crm_playbook_sends SET due_at = $2 WHERE deal_id = $1 AND status = 'pending'`, [dealId, new Date(WED_NOON.getTime() - 60000)]);
  const r = await pb.processDueSends({ now: WED_NOON, send, onlyDealId: dealId });
  const next = new Date(WED_NOON.getTime() + 86400000);
  if ((await query(`UPDATE crm_playbook_sends SET due_at = $2, sent_at = NULL WHERE deal_id = $1 AND status = 'pending' AND cancel_reason = 'one_a_day' RETURNING id`, [dealId, new Date(next.getTime() - 60000)])).rowCount) {
    await query(`UPDATE crm_playbook_sends SET sent_at = sent_at - interval '2 days' WHERE deal_id = $1 AND status = 'sent'`, [dealId]);
    const r2 = await pb.processDueSends({ now: next, send, onlyDealId: dealId });
    r.sent += r2.sent;
  }
  return r;
};
(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Life Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, phone, email, address, founder_name) VALUES ($1, '713-555-0100', 'o@life.test', '1001 S Dairy Ashford, Houston TX 77077', 'Levi')`, [t]);
    const st = await life.saveLifetimeSettings(t, { referralReward: '$500', warrantyMonths: '12' });
    assert.equal(st.referralReward, 500); assert.equal(st.reviewUrl, null);
    await assert.rejects(life.saveLifetimeSettings(t, { reviewUrl: 'javascript:alert(1)' }), /https/);
    const list = await pb.listPlaybooks(t);
    for (const k of ['job_complete', 'review_request', 'home_care_reminder', 'warranty_ending']) await pb.approvePlaybook({ tenantId: t, id: list.find(x => x.key === k).id });

    // A past client's link brings in a lead credited to them.
    const maria = await crm.createDeal({ tenantId: t, name: 'Maria Garcia', email: 'maria@life.test', title: 'Kitchen', stage: 'complete' });
    const code = await life.contactCode(t, maria.contact_id);
    assert.equal(await life.contactCode(t, maria.contact_id), code, 'stable');
    const key = await intake.getIntakeKey(t);
    assert.equal(await life.referralTarget(code), `/crm/f/${key}?ref=${code}`);
    assert.equal(await life.referralTarget('0000000000'), null);
    await intake.submitForm({ key, body: { name: 'Tom Reyes', email: 'tom@life.test', message: 'Bathroom', ref: code } });
    let tom = await dealOf(t, 'tom@life.test');
    assert.equal(tom.source, 'referral'); assert.equal(tom.referred_by_contact_id, maria.contact_id);
    // Referring yourself doesn't count.
    await intake.submitForm({ key, body: { name: 'Maria Garcia', email: 'maria@life.test', message: 'Another one', ref: code } });
    const again = await dealOf(t, 'maria@life.test');
    assert.equal(again.referred_by_contact_id, null);
    // A partner's link.
    const partner = await life.savePartner({ tenantId: t, body: { name: 'Rita Realtor', kind: 'realtor', email: 'rita@life.test' } });
    await intake.submitForm({ key, body: { name: 'Pat Kim', email: 'pat@life.test', ref: partner.code } });
    const pat = await dealOf(t, 'pat@life.test');
    assert.equal(pat.source, 'partner'); assert.equal(pat.partner_id, partner.id);
    // Another company's code is ignored.
    await assert.rejects(life.savePartner({ tenantId: t, body: { name: '' } }), /name/);

    // Signing earns the reward, once, and a thank-you in Needs you.
    tom = await crm.changeStage({ tenantId: t, dealId: tom.id, stage: 'signed' });
    await crm.updateDeal({ tenantId: t, dealId: tom.id, patch: { value: '60000' } });
    await crm.changeStage({ tenantId: t, dealId: tom.id, stage: 'proposal' });
    await crm.changeStage({ tenantId: t, dealId: tom.id, stage: 'signed' });
    const rewards = (await query('SELECT * FROM crm_referral_rewards WHERE tenant_id = $1', [t])).rows;
    assert.equal(rewards.length, 1); assert.equal(Number(rewards[0].amount), 500);
    assert.ok((await crm.listInbox(t)).some(i => i.kind === 'referral' && /Thank Maria Garcia/.test(i.title)));
    const board = await life.scoreboard(t);
    assert.equal(board.clients[0].name, 'Maria Garcia'); assert.equal(board.clients[0].signed, 1); assert.equal(board.clients[0].revenue, 60000);
    assert.equal(board.partners[0].leads, 1); assert.equal(board.partners[0].signed, 0);
    assert.equal(board.rewards[0].status, 'owed');
    await life.setRewardPaid({ tenantId: t, id: rewards[0].id, paid: true });
    assert.ok(!(await crm.listInbox(t)).some(i => i.kind === 'referral'), 'resolved when thanked');

    // Finishing the job starts the home file: warranty + every selection.
    const sel = await jobs.saveSelection({ tenantId: t, dealId: tom.id, body: { category: 'Shower tile', allowance: 2000, options: [{ name: 'Zellige white', price: 1800, note: 'Riad Tile, 4x4' }] } });
    await query('UPDATE crm_selections SET chosen_index = 0, chosen_at = now() WHERE id = $1', [sel.id]);
    await crm.changeStage({ tenantId: t, dealId: tom.id, stage: 'complete' });
    await life.onComplete(tom);
    let items = await life.listHomeItems(t, tom.id);
    assert.equal(items.length, 2, 'no duplicates');
    const war = items.find(i => i.category === 'warranty');
    assert.equal(String(war.warranty_until instanceof Date ? war.warranty_until.toISOString() : war.warranty_until).slice(0, 10), life.addMonths(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }), 12));
    assert.ok(items.some(i => i.name === 'Shower tile: Zellige white' && i.details === 'Riad Tile, 4x4'));

    // The review request waits for a review link.
    sent.length = 0;
    let r = await flush(tom.id);
    assert.ok(!sent.some(m => /review/i.test(m.subject)));
    assert.equal((await query(`SELECT s.cancel_reason FROM crm_playbook_sends s JOIN crm_playbooks p ON p.id = s.playbook_id WHERE s.deal_id = $1 AND p.key = 'review_request'`, [tom.id])).rows[0].cancel_reason, 'no_review_link');
    await life.saveLifetimeSettings(t, { reviewUrl: 'https://g.page/r/life-co/review' });
    await crm.changeStage({ tenantId: t, dealId: tom.id, stage: 'production' });
    await crm.changeStage({ tenantId: t, dealId: tom.id, stage: 'complete' });
    sent.length = 0;
    await flush(tom.id);
    const rev = sent.find(m => /share a few words/.test(m.subject));
    assert.ok(rev, 'review request sent'); assert.match(rev.text, /g\.page\/r\/life-co\/review/);
    const thanks = sent.find(m => /holding up/.test(m.subject));
    assert.match(thanks.text, new RegExp(`/r/${(await query('SELECT referral_code FROM crm_contacts WHERE id = $1', [tom.contact_id])).rows[0].referral_code}`), 'their own referral link');

    // A care reminder comes due: one email, and the date moves on a year.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const heater = await life.saveHomeItem({ tenantId: t, dealId: tom.id, body: { name: 'Tankless water heater', category: 'appliance', installedOn: '2024-01-10', careEveryMonths: 12, careNote: 'Flush the heat exchanger.' } });
    assert.ok(String(heater.next_care_at instanceof Date ? heater.next_care_at.toISOString() : heater.next_care_at).slice(0, 10) > today, 'next care is in the future');
    await query('UPDATE crm_home_items SET next_care_at = $2 WHERE id = $1', [heater.id, today]);
    let scan = await life.scanHomeCare();
    assert.equal(scan.care, 1);
    assert.equal(String((await query('SELECT next_care_at FROM crm_home_items WHERE id = $1', [heater.id])).rows[0].next_care_at.toISOString()).slice(0, 10), life.addMonths(today, 12));
    assert.equal((await life.scanHomeCare()).care, 0, 'only once');
    sent.length = 0;
    await flush(tom.id);
    const care = sent.find(m => /Tankless water heater/.test(m.subject));
    assert.ok(care); assert.match(care.text, /Flush the heat exchanger/); assert.match(care.text, /\/p\/[0-9a-f]{48}/);
    // A warranty ending in 40 days: a check-in email and a walkthrough task, once.
    await query(`UPDATE crm_home_items SET warranty_until = $2::date + 40 WHERE id = $1`, [war.id, today]);
    scan = await life.scanHomeCare();
    assert.equal(scan.warranty, 1);
    assert.equal((await life.scanHomeCare()).warranty, 0);
    assert.ok((await query(`SELECT 1 FROM crm_tasks WHERE deal_id = $1 AND title LIKE 'Warranty walkthrough%'`, [tom.id])).rows.length);
    sent.length = 0;
    await flush(tom.id);
    const w = sent.find(m => /warranty with Life Co ends/.test(m.subject));
    assert.ok(w); assert.match(w.text, /workmanship warranty/);
    // Changing the warranty date resets it, and the old email no longer fits.
    const moved = await life.saveHomeItem({ tenantId: t, id: war.id, body: { name: war.name, category: 'warranty', warrantyUntil: life.addMonths(today, 24) } });
    assert.equal(moved.warranty_noticed, false);
    // The homeowner sees the home file and their link.
    const view = await portal.portalView(await portal.portalToken(t, tom.id));
    assert.ok(view.home.items.length >= 3); assert.match(view.home.referralCode, /^[0-9a-f]{10}$/);
    const early = await portal.portalView(await portal.portalToken(t, pat.id));
    assert.equal(early.home.referralCode, null, 'not before the job');
    // Lost deals get no care emails.
    const lostItem = await life.saveHomeItem({ tenantId: t, dealId: pat.id, body: { name: 'Gutter guards', careEveryMonths: 6 } });
    await crm.changeStage({ tenantId: t, dealId: pat.id, stage: 'lost' });
    await query('UPDATE crm_home_items SET next_care_at = $2 WHERE id = $1', [lostItem.id, today]);
    assert.equal((await life.scanHomeCare()).care, 0);
    console.log('LIFETIME SCENARIO PASSED');
  } finally { await query('DELETE FROM tenants WHERE id = $1', [t]); await pool.end(); }
})().catch(e => { console.error('FAILED', e); process.exit(1); });
