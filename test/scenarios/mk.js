delete process.env.ANTHROPIC_API_KEY; delete process.env.RESEND_API_KEY;
const assert = require('assert/strict');
const { R } = require('./_local');
const { query, pool } = require(R + '/db');
const crm = require(R + '/lib/crm'); const mk = require(R + '/lib/crmMarketing'); const intake = require(R + '/lib/crmIntake');
const q = require(R + '/lib/crmQualify'); const rp = require(R + '/lib/crmReports');
const dealOf = async (t, email) => (await query(`SELECT d.* FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id WHERE c.email = $2 AND d.tenant_id = $1`, [t, email])).rows[0];
(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Mk Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, email) VALUES ($1, 'o@mk.test')`, [t]);
    const key = await intake.getIntakeKey(t);
    // Leads from ads are labelled by channel, and keep their tags.
    await intake.submitForm({ key, body: { name: 'Ann Ads', email: 'ann@mk.test', utm: { gclid: 'g1', utm_campaign: 'kitchens-houston' } } });
    await intake.submitForm({ key, body: { name: 'Fay Book', email: 'fay@mk.test', utm: { fbclid: 'f1' } } });
    await intake.submitForm({ key, body: { name: 'Olly Org', email: 'olly@mk.test', utm: { utm_source: 'google', utm_medium: 'organic' } } });
    await intake.submitForm({ key, body: { name: 'Gus Ads', email: 'gus@mk.test', utm: { utm_source: 'google', utm_medium: 'cpc' } } });
    const ann = await dealOf(t, 'ann@mk.test');
    assert.equal(ann.source, 'google_ads'); assert.equal(ann.utm.utm_campaign, 'kitchens-houston');
    assert.equal((await dealOf(t, 'fay@mk.test')).source, 'facebook');
    assert.equal((await dealOf(t, 'olly@mk.test')).source, 'website');
    // The booking page too.
    await q.saveQualifySettings(t, { booking: { days: [0, 1, 2, 3, 4, 5, 6], start: '08:00', end: '18:00', notice: 1 } });
    const slots = (await q.bookingInfoByKey(key)).slots;
    await q.bookNew({ key, name: 'Ned Door', email: 'ned@mk.test', slot: slots[0], utm: { utm_source: 'nextdoor' } });
    assert.equal((await dealOf(t, 'ned@mk.test')).source, 'nextdoor');
    // Spend, then a signed job from Google.
    const now = new Date();
    const thisMonth = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }).slice(0, 7);
    await mk.saveSpend({ tenantId: t, source: 'google_ads', month: thisMonth, amount: '$3,000' });
    await mk.saveSpend({ tenantId: t, source: 'google_ads', month: thisMonth, amount: '4000', note: 'fixed' });
    await mk.saveSpend({ tenantId: t, source: 'facebook', month: thisMonth, amount: 1500 });
    await assert.rejects(mk.saveSpend({ tenantId: t, source: 'manual', month: thisMonth, amount: 5 }), /where the money went/);
    await assert.rejects(mk.saveSpend({ tenantId: t, source: 'facebook', month: 'soon', amount: 5 }), /month/);
    assert.equal((await mk.listSpend(t)).length, 2, 'same month and channel updates');
    await crm.updateDeal({ tenantId: t, dealId: ann.id, patch: { value: '120000' } });
    await crm.changeStage({ tenantId: t, dealId: ann.id, stage: 'signed' });
    await crm.updateDeal({ tenantId: t, dealId: (await dealOf(t, 'gus@mk.test')).id, patch: { value: '80000' } });
    await crm.changeStage({ tenantId: t, dealId: (await dealOf(t, 'gus@mk.test')).id, stage: 'proposal' });
    const rep = await mk.channelReport(t, { months: 3 });
    const g = rep.channels.find(c => c.source === 'google_ads');
    assert.equal(g.spend, 4000); assert.equal(g.leads, 2); assert.equal(g.signed, 1); assert.equal(g.signedValue, 120000);
    assert.equal(g.costPerLead, 2000); assert.equal(g.costPerSigned, 4000); assert.equal(g.returnPerDollar, 30);
    const f = rep.channels.find(c => c.source === 'facebook');
    assert.equal(f.signed, 0); assert.equal(f.costPerSigned, null);
    assert.equal(rep.total.spend, 5500);
    // Backlog: $120k signed against $40k a month → about 13 weeks, between the marks.
    let b = await mk.backlog(t);
    assert.equal(b.weeksBooked, null); assert.equal(b.advice.level, 'unknown');
    await mk.saveBacklogSettings(t, { monthlyCapacity: '40,000' });
    await assert.rejects(mk.saveBacklogSettings(t, { lowWeeks: 10, highWeeks: 5 }), /more than/);
    b = await mk.backlog(t);
    assert.equal(b.backlogValue, 120000); assert.equal(b.weeksBooked, 13); assert.equal(b.advice.level, 'hold');
    assert.equal(b.pipelineWeighted, 36000, 'the proposal at the default 45%');
    // A job underway counts by what's left of its schedule.
    await crm.changeStage({ tenantId: t, dealId: ann.id, stage: 'production' });
    const items = (await query('SELECT id FROM crm_job_items WHERE deal_id = $1 ORDER BY position', [ann.id])).rows;
    assert.ok(items.length >= 4);
    await query(`UPDATE crm_job_items SET status = 'done' WHERE id = ANY($1)`, [items.slice(0, items.length / 2).map(i => i.id)]);
    b = await mk.backlog(t);
    assert.ok(b.backlogValue < 120000 && b.backlogValue >= 50000, String(b.backlogValue));
    assert.equal(b.advice.level, 'ramp'); assert.match(b.advice.text, /Google Ads/);
    await mk.saveBacklogSettings(t, { lowWeeks: 2, highWeeks: 4 });
    b = await mk.backlog(t);
    assert.equal(b.advice.level, 'ease'); assert.match(b.advice.text, /Facebook/);
    // The weekly report carries it.
    const facts = await rp.gatherFacts(t, crm.weekBounds(new Date()));
    assert.equal(facts.company.backlog.level, 'ease');
    assert.ok(rp.writeByRules(facts).successes.some(x => /booked about/.test(x)));
    // The 2nd of next month: a reminder to enter this month's spend. Once.
    const [yy, mm] = thisMonth.split('-').map(Number);
    // (Checked on this company's own Needs-you list: other companies in the database may be reminded.)
    await mk.scanSpendReminder({ now: new Date(Date.UTC(yy, mm, 2, 17)) });
    assert.equal((await crm.listInbox(t)).filter(i => i.kind === 'spend_reminder').length, 0, 'already entered');
    const nextSecond = new Date(Date.UTC(yy, mm + 1, 2, 17));
    assert.equal((await mk.scanSpendReminder({ now: nextSecond })).reminded >= 1, true);
    assert.equal((await mk.scanSpendReminder({ now: nextSecond })).reminded, 0);
    assert.ok((await crm.listInbox(t)).some(i => i.kind === 'spend_reminder'));
    console.log('MARKETING SCENARIO PASSED');
  } finally { await query('DELETE FROM tenants WHERE id = $1', [t]); await pool.end(); }
})().catch(e => { console.error('FAILED', e); process.exit(1); });
