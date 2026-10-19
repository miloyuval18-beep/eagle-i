delete process.env.ANTHROPIC_API_KEY; delete process.env.RESEND_API_KEY;
const assert = require('assert/strict');
const { R } = require('./_local');
const { query, pool } = require(R + '/db');
const crm = require(R + '/lib/crm'); const q = require(R + '/lib/crmQualify');
const portal = require(R + '/lib/crmPortal'); const intake = require(R + '/lib/crmIntake');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Fit Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, email) VALUES ($1, 'owner@fit.test')`, [t]);
    await q.saveQualifySettings(t, { minJobValue: '$50,000', booking: { days: [0, 1, 2, 3, 4, 5, 6], start: '08:00', end: '18:00', duration: 60, buffer: 30, notice: 1, horizon: 7 } });
    const s = await q.qualifySettings(t);
    assert.equal(s.minJobValue, 50000); assert.equal(s.booking.start, '08:00');
    await assert.rejects(q.saveQualifySettings(t, { minJobValue: 'lots' }), /number/);
    // A new lead is scored the moment it's created.
    const deal = await crm.createDeal({ tenantId: t, name: 'Maria Garcia', email: 'maria@fit.test', phone: '7135550100', title: 'Maria — project', stage: 'new', source: 'website' });
    let d = await crm.getDeal(t, deal.id);
    assert.ok(d.grade, 'scored on create'); assert.equal(d.grade, 'C');
    // The questionnaire.
    const token = await portal.portalToken(t, deal.id);
    const info = await q.questionnaireInfo(token);
    assert.equal(info.name, 'Maria Garcia'); assert.equal(info.answered, false);
    assert.equal(await q.questionnaireInfo('f'.repeat(48)), null);
    await assert.rejects(q.submitQuestionnaire({ token, answers: { types: [], budget: '50_100k', timeline: 'asap' } }), /at least one/);
    const r = await q.submitQuestionnaire({ token, answers: { types: ['kitchen', 'bath'], budget: '100_250k', timeline: 'asap', decision: 'all', notes: 'Old 1980s kitchen', address: '12 Oak Ln, Houston TX 77024' } });
    assert.equal(r.grade, 'A'); assert.equal(r.canBook, true);
    d = await crm.getDeal(t, deal.id);
    assert.equal(d.stage, 'qualified', 'a good fit is qualified on its own');
    assert.equal(Number(d.value), 175000);
    assert.equal(d.title, 'Maria — kitchen + bathroom');
    assert.match(d.property_address || '', /12 Oak Ln/);
    assert.ok((await crm.listInbox(t)).some(i => /answered the questionnaire \(fit A\)/.test(i.title)));
    // Booking from the deal's link.
    const bi = await q.bookingInfoByToken(token);
    assert.ok(bi.slots.length > 10); assert.equal(bi.booked, null);
    const slot = bi.slots[0];
    await assert.rejects(q.bookByToken({ token, slot: '2020-01-01T15:00:00Z' }), /just taken/);
    const b = await q.bookByToken({ token, slot });
    assert.equal(b.at, slot);
    d = await crm.getDeal(t, deal.id);
    assert.equal(d.stage, 'site_visit'); assert.equal(new Date(d.site_visit_at).toISOString(), slot);
    for (let i = 0; i < 20 && !(await crm.getDeal(t, deal.id)).brief; i++) await wait(100);
    d = await crm.getDeal(t, deal.id);
    assert.match(d.brief, /Wants: Kitchen, Bathroom/); assert.match(d.brief, /Old 1980s kitchen/);
    // That time (and the travel time around it) is gone for everyone else.
    const others = await q.openSlots(t);
    assert.ok(!others.includes(slot));
    assert.ok(!others.some(x => Math.abs(new Date(x) - new Date(slot)) < 90 * 60000));
    // Anyone can book from the company's page; they become a lead.
    const key = await intake.getIntakeKey(t);
    const pub = await q.bookingInfoByKey(key);
    assert.equal(pub.company, 'Fit Co'); assert.ok(!pub.slots.includes(slot));
    await assert.rejects(q.bookNew({ key, name: 'Tom', email: 'tom@fit.test', slot }), /just taken/);
    await assert.rejects(q.bookNew({ key, name: '', email: 'tom@fit.test', slot: pub.slots[0] }), /name/);
    const nb = await q.bookNew({ key, name: 'Tom Reyes', email: 'tom@fit.test', phone: '7135550111', address: '4 Pine St, Houston TX 77079', slot: pub.slots[0] });
    assert.equal(nb.at, pub.slots[0]);
    const tom = (await query(`SELECT d.* FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id WHERE c.email = 'tom@fit.test' AND d.tenant_id = $1`, [t])).rows[0];
    assert.equal(tom.stage, 'site_visit'); assert.ok(tom.grade);
    // The deal sheet's fit panel.
    const fit = await q.dealFit({ tenantId: t, dealId: deal.id, baseUrl: 'https://x' });
    assert.equal(fit.grade, 'A'); assert.equal(fit.answers.budget, '$100k–$250k');
    assert.equal(fit.links.questionnaire, `https://x/q/${token}`); assert.equal(fit.links.booking, `https://x/b/${token}`);
    // Changing the value rescores.
    await crm.updateDeal({ tenantId: t, dealId: tom.id, patch: { value: '400000' } });
    assert.notEqual((await crm.getDeal(t, tom.id)).score, tom.score);
    // Playbook links fill in.
    const pb = require(R + '/lib/crmPlaybooks');
    const ex = await pb.linkExtras({ message: '{qualify_link}' }, {}, { tenant_id: t, base_url: 'https://x' }, { id: deal.id });
    assert.equal(ex.qualify_link, `https://x/q/${token}`); assert.equal(ex.booking_link, `https://x/b/${token}`);
    console.log('QUALIFY SCENARIO PASSED');
  } finally { await query('DELETE FROM tenants WHERE id = $1', [t]); await pool.end(); }
})().catch(e => { console.error('FAILED', e); process.exit(1); });
