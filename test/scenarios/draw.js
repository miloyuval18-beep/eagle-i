delete process.env.ANTHROPIC_API_KEY; delete process.env.RESEND_API_KEY;
const assert = require('assert/strict');
const { R } = require('./_local');
const { query, pool } = require(R + '/db');
const crm = require(R + '/lib/crm'); const jobs = require(R + '/lib/crmJobs'); const draws = require(R + '/lib/crmDraws');
const pulse = require(R + '/lib/crmPulse'); const rp = require(R + '/lib/crmReports');
const sent = []; const send = async (m) => { sent.push(m); return { id: 'x' }; };
(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Draw Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, phone, email, address) VALUES ($1, '713-555-0100', 'o@dw.test', '1001 S Dairy Ashford, Houston TX 77077')`, [t]);
    // Signing lays the standard draws against the schedule.
    const deal = await crm.createDeal({ tenantId: t, name: 'Ana Ruiz', email: 'ana@dw.test', title: 'Kitchen', stage: 'proposal', value: '100000' });
    await crm.changeStage({ tenantId: t, dealId: deal.id, stage: 'signed' });
    let l = await draws.listDraws(t, deal.id);
    assert.equal(l.draws.length, 3);
    const rough = l.draws.find(d => /Rough-in/.test(d.title));
    assert.match(rough.phase_title, /rough-in/i); assert.equal(Number(rough.pct), 30);
    assert.ok(l.draws.find(d => d.pct == null).on_complete);
    // Applying again changes nothing; validation.
    assert.equal((await draws.applyTemplate({ tenantId: t, dealId: deal.id })).created, 0);
    await assert.rejects(draws.saveDraw({ tenantId: t, dealId: deal.id, body: { title: 'X', pct: 150 } }), /between 1 and 100/);
    await assert.rejects(draws.saveDraw({ tenantId: t, dealId: deal.id, body: { title: 'X', rest: true } }), /Only one/);
    // A change order raises the contract before the milestone.
    await query('UPDATE crm_deals SET value = 110000 WHERE id = $1', [deal.id]);
    // Marking the phase done drafts the 30% invoice and flags it (auto-send is off).
    await jobs.saveItem({ tenantId: t, id: rough.trigger_item_id, body: { title: rough.phase_title, status: 'done' } });
    l = await draws.listDraws(t, deal.id);
    const r1 = l.draws.find(d => d.id === rough.id);
    assert.ok(r1.invoice_id); assert.equal(Number(r1.invoice_amount), 33000);
    assert.ok((await crm.listInbox(t)).some(i => i.kind === 'draw_ready' && /\$33,000\.00/.test(i.title)));
    // Saving it done again doesn't bill twice.
    await jobs.saveItem({ tenantId: t, id: rough.trigger_item_id, body: { title: rough.phase_title, status: 'doing' } });
    await jobs.saveItem({ tenantId: t, id: rough.trigger_item_id, body: { title: rough.phase_title, status: 'done' } });
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM crm_invoices WHERE deal_id = $1`, [deal.id])).rows[0].n, 1);
    await assert.rejects(draws.deleteDraw({ tenantId: t, id: rough.id }), /Invoiced/);
    // Auto-send on: the next milestone goes straight out.
    await draws.setAutoSend(t, true);
    const cab = l.draws.find(d => /Cabinets/.test(d.title));
    const r2 = await draws.fire({ tenantId: t, draw: cab, send });
    assert.equal(r2.sent, true); assert.equal(Number(r2.invoice.amount), 33000);
    assert.equal(sent[0].to, 'ana@dw.test'); assert.match(sent[0].subject, /Invoice #/);
    // Completing bills the rest: 110,000 - 66,000.
    await crm.changeStage({ tenantId: t, dealId: deal.id, stage: 'production' });
    await crm.changeStage({ tenantId: t, dealId: deal.id, stage: 'complete' });
    l = await draws.listDraws(t, deal.id);
    assert.equal(Number(l.draws.find(d => d.pct == null).invoice_amount), 44000);
    // Save as the standard; a new job uses it.
    await draws.saveTemplateFromJob({ tenantId: t, dealId: deal.id });
    assert.equal((await draws.drawSettings(t)).custom, true);
    // Settings saved elsewhere keep the draw template (raw settings preserved).
    await crm.saveSettings(t, { waitingMinutes: 60 });
    assert.equal((await draws.drawSettings(t)).custom, true);
    assert.equal((await draws.drawSettings(t)).autoSend, true);

    // Pulse: off by default; on → a job in construction gets one check-in, in their language.
    const job = await crm.createDeal({ tenantId: t, name: 'Bo Lee', email: 'bo@dw.test', title: 'Bath', stage: 'production' });
    await query(`UPDATE crm_deals SET stage_entered_at = now() - interval '10 days' WHERE id = $1`, [job.id]);
    await crm.updateDeal({ tenantId: t, dealId: job.id, patch: { language: 'es' } });
    const wed = new Date(); wed.setUTCHours(16, 0, 0, 0); while (new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).format(wed) !== 'Wed') wed.setUTCDate(wed.getUTCDate() + 1);
    wed.setUTCHours(16, 0, 0, 0);
    sent.length = 0;
    assert.equal((await pulse.processPulses({ now: wed, send, baseUrl: 'https://x' })).sent, 0, 'off by default');
    await pulse.setPulse(t, true);
    assert.equal((await pulse.processPulses({ now: wed, send, baseUrl: 'https://x' })).sent, 1);
    assert.equal((await pulse.processPulses({ now: wed, send, baseUrl: 'https://x' })).sent, 0, 'once per two weeks');
    assert.match(sent[0].subject, /Cómo va su proyecto/); assert.match(sent[0].text, /\/pulse\/[0-9a-f]{48}\?s=5/);
    const token = /\/pulse\/([0-9a-f]{48})/.exec(sent[0].text)[1];
    assert.equal((await pulse.pulseInfo(token)).lang, 'es');
    await assert.rejects(pulse.answer({ token, score: 9 }), /1 to 5/);
    await pulse.answer({ token, score: 2 });
    await pulse.answer({ token, score: 2, comment: 'The crew left a mess' });
    const inbox = await crm.listInbox(t);
    assert.equal(inbox.filter(i => i.kind === 'unhappy').length, 1);
    assert.ok((await pulse.dealPulses(t, job.id))[0].comment === 'The crew left a mess');
    const facts = await rp.gatherFacts(t, { start: new Date(Date.now() - 7 * 86400000), end: new Date(Date.now() + 86400000) });
    assert.equal(facts.company.checkIns.low[0].score, 2);
    assert.ok(rp.writeByRules(facts).challenges.some(x => /crew left a mess/.test(x)));
    // Unsubscribed homeowners get nothing.
    await query(`INSERT INTO outreach_suppressions (tenant_id, email, reason) VALUES ($1, 'bo@dw.test', 'unsubscribed')`, [t]);
    const later = new Date(wed.getTime() + 15 * 86400000);
    assert.equal((await pulse.processPulses({ now: later, send, baseUrl: 'https://x' })).sent, 0);
    console.log('DRAW + PULSE SCENARIO PASSED');
  } finally { await query('DELETE FROM tenants WHERE id = $1', [t]); await pool.end(); }
})().catch(e => { console.error('FAILED', e); process.exit(1); });
