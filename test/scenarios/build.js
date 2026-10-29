// From priced to built: a design package read apart from the plans (its products used,
// marked); the job's own schedule (from the plans, by trade) laid out on signing, with
// the winning sub on every phase of their trade; purchase orders timed to their phase
// and the supplier's lead time, reminded before the order-by date and again on it,
// never sent by Eagle I, and moved when the phase moves; the permits the plans need
// put on the job, warned about when they hold up a phase, their inspections due when
// the phase before is done, checked on when stuck; worked out for a job not priced
// from plans; and in a project manager's daily check-in.
const { R } = require('./_local');
const assert = require('assert/strict');
process.env.ANTHROPIC_API_KEY = 'test-only'; process.env.RESEND_API_KEY = 'test-only'; delete process.env.GOOGLE_PLACES_API_KEY;
const { query, pool } = require(R + '/db');
const sent = [];
const sender = async (m) => { sent.push(m); return { id: 'e' + sent.length }; };
const realEmail = require(R + '/lib/email');
require.cache[require.resolve(R + '/lib/email')].exports = { ...realEmail, sendEmail: sender };

const READING = {
  project: 'Kitchen remodel', summary: 'New cabinets and plumbing in the kitchen.',
  sections: [{ trade: 'Plumbing', work: ['Move the sink supply and drain.'] }, { trade: 'Cabinets', work: ['Install new shaker cabinets.'] }],
  exclusions: [], assumptions: [], questions: ['Hardware finish not in the design package.'],
  materials: [
    { name: 'Shaker cabinets', spec: 'Brand X Shaker, white, per design package sheet D2', quantity: 18, unit: 'lf', trade: 'Cabinets', how: 'Elevation D2', confidence: 'high', source: 'design', rough_unit_cost: 300 },
    { name: 'PEX supply line', spec: '1/2 in', quantity: 60, unit: 'lf', trade: 'Plumbing', how: 'Plan P1', confidence: 'medium', source: 'plans', rough_unit_cost: 1 }
  ],
  packages: [
    { kind: 'sub', trade: 'Plumbing', label: 'Plumbing', search: 'plumbing contractor', scope: 'Rough and trim plumbing.', materials: [1], rough_labor: 3000 },
    { kind: 'supplier', trade: 'Cabinets', label: 'Cabinets', search: 'cabinet supplier', materials: [0], lead_days: 15, needed_for: 'Cabinets' }
  ],
  schedule: [
    { phase: 'Demolition', trade: 'Framing', days: 3 }, { phase: 'Rough plumbing', trade: 'Plumbing', days: 4 }, { phase: 'Rough-in inspection', trade: 'Inspection', days: 1 },
    { phase: 'Drywall', trade: 'Drywall', days: 5 }, { phase: 'Cabinets', trade: 'Cabinets', days: 3 }, { phase: 'Plumbing trim', trade: 'Plumbing', days: 2 }, { phase: 'Final inspection', trade: 'Inspection', days: 1 }
  ],
  permits: [
    { kind: 'building', title: 'Building permit (remodel)', authority: 'City of Houston', why: 'Moving plumbing and a kitchen remodel.', before_phase: 'Demolition', inspections: [{ name: 'Final building inspection', after_phase: 'Plumbing trim' }] },
    { kind: 'plumbing', title: 'Plumbing permit', authority: 'City of Houston', why: 'New supply and drain.', before_phase: 'Rough plumbing', inspections: [{ name: 'Rough-in plumbing inspection', after_phase: 'Rough plumbing' }] }
  ]
};
const prompts = [];
const A0 = require(R + '/lib/anthropic');
require.cache[require.resolve(R + '/lib/anthropic')].exports = { ...A0, generateJSON: async (p, max, opts) => {
  prompts.push({ p, opts });
  if (/You are the estimator/.test(p)) return JSON.parse(JSON.stringify(READING));
  if (/Work out the permits this job needs/.test(p)) return { permits: [{ kind: 'building', title: 'Building permit (deck)', authority: 'City of Houston', why: 'A new deck over 200 sf.', before_phase: 'Framing', inspections: [{ name: 'Footing inspection', after_phase: 'Demolition' }] }] };
  return {};
} };

const P = require(R + '/lib/crmPricing'), O = require(R + '/lib/crmOrdering'), PM = require(R + '/lib/crmPermits');
const bids = require(R + '/lib/crmBids'), crm = require(R + '/lib/crm'), jobs = require(R + '/lib/crmJobs');
const tag = Date.now().toString(36);
const noon = (day) => new Date(day + 'T17:00:00Z'); // noon Central

(async () => {
  // Pure: lead times as suppliers write them; order-by dates.
  assert.equal(O.parseLeadDays('In stock'), 1); assert.equal(O.parseLeadDays('2 weeks'), 10); assert.equal(O.parseLeadDays('2-3 weeks'), 15);
  assert.equal(O.parseLeadDays('10 business days'), 10); assert.equal(O.parseLeadDays('6 wks'), 30); assert.equal(O.parseLeadDays('7 days'), 5); assert.equal(O.parseLeadDays('call us'), null);
  assert.equal(O.orderByFor('2026-11-20', 3), '2026-11-13', 'Fri 20th less 3 + 2 working days');
  assert.equal(O.shiftWorkdays('2026-11-02', -1), '2026-10-30', 'back over a weekend');

  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Build Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    const add = async (local, name, role) => (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role, app) VALUES ($1, $2, 'x', $3, $4, 'crm') RETURNING *`, [t, `${local}.${tag}@bd.dev`, name, role])).rows[0];
    const owner = await add('olive', 'Olive Owner', 'owner');
    const pm = await add('dana', 'Dana Cruz', 'project_manager');
    const deal = await crm.createDeal({ tenantId: t, name: 'Kim Lee', title: 'Lee kitchen', address: '5 Pine St, Houston, TX 77007', stage: 'estimate', userId: owner.id });
    await query(`UPDATE crm_deals SET pm_user_id = $2 WHERE id = $1`, [deal.id, pm.id]);
    const pdf = `'\\x255044462d312e340a'::bytea`;
    await query(`INSERT INTO crm_files (tenant_id, deal_id, filename, content_type, size, data) VALUES ($1, $2, 'A1 plans.pdf', 'application/pdf', 9, ${pdf}), ($1, $2, 'Finish schedule.pdf', 'application/pdf', 9, ${pdf})`, [t, deal.id]);
    await query(`INSERT INTO crm_vendors (tenant_id, name, trade, email) VALUES ($1, 'Bayou Plumbing', 'Plumbing', 'office@bayou.dev'), ($1, 'Cabinet Co', 'Cabinets', 'sales@cabco.dev')`, [t]);

    // 1. The design package: guessed from its name, told to the AI as the source of finishes; materials say where they came from.
    let run = await P.start({ tenantId: t, dealId: deal.id, userId: owner.id, wait: true });
    assert.equal(run.status, 'review', run.error || '');
    const roles = Object.values(run.fileRoles).sort();
    assert.deepEqual(roles, ['design', 'plans']);
    const read = prompts.find(x => /You are the estimator/.test(x.p)).p;
    assert.match(read, /The design package is: Finish schedule\.pdf/); assert.match(read, /design package wins/); assert.match(read, /Finish schedule\.pdf \(design package\)/);
    assert.equal(run.materials[0].source, 'design');
    assert.equal(run.schedule.length, 7); assert.equal(run.permits.length, 2);
    assert.equal(run.packages.find(p => p.trade === 'Cabinets').leadDays, 15);
    // The person's pick wins over the guess.
    const files = await P.planFiles(t, deal.id);
    const r2 = await P.start({ tenantId: t, dealId: (await crm.createDeal({ tenantId: t, name: 'X', title: 'X job', stage: 'estimate', userId: owner.id })).id, userId: owner.id, wait: true }).catch(e => e);
    assert.match(String(r2.message || ''), /Add the plans/, 'a deal with no plans says so');
    assert.ok(files.length === 2);

    // 2. Priced: the cabinet supplier says two weeks.
    await P.send({ tenantId: t, id: run.id, baseUrl: 'https://app.test', send: sender });
    const reqs = (await query(`SELECT b.token, v.name FROM crm_bid_requests b JOIN crm_vendors v ON v.id = b.vendor_id WHERE b.run_id = $1`, [run.id])).rows;
    await bids.submitBid({ token: reqs.find(r => r.name === 'Cabinet Co').token, lines: [{ i: 0, unit_price: 280 }], leadTime: '2 weeks' });
    await bids.submitBid({ token: reqs.find(r => r.name === 'Bayou Plumbing').token, amount: 3200 });
    assert.equal((await P.getRun(t, run.id)).status, 'priced');

    // 3. Signed: this job's schedule (not the template), the plumber on both plumbing phases, the order timed.
    sent.length = 0;
    await crm.changeStage({ tenantId: t, dealId: deal.id, stage: 'signed', userId: owner.id });
    const items = (await query(`SELECT i.id, i.title, i.trade, i.start_date, i.end_date, v.name AS sub FROM crm_job_items i LEFT JOIN crm_vendors v ON v.id = i.vendor_id WHERE i.deal_id = $1 ORDER BY i.position`, [deal.id])).rows;
    assert.deepEqual(items.map(i => i.title), READING.schedule.map(s => s.phase));
    assert.deepEqual(items.filter(i => i.sub).map(i => [i.title, i.sub]), [['Rough plumbing', 'Bayou Plumbing'], ['Plumbing trim', 'Bayou Plumbing']]);
    const ymd = (d) => d.toISOString().slice(0, 10);
    const cab = items.find(i => i.title === 'Cabinets');
    let po = (await query(`SELECT * FROM crm_purchase_orders WHERE deal_id = $1`, [deal.id])).rows[0];
    assert.equal(po.job_item_id, cab.id); assert.equal(po.lead_days, 10, 'what the supplier said, not the usual 15');
    assert.equal(ymd(po.needed_by), ymd(cab.start_date));
    const orderBy = O.orderByFor(ymd(cab.start_date), 10);
    assert.equal(ymd(po.order_by), orderBy);
    assert.equal(po.status, 'draft');

    // 4. Reminders: nothing early; two working days ahead "ready"; on the day "order today"; never sent to the supplier.
    const at = (day) => O.processOrdering({ now: noon(day), send: sender, appUrl: 'https://app.test', tenantId: t });
    sent.length = 0;
    assert.deepEqual(await at(O.shiftWorkdays(orderBy, -3)), { ready: 0, due: 0 });
    assert.deepEqual(await at(O.shiftWorkdays(orderBy, -2)), { ready: 1, due: 0 });
    assert.deepEqual(await at(O.shiftWorkdays(orderBy, -1)), { ready: 0, due: 0 }, 'once');
    assert.equal(sent.length, 1); assert.equal(sent[0].to, pm.email, 'to the project manager'); assert.match(sent[0].subject, /Ready to order by/); assert.match(sent[0].html, /Nothing goes to the supplier until you send it/);
    assert.deepEqual(await at(orderBy), { ready: 0, due: 1 });
    assert.match(sent[1].subject, /Order today for Lee kitchen/);
    assert.ok(!sent.some(m => m.to === 'sales@cabco.dev'), 'never to the supplier');
    assert.equal((await query(`SELECT status FROM crm_purchase_orders WHERE id = $1`, [po.id])).rows[0].status, 'draft');
    assert.ok((await query(`SELECT 1 FROM crm_inbox WHERE tenant_id = $1 AND kind = 'order' AND status = 'open' AND title LIKE 'Order today%'`, [t])).rows.length);
    assert.ok(!(await query(`SELECT 1 FROM crm_inbox WHERE tenant_id = $1 AND kind = 'order' AND status = 'open' AND title LIKE 'Ready to order%'`, [t])).rows.length, 'the heads-up is replaced');

    // 5. The phase moves a week earlier: the order moves with it and is flagged again.
    const earlier = O.shiftWorkdays(ymd(cab.start_date), -5);
    await jobs.saveItem({ tenantId: t, dealId: deal.id, id: cab.id, body: { title: 'Cabinets', startDate: earlier, endDate: O.shiftWorkdays(earlier, 2), status: 'todo', vendorId: null } });
    po = (await query(`SELECT * FROM crm_purchase_orders WHERE id = $1`, [po.id])).rows[0];
    assert.equal(ymd(po.needed_by), earlier); assert.equal(ymd(po.order_by), O.orderByFor(earlier, 10)); assert.equal(po.ready_flagged_at, null);
    sent.length = 0;
    assert.equal((await at(ymd(po.order_by))).due, 1);
    // Sent by a person: no more reminders.
    await jobs.sendPO({ tenantId: t, id: po.id, send: sender });
    assert.equal(sent[sent.length - 1].to, 'sales@cabco.dev');
    assert.deepEqual(await at(O.shiftWorkdays(ymd(po.order_by), 1)), { ready: 0, due: 0 });

    // 6. Permits from the plans on the job, linked to their phases and inspections.
    let pl = await PM.list(t, deal.id);
    assert.deepEqual(pl.map(p => [p.title, p.status, p.beforePhase]), [['Building permit (remodel)', 'needed', 'Demolition'], ['Plumbing permit', 'needed', 'Rough plumbing']]);
    const rough = items.find(i => i.title === 'Rough plumbing');
    assert.equal(pl[1].inspections[0].afterItemId, rough.id);
    // Holding up a phase that starts within 10 working days: Needs you and the project manager, once.
    sent.length = 0;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    let z = await PM.processPermits({ now: noon(today), send: sender, appUrl: 'https://app.test', tenantId: t });
    assert.equal(z.holding, 2); assert.ok(sent.every(m => m.to === pm.email)); assert.match(sent[0].html, /Apply with City of Houston now/);
    assert.equal((await PM.processPermits({ now: noon(today), send: sender, tenantId: t })).holding, 0, 'once');
    // Approved: its warnings go.
    await PM.save({ tenantId: t, id: pl[0].id, body: { status: 'approved', permitNo: 'B-2026-1' } });
    assert.ok(!(await query(`SELECT 1 FROM crm_inbox WHERE tenant_id = $1 AND dedupe_key LIKE $2 AND status = 'open'`, [t, `permit:${pl[0].id}:%`])).rows.length);
    pl = await PM.list(t, deal.id);
    assert.equal(pl.find(p => p.permitNo === 'B-2026-1').approvedAt, today, 'approved today when no date given');
    // The phase before an inspection is done: the inspection is due.
    await jobs.saveItem({ tenantId: t, dealId: deal.id, id: rough.id, body: { title: 'Rough plumbing', startDate: ymd(rough.start_date), endDate: ymd(rough.end_date), status: 'done', vendorId: null } });
    pl = await PM.list(t, deal.id);
    assert.equal(pl.find(p => p.title === 'Plumbing permit').inspections[0].status, 'due');
    assert.ok((await query(`SELECT 1 FROM crm_inbox WHERE tenant_id = $1 AND title = 'Book the Rough-in plumbing inspection for Lee kitchen'`, [t])).rows.length);
    // Submitted three weeks ago with no news: check on it.
    const plumb = pl.find(p => p.title === 'Plumbing permit');
    await PM.save({ tenantId: t, id: plumb.id, body: { status: 'submitted' } });
    await query(`UPDATE crm_permits SET status_changed_at = now() - interval '30 days' WHERE id = $1`, [plumb.id]);
    assert.equal((await PM.processPermits({ now: noon(today), send: sender, tenantId: t })).stale, 1);

    // 7. A project manager's check-in asks about permits not approved yet on their projects.
    await query(`UPDATE crm_deals SET stage = 'production' WHERE id = $1`, [deal.id]);
    const ctx = await require(R + '/lib/crmCheckins').dayContext(await require(R + '/lib/crmTeam').getUser(pm.id), today);
    const m = ctx.managed.find(x => x.title === 'Lee kitchen');
    assert.ok(m && m.permits && m.permits.some(x => /Plumbing permit: submitted/.test(x)), JSON.stringify(ctx.managed));
    assert.ok(!('id' in m), 'ids stay out of the AI’s view');

    // 8. A job not priced from plans: Eagle I works out the permits.
    const deck = await crm.createDeal({ tenantId: t, name: 'Ray Fox', title: 'Fox deck', address: '9 Oak St, Houston, TX 77008', stage: 'signed', userId: owner.id });
    await jobs.createScheduleFromTemplate({ tenantId: t, dealId: deck.id });
    const s = await PM.suggest({ tenantId: t, dealId: deck.id, userId: owner.id });
    assert.equal(s.added, 1); assert.equal(s.permits[0].beforePhase, 'Framing', 'linked to the template’s phase');
    assert.equal((await PM.suggest({ tenantId: t, dealId: deck.id })).added, 0, 'not twice');
    console.log('BUILD SCENARIO PASSED');
  } catch (e) {
    console.error('BUILD SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM tenants WHERE id = $1', [t]).catch(() => {});
    await pool.end();
  }
})();
