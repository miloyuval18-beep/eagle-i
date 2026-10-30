// The everyday AI helpers, with the AI stubbed: lead summaries, next moves,
// reply drafts, overdue reminders, the voice job log, and the business tools.
const { R, endOfDay } = require('./_local');
const assert = require('assert/strict');
delete process.env.RESEND_API_KEY;
process.env.ANTHROPIC_API_KEY = 'test-only';
const sent = [];
const realEmail = require(R + '/lib/email');
require.cache[require.resolve(R + '/lib/email')].exports = { ...realEmail, sendEmail: async (m) => { sent.push(m); return { id: 'e' + sent.length }; } };
let reply = () => ({});
const prompts = [];
require.cache[require.resolve(R + '/lib/anthropic')] = { exports: { ...require(R + '/lib/anthropic'), generateJSON: async (p) => { prompts.push(p); return reply(p); } } };
const { query, pool } = require(R + '/db');
const crm = require(R + '/lib/crm'); const coach = require(R + '/lib/crmCoach'); const intake = require(R + '/lib/crmIntake');
const jobs = require(R + '/lib/crmJobs'); const pay = require(R + '/lib/crmPayments'); const A = require(R + '/lib/crmAssistant');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Coach Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, email, address, founder_name) VALUES ($1, 'o@coach.test', '1001 S Dairy Ashford, Houston TX 77077', 'Sam')`, [t]);
    await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'sam@coach.test', 'x', 'Sam Rivera', 'owner')`, [t]);
    // 1. A lead from the form: summarized, and the team's alert carries it.
    reply = (p) => /new lead just came in/.test(p) ? { lines: ['Wants: a kitchen remodel with an island', 'Budget: likely $80k–$120k (home value ~$900k), fairly sure', 'Next: call today and book a visit this week'] } : {};
    const key = await intake.getIntakeKey(t);
    await intake.submitForm({ key, body: { name: 'Maria Garcia', email: 'maria@coach.test', phone: '7135550100', address: '12 River Oaks Blvd, Houston TX 77019', message: 'Kitchen with an island, old cabinets' } });
    for (let i = 0; i < 40 && !(await query(`SELECT 1 FROM crm_team_mail WHERE tenant_id = $1 AND subject LIKE 'New lead%'`, [t])).rows.length; i++) await wait(100);
    await endOfDay(t);
    const alert = sent.find(m => /New lead/.test(m.text));
    assert.match(alert.text, /Wants: a kitchen remodel/); assert.match(alert.text, /In their words: Kitchen with an island/);
    const deal = (await query(`SELECT d.* FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id WHERE c.email = 'maria@coach.test'`)).rows[0];
    assert.match(deal.lead_summary, /Budget: likely \$80k/);
    assert.equal(prompts.filter(p => /new lead just came in/.test(p)).length, 1, 'written once, shared by the deal and the alert');
    // Without AI: still a useful summary.
    assert.match(coach.leadSummaryByRules({ title: 'Bath', value: 30000, contact_phone: '713' }), /Budget: around \$30,000/);
    // 2. Next move, and stalled deals get it on their Needs-you item.
    reply = (p) => /coach the salesperson/.test(p) ? { advice: 'Call Maria and offer two visit times this week.', why: 'She asked about timing and nobody answered.', draft: { subject: 'Visit times', message: 'Hi Maria, would Tue or Thu work?' } } : {};
    const nm = await coach.nextMove(t, deal.id);
    assert.equal(nm.by, 'ai'); assert.match(nm.advice, /two visit times/);
    await crm.addInboxItem({ tenantId: t, dealId: deal.id, kind: 'stalled', dedupeKey: 'stalled:test', title: 'Quiet', detail: '9 days quiet.' });
    await query(`UPDATE crm_deals SET next_move_at = now() - interval '1 day' WHERE id = $1`, [deal.id]);
    await query(`UPDATE crm_inbox SET created_at = now() WHERE dedupe_key = 'stalled:test'`);
    assert.equal((await coach.adviseStalled()).advised >= 1, true);
    assert.match((await crm.listInbox(t)).find(i => i.dedupe_key === 'stalled:test').detail, /Suggested: Call Maria/);
    // 3. A homeowner email: a reply drafted in her language, sent from the deal.
    await query(`INSERT INTO crm_emails (tenant_id, message_key, mailbox_email, direction, from_email, to_emails, subject, body_text, sent_at, contact_id, deal_id)
      VALUES ($1, '<q1@x>', 'sam@coach.test', 'in', 'maria@coach.test', '{sam@coach.test}', 'Island size', 'How big can the island be? We want seating for 4.', now(), $2, $3)`, [t, deal.contact_id, deal.id]);
    reply = (p) => /Draft a reply/.test(p) ? { subject: 'Re: Island size', message: 'Hi Maria, seating for 4 needs about 8 feet. We will measure at the visit. Sam' } : {};
    const dr = await coach.draftReply(t, deal.id);
    assert.match(dr.message, /8 feet/); assert.equal(dr.replyingTo.subject, 'Island size');
    assert.ok(prompts.some(p => /seating for 4/.test(p) && /English/.test(p)));
    sent.length = 0;
    await coach.emailHomeowner({ tenantId: t, dealId: deal.id, subject: dr.subject, message: dr.message });
    assert.equal(sent[0].to, 'maria@coach.test');
    assert.equal((await query(`SELECT draft_reply FROM crm_emails WHERE deal_id = $1`, [deal.id])).rows[0].draft_reply, null, 'sent: the draft is cleared');
    await assert.rejects(coach.emailHomeowner({ tenantId: t, dealId: deal.id, subject: '', message: 'x' }), /subject/);
    // 4. An invoice 10 days overdue: a reminder drafted (the AI's, since it kept the pay link), sent with one tap, not again for a week.
    const inv = await pay.createInvoice({ tenantId: t, dealId: deal.id, kind: 'deposit', title: 'Deposit', amount: 5000, dueDate: new Date(Date.now() - 10 * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }) });
    await query(`UPDATE crm_invoices SET status = 'sent' WHERE id = $1`, [inv.id]);
    reply = (p) => { if (!/payment reminder/.test(p)) return {}; const link = /"payLink":"([^"]+)"/.exec(p)[1]; return { subject: 'Deposit reminder', message: `Hi Maria, a quick reminder about the $5,000 deposit. Pay here: ${link}` }; };
    let c = await coach.scanCollections();
    assert.equal(c.drafted, 1);
    const item = (await crm.listInbox(t)).find(i => i.kind === 'collect');
    assert.match(item.title, /10 days overdue/);
    assert.equal((await coach.scanCollections()).drafted, 0, 'not again this week');
    sent.length = 0;
    await coach.sendNudge({ tenantId: t, nudgeId: item.dedupe_key.slice(6) });
    assert.match(sent[0].text, /\/i\/[0-9a-f]{48}/);
    assert.ok(!(await crm.listInbox(t)).some(i => i.kind === 'collect'), 'cleared once sent');
    await assert.rejects(coach.sendNudge({ tenantId: t, nudgeId: item.dedupe_key.slice(6) }), /already/);
    // An AI draft that drops the pay link isn't used: the plain one is.
    await query(`UPDATE crm_invoice_nudges SET created_at = now() - interval '8 days' WHERE invoice_id = $1`, [inv.id]);
    reply = (p) => /payment reminder/.test(p) ? { subject: 'x', message: 'Please pay soon.' } : {};
    c = await coach.scanCollections();
    const second = (await query(`SELECT message FROM crm_invoice_nudges WHERE invoice_id = $1 ORDER BY created_at DESC LIMIT 1`, [inv.id])).rows[0];
    assert.match(second.message, /\/i\//); assert.match(second.message, /Following up/);
    // 5. The voice job log: cleaned up, phases moved, a task and an issue.
    await crm.changeStage({ tenantId: t, dealId: deal.id, stage: 'signed' });
    reply = (p) => /crew lead dictated/.test(p) ? { log: 'Demo finished. Started framing the island wall. Found rot under the sink.', finished: ['Demolition'], started: ['Framing'], issues: ['Rot under the sink subfloor'], tasks: [{ title: 'Order subfloor plywood', due_in_days: 1 }] } : {};
    const v = await coach.fileVoiceLog({ tenantId: t, dealId: deal.id, text: 'uh demo is done started framing the island wall found some rot under the sink' });
    assert.deepEqual(v.phases.sort(), ['Demolition: done', 'Framing: started']);
    assert.deepEqual(v.tasks, ['Order subfloor plywood']);
    assert.ok((await crm.listInbox(t)).some(i => i.kind === 'site_issue' && /Rot under the sink/.test(i.title)));
    const items = await jobs.listSchedule(t, deal.id);
    assert.equal(items.find(i => i.title === 'Demolition').status, 'done');
    // 6. Business questions the assistant can now answer.
    const ctx = { tenantId: t, userId: null, manager: true, baseUrl: '' };
    await query(`UPDATE crm_deals SET stage = 'complete', value = 100000 WHERE id = $1`, [deal.id]);
    await query(`INSERT INTO crm_costs (tenant_id, deal_id, category, amount, cost_date) VALUES ($1, $2, 'materials', 70000, CURRENT_DATE)`, [t, deal.id]);
    const m = await A.TOOLS.job_margins.run(ctx, {});
    assert.equal(m.byKind.kitchen.averageMargin, 30);
    const w = await A.TOOLS.win_rates.run(ctx, { by: 'source' });
    assert.equal(w.groups[0].won, 1);
    const sp = await A.TOOLS.sub_prices.run(ctx, { trade: 'framing' });
    assert.deepEqual(sp.bids, []);
    const ls = await A.TOOLS.lead_sources.run(ctx, {});
    assert.ok(ls.channels.some(x => x.source === 'Website'));
    console.log('COACH SCENARIO PASSED');
  } finally { await query('DELETE FROM tenants WHERE id = $1', [t]); await pool.end(); }
})().catch(e => { console.error('FAILED', e); process.exit(1); });
