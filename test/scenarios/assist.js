delete process.env.RESEND_API_KEY; process.env.ANTHROPIC_API_KEY = 'test';
const assert = require('assert/strict');
const { R } = require('./_local');
let ai = [];
require.cache[require.resolve(R + '/lib/anthropic')] = { exports: { generateJSON: async (prompt) => {
  ai.push(prompt);
  if (/line items/.test(prompt)) { const id = /"id":"([0-9a-f-]{36})","name":"Quartz/.exec(prompt)[1]; return { lines: [{ section: 'Kitchen', description: 'Quartz counters', quantity: 48, unit: 'sf', unit_cost: 999, catalog_item_id: id }, { section: 'Kitchen', description: 'Demo and haul-off', quantity: 1, unit: 'ls', unit_cost: 1800, catalog_item_id: null }, { description: 'Weird', quantity: -2, unit: 'parsecs', unit_cost: -5 }], assumptions: ['A 12x14 kitchen'] }; }
  if (/update to a homeowner/.test(prompt)) return { update: /Spanish/.test(prompt) ? 'Hola Ana, esta semana terminamos el marco. ¡Saludos!' : 'Hi Ana, framing wrapped up this week and plumbing starts Monday.' };
  if (/in their voice/.test(prompt)) { const list = JSON.parse(/<emails>\n([\s\S]*?)\n<\/emails>/.exec(prompt)[1]); return { playbooks: list.map(p => ({ key: p.key, steps: p.steps.map(s => ({ subject: s.subject + ' (our voice)', message: s.message.replace('Hi {name}', 'Hey {name}') })) })) }; }
  return {};
} } };
const { query, pool } = require(R + '/db');
const crm = require(R + '/lib/crm'); const a = require(R + '/lib/crmAssist'); const pb = require(R + '/lib/crmPlaybooks');
const est = require(R + '/lib/crmEstimates'); const portal = require(R + '/lib/crmPortal'); const jobs = require(R + '/lib/crmJobs');
const b64 = (s) => Buffer.from(s).toString('base64');
(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Assist Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, phone, email, address) VALUES ($1, '713-555-0100', 'o@as.test', '1001 S Dairy Ashford, Houston TX 77077')`, [t]);
    // Import: preview guesses; rows come in without emails going out; re-import adds nothing; undo removes them.
    const csv = 'Client Name,Email,Phone,Address,City,Zip,Job Name,Contract Amount,Status,Lead Source,Date Created\n' +
      'Ana Ruiz,ana@as.test,713-555-0111,12 Oak Ln,Houston,77024,Kitchen remodel,"$85,000",Sold,Referral,2025-04-02\n' +
      'Bob Lee,bob@as.test,,4 Pine St,Houston,77079,Bath,22000,Closed Lost,HomeAdvisor,2025-06-10\n' +
      ',,,,,,,,,,\n' +
      'Cy Old,,713-555-0199,,,,,,In Progress,,\n';
    const prev = a.previewImport({ filename: 'bt.csv', dataBase64: b64(csv) });
    assert.equal(prev.rows, 3); assert.equal(prev.mapping[0], 'name'); assert.equal(prev.mapping[8], 'stage');
    const r1 = await a.runImport({ tenantId: t, filename: 'bt.csv', dataBase64: b64(csv), mapping: prev.mapping });
    assert.equal(r1.created, 3); assert.equal(r1.skipped, 0);
    const deals = (await query(`SELECT d.*, c.email FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id WHERE d.tenant_id = $1 ORDER BY d.created_at`, [t])).rows;
    const ana = deals.find(d => d.email === 'ana@as.test');
    assert.equal(ana.stage, 'signed'); assert.equal(Number(ana.value), 85000); assert.equal(ana.source, 'referral');
    assert.equal(new Date(ana.created_at).toISOString().slice(0, 10), '2025-04-02');
    assert.equal(deals.find(d => d.email === 'bob@as.test').stage, 'lost');
    assert.equal(deals.find(d => d.title && /Cy/.test(d.title) || d.stage === 'production').stage, 'production');
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM crm_playbook_sends WHERE tenant_id = $1`, [t])).rows[0].n, 0, 'no automatic emails');
    assert.equal((await crm.listInbox(t)).filter(i => i.kind === 'waiting_lead').length, 0, 'no waiting-lead alerts');
    const r2 = await a.runImport({ tenantId: t, filename: 'bt.csv', dataBase64: b64(csv), mapping: prev.mapping });
    assert.equal(r2.created, 0); assert.equal(r2.skipped, 3);
    await assert.rejects(a.runImport({ tenantId: t, filename: 'x.csv', dataBase64: b64('Foo,Bar\n1,2\n'), mapping: {} }), /name/);
    const undo = await a.undoImport({ tenantId: t, id: r1.id });
    assert.equal(undo.removed, 3);
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM crm_deals WHERE tenant_id = $1', [t])).rows[0].n, 0);
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM crm_contacts WHERE tenant_id = $1', [t])).rows[0].n, 0);
    await assert.rejects(a.undoImport({ tenantId: t, id: r1.id }), /already/);
    // Setup interview: settings change, and the unapproved first emails are rewritten in their voice.
    const list = await pb.listPlaybooks(t);
    await pb.approvePlaybook({ tenantId: t, id: list.find(p => p.key === 'welcome_aboard').id });
    const s = await a.applySetup({ tenantId: t, answers: { builds: ['kitchen_bath'], minJob: '40000', paidDesign: 'no', visitDays: [2, 4], replySpeed: 'now', warrantyMonths: 24, monthlyCapacity: '200000', about: 'Family-owned, plain-spoken.' } });
    assert.ok(s.notes.length >= 4);
    assert.deepEqual(s.rewritten.sort(), ['Getting ready for the site visit', 'Instant reply to new leads']);
    const after = await pb.listPlaybooks(t);
    assert.match(after.find(p => p.key === 'new_lead_reply').steps[0].message, /Hey \{name\}/);
    assert.equal(after.find(p => p.key === 'welcome_aboard').approved, true, 'approved wording is left alone');
    assert.deepEqual((await crm.getSettings(t)).hiddenStages, ['design_agreement', 'in_design']);
    assert.equal((await require(R + '/lib/crmQualify').qualifySettings(t)).minJobValue, 40000);
    assert.equal((await require(R + '/lib/crmMarketing').backlogSettings(t)).monthlyCapacity, 200000);
    // Estimate draft: catalog prices win, guesses are marked, nonsense is cleaned.
    const cat = await est.saveCatalogItem({ tenantId: t, body: { name: 'Quartz countertop, installed', unit: 'sf', unit_cost: 62, markup_pct: 30 } });
    const deal = await crm.createDeal({ tenantId: t, name: 'Ana Ruiz', email: 'ana2@as.test', title: 'Kitchen', stage: 'proposal' });
    const e = await est.createEstimate({ tenantId: t, dealId: deal.id });
    await assert.rejects(a.draftEstimate({ tenantId: t, estimateId: e.id, scope: 'short' }), /sentence/);
    const dr = await a.draftEstimate({ tenantId: t, estimateId: e.id, scope: 'Gut the kitchen, new quartz counters, demo and haul-off.' });
    const q = dr.lines.find(l => l.catalog_item_id === cat.id);
    assert.equal(q.unit_cost, 62); assert.equal(q.markup_pct, 30); assert.equal(q.guess, false);
    const demo = dr.lines.find(l => /Demo/.test(l.description));
    assert.equal(demo.guess, true); assert.equal(demo.unit, 'ls');
    const weird = dr.lines.find(l => l.description === 'Weird');
    assert.equal(weird.unit, 'ea'); assert.equal(weird.quantity, 1); assert.equal(weird.unit_cost, 0);
    assert.deepEqual(dr.assumptions, ['A 12x14 kitchen']);
    // Weekly update: nothing new → no draft; a finished phase → a draft in their language; posting clears it.
    await crm.changeStage({ tenantId: t, dealId: deal.id, stage: 'signed' });
    await crm.changeStage({ tenantId: t, dealId: deal.id, stage: 'production' });
    assert.equal(await a.draftJobUpdate({ tenantId: t, dealId: deal.id }), null);
    const items = await jobs.listSchedule(t, deal.id);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    await query(`UPDATE crm_job_items SET status = 'done', end_date = $2 WHERE id = $1`, [items[0].id, yesterday]);
    await crm.updateDeal({ tenantId: t, dealId: deal.id, patch: { language: 'es' } });
    const txt = await a.draftJobUpdate({ tenantId: t, dealId: deal.id });
    assert.match(txt, /Hola Ana/);
    assert.ok(ai.some(p => /update to a homeowner/.test(p) && /Spanish/.test(p) && !/plumber late/.test(p)));
    // Friday 11am Central: a draft and a Needs-you item, once.
    await query('UPDATE crm_deals SET update_draft = NULL, update_draft_at = NULL WHERE id = $1', [deal.id]);
    const fri = new Date(); fri.setUTCHours(16, 0, 0, 0); while (new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).format(fri) !== 'Fri') fri.setUTCDate(fri.getUTCDate() + 1);
    fri.setUTCHours(16, 0, 0, 0);
    const w1 = await a.processWeeklyUpdates({ now: fri });
    assert.ok(w1.drafted >= 1);
    assert.equal((await a.processWeeklyUpdates({ now: fri })).drafted, 0, 'once a week');
    assert.ok((await crm.listInbox(t, { now: fri })).some(i => i.kind === 'update_draft'));
    await portal.postUpdate({ tenantId: t, dealId: deal.id, body: 'Esta semana terminamos el marco.' });
    assert.equal((await crm.getDeal(t, deal.id)).update_draft, null);
    assert.ok(!(await crm.listInbox(t, { now: fri })).some(i => i.kind === 'update_draft'), 'posting clears the reminder');
    const tue = new Date(fri.getTime() - 3 * 86400000);
    assert.equal((await a.processWeeklyUpdates({ now: tue })).drafted, 0, 'only Fridays');
    console.log('ASSIST SCENARIO PASSED');
  } finally { await query('DELETE FROM tenants WHERE id = $1', [t]); await pool.end(); }
})().catch(e => { console.error('FAILED', e); process.exit(1); });
