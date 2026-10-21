// The rest of the AI features, with the AI stubbed: estimate checks and
// proposals, takeoffs, the change-order catcher, job outlook, bills matched to
// POs, products and selection ideas, the portal assistant, punch lists, photo
// checks, coaching, win/loss and the design visualizer.
const { R } = require('./_local');
const assert = require('assert/strict');
delete process.env.RESEND_API_KEY;
process.env.ANTHROPIC_API_KEY = 'test-only';
const sent = [];
const realEmail = require(R + '/lib/email');
require.cache[require.resolve(R + '/lib/email')].exports = { ...realEmail, sendEmail: async (m) => { sent.push(m); return { id: 'e' + sent.length }; } };
let reply = () => ({});
const prompts = [];
require.cache[require.resolve(R + '/lib/anthropic')] = { exports: { ...require(R + '/lib/anthropic'), generateJSON: async (p, max, opts) => { prompts.push({ p, opts }); return reply(p, opts); } } };
const { query, pool } = require(R + '/db');
const crm = require(R + '/lib/crm'); const E = require(R + '/lib/crmEstimates'); const jobs = require(R + '/lib/crmJobs'); const costs = require(R + '/lib/crmCosts');
const estAi = require(R + '/lib/crmEstimateAi'); const catcher = require(R + '/lib/crmChangeCatcher'); const fc = require(R + '/lib/crmForecast');
const products = require(R + '/lib/crmProducts'); const portalAi = require(R + '/lib/crmPortalAi'); const portal = require(R + '/lib/crmPortal');
const photoAi = require(R + '/lib/crmPhotoAi'); const coaching = require(R + '/lib/crmCoaching'); const vis = require(R + '/lib/crmVisualizer'); const A = require(R + '/lib/crmAssistant');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString('base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
const ymd = (d) => d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); // Houston calendar days, like the app
const days = (n) => new Date(Date.now() + n * 86400000);
(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Plus Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, email, address, founder_name) VALUES ($1, 'o@plus.test', '1001 S Dairy Ashford, Houston TX 77077', 'Sam')`, [t]);
    const u = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'sam@plus.test', 'x', 'Sam Rivera', 'owner') RETURNING id`, [t])).rows[0].id;
    const u2 = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'alex@plus.test', 'x', 'Alex Kim', 'member') RETURNING id`, [t])).rows[0].id;
    const deal = await crm.createDeal({ tenantId: t, name: 'Maria Garcia', email: 'maria@plus.test', phone: '7135550100', address: '12 River Oaks Blvd, Houston TX 77019', title: 'Kitchen remodel', value: 90000, userId: u });

    // 1. Estimate check: rules catch the usual misses; AI adds one; catalog prices the fix.
    await query(`INSERT INTO crm_catalog_items (tenant_id, name, unit, unit_cost, category) VALUES ($1, 'Dumpster and debris haul-off (20 yd)', 'ea', 650, 'other'), ($1, 'Duplex outlet, new circuit', 'ea', 140, 'labor')`, [t]);
    const est0 = await E.createEstimate({ tenantId: t, dealId: deal.id, userId: u });
    const lines = [
      { section: 'Kitchen', description: 'Demo existing kitchen', quantity: 1, unit: 'ls', unit_cost: 3500, markup_pct: 25 },
      { section: 'Kitchen', description: 'Shaker cabinets, installed', quantity: 24, unit: 'lf', unit_cost: 420, markup_pct: 25 },
      { section: 'Kitchen', description: 'Quartz countertops', quantity: 60, unit: 'sf', unit_cost: 75, markup_pct: 25 },
      { section: 'Kitchen', description: 'Tile backsplash', quantity: 40, unit: 'sf', unit_cost: 0, markup_pct: 25 }
    ];
    await E.saveEstimate({ tenantId: t, id: est0.id, body: { title: 'Kitchen remodel', kind: 'construction', default_markup_pct: 25, tax_pct: 0, deposit_pct: 10, lines, terms: '' } });
    reply = (p) => /double-checking a residential remodeling estimate/.test(p) ? { items: [{ text: 'Sink and faucet aren’t listed, but the kitchen is gutted.', add: { description: 'Sink, faucet and disposal', section: 'Kitchen', unit: 'ea', quantity: 1 } }] } : {};
    const rv = await estAi.checkEstimate(t, est0.id);
    const keys = rv.items.map(i => i.key);
    for (const k of ['permit', 'dumpster', 'protect', 'clean', 'pm', 'plumb', 'elec', 'backer', 'hardware', 'zero', 'terms']) assert.ok(keys.includes(k), `flags ${k}`);
    assert.ok(rv.items.find(i => i.key === 'dumpster').add.unit_cost === 650, 'the haul-off line is priced from the catalog');
    assert.ok(rv.items.some(i => i.level === 'ai' && /Sink/.test(i.text)));
    assert.ok(!keys.includes('waterproof'), 'no shower, no waterproofing note');
    assert.ok(!keys.includes('contingency'), 'a $22k job doesn’t need the contingency note');
    assert.ok((await query('SELECT review FROM crm_estimates WHERE id = $1', [est0.id])).rows[0].review.items.length === rv.items.length, 'the review is kept');

    // 2. Proposal: written, shown on the homeowner's page only once switched on.
    reply = (p) => /Write a proposal for a homeowner/.test(p) ? { letter: 'Hi Maria, thank you…', scope: [{ section: 'Kitchen', text: 'We take the kitchen down to the studs and build it back with shaker cabinets and quartz.' }], included: ['Cabinets and counters'], excluded: ['Appliances'], timeline: 'About 6 weeks.', nextSteps: ['Accept online', 'Pay the deposit'], whyUs: '' } : {};
    const pr = await estAi.writeProposal(t, est0.id);
    assert.equal(pr.by, 'ai'); assert.equal(pr.published, false);
    await E.sendEstimate({ tenantId: t, id: est0.id, userId: u, baseUrl: 'https://app.test' }).catch(() => {});
    await query(`UPDATE crm_estimates SET status = 'sent', sent_at = now() WHERE id = $1`, [est0.id]);
    const tok = (await query('SELECT public_token FROM crm_estimates WHERE id = $1', [est0.id])).rows[0].public_token;
    assert.equal((await E.getByToken(tok)).view.proposal, null, 'not shown until switched on');
    await estAi.saveProposal(t, est0.id, { ...pr, published: true });
    const pv = (await E.getByToken(tok)).view.proposal;
    assert.match(pv.scope[0].text, /down to the studs/); assert.deepEqual(pv.excluded, ['Appliances']);
    assert.ok(!JSON.stringify((await E.getByToken(tok)).view).includes('unit_cost'), 'no costs on the homeowner view');
    // Without AI, a usable proposal from the lines.
    const byRules = estAi.proposalByRules({ est: await E.getEstimate(t, est0.id), co: { company_name: 'Plus Co', founder_name: 'Sam' }, weeks: 6, lang: 'es' });
    assert.match(byRules.letter, /Hola Maria/); assert.match(byRules.timeline, /6 semanas/);

    // 3. Takeoff: read from a plan, checked by a person, then onto an estimate.
    const plan = await portal.addFile({ tenantId: t, dealId: deal.id, filename: 'plans.pdf', dataBase64: PDF, userId: u });
    reply = (p, o) => /quantity takeoff/.test(p) ? { scale: '1/4" = 1\'-0" (title block)', notes: 'Sheet A1 only.', items: [{ name: 'Kitchen floor area', quantity: 180, unit: 'sf', how: "12'-0\" x 15'-0\"", where: 'A1, Kitchen', confidence: 'high', trade: 'Flooring' }, { name: 'Base trim', quantity: null, unit: 'lf', how: 'no dimensions on the north wall', where: 'A1', confidence: 'low', trade: 'Finishes' }] } : {};
    const tk = await estAi.readTakeoff({ tenantId: t, dealId: deal.id, fileId: plan.id, userId: u });
    assert.equal(prompts[prompts.length - 1].opts.images[0].mediaType, 'application/pdf', 'the PDF is sent as a document');
    assert.equal(tk.items.length, 2); assert.equal(tk.items[1].quantity, null);
    await assert.rejects(estAi.takeoffToEstimate({ tenantId: t, id: tk.id }), /Check at least one/);
    await estAi.saveTakeoff({ tenantId: t, id: tk.id, items: [{ i: 0, checked: true, quantity: 182, name: 'Kitchen floor area', unit: 'sf' }, { i: 1, checked: true, quantity: '', unit: 'lf' }] });
    const added = await estAi.takeoffToEstimate({ tenantId: t, id: tk.id, userId: u });
    assert.equal(added.added, 1, 'an unmeasured item can’t be checked');
    const est1 = await E.getEstimate(t, added.estimateId);
    assert.ok(est1.lines.some(l => l.description === 'Kitchen floor area' && Number(l.quantity) === 182 && l.unit === 'sf'));
    assert.notEqual(est1.id, est0.id, 'a new draft, since the first one was sent');

    // 4. Signed job: schedule, budget, a PO, a bill.
    await query(`UPDATE crm_estimates SET status = 'accepted', accepted_at = now() WHERE id = $1`, [est0.id]);
    await crm.changeStage({ tenantId: t, dealId: deal.id, stage: 'production', userId: u });
    await query('DELETE FROM crm_job_items WHERE deal_id = $1', [deal.id]);
    const vendor = await jobs.saveVendor({ tenantId: t, body: { name: 'Gulf Coast Supply LLC', email: 'orders@gulf.test', insuranceExpires: ymd(days(2)) } });
    const it1 = await jobs.saveItem({ tenantId: t, dealId: deal.id, body: { title: 'Demolition', startDate: ymd(days(-12)), endDate: ymd(days(-8)), status: 'done' } });
    const it2 = await jobs.saveItem({ tenantId: t, dealId: deal.id, body: { title: 'Rough plumbing', startDate: ymd(days(-6)), endDate: ymd(days(-3)), status: 'doing' } });
    const it3 = await jobs.saveItem({ tenantId: t, dealId: deal.id, body: { title: 'Cabinets', startDate: ymd(days(3)), endDate: ymd(days(8)), status: 'todo', vendorId: vendor.id } });
    await query(`UPDATE crm_job_items SET confirm_status = 'conflict' WHERE id = $1`, [it3.id]);
    const po = await jobs.createPO({ tenantId: t, dealId: deal.id, vendorId: vendor.id, title: 'Cabinet boxes', lines: [{ description: 'Base cabinets', quantity: 10, unit_cost: 400 }, { description: 'Wall cabinets', quantity: 8, unit_cost: 250 }], neededBy: ymd(days(2)), userId: u });
    await query(`UPDATE crm_purchase_orders SET status = 'sent', sent_at = now() WHERE id = $1`, [po.id]);
    await jobs.saveSelection({ tenantId: t, dealId: deal.id, body: { category: 'Backsplash tile', allowance: 1500, dueDate: ymd(days(-1)), options: [{ name: 'A', price: 1000 }] } });

    // Bills against the PO: a partial one, then one that goes over.
    reply = (p) => /Compare this supplier bill/.test(p) ? { notOnBill: ['Wall cabinets'], notOnPO: [] } : {};
    const bill1 = await costs.addCost({ tenantId: t, dealId: deal.id, amount: 4000, vendorName: 'Gulf Coast Supply', category: 'materials', userId: u });
    assert.match(bill1.match_note, /\$4,000\.00 of \$6,000\.00 billed/);
    const bill2 = await costs.addCost({ tenantId: t, dealId: deal.id, amount: 2600, vendorName: 'gulf coast supply inc', category: 'materials', userId: u });
    assert.match(bill2.match_note, /\$600\.00 over the PO/);
    assert.ok((await crm.listInbox(t)).some(i => i.kind === 'po_match'), 'over the PO lands in Needs you');
    assert.equal(require(R + '/lib/crmMatching').sameVendor('Home Depot #6542', 'The Home Depot'), true);
    assert.equal(require(R + '/lib/crmMatching').sameVendor('Lowes', 'Ferguson'), false);

    // 5. Outlook: cost forecast and schedule risk.
    const cf = await fc.costForecast(t, deal.id);
    assert.equal(cf.ready, true);
    assert.equal(cf.spent, 6600); assert.equal(cf.committed, 0, 'the PO is fully billed');
    assert.ok(cf.progress > 0.2 && cf.progress < 0.5, 'progress weighted by working days');
    assert.equal(cf.confidence, 'rough');
    const risk = await fc.scheduleRisk(t, deal.id);
    const txt = risk.reasons.map(r => r.text).join(' | ');
    assert.match(txt, /“Rough plumbing” was due to finish 3 days ago/);
    assert.match(txt, /can’t make the dates/);
    assert.match(txt, /insurance on file expires before “Cabinets”/);
    assert.match(txt, /choose “Backsplash tile” 1 day ago/);
    assert.equal(risk.level, 'high'); assert.ok(risk.likelyFinish > risk.plannedFinish);
    // The forecast arithmetic on its own.
    const f = fc.forecastCost({ contract: 100000, budget: 75000, spent: 40000, committed: 5000, progress: 0.4, history: [1.1, 1.05, 1.2] });
    assert.ok(f.eac > 82000 && f.eac <= 100000, 'spending ahead of progress raises the forecast'); assert.match(f.method, /spending pace/);
    const flagged = await fc.scanJobs();
    assert.ok(flagged.flagged >= 1); assert.ok((await crm.listInbox(t)).some(i => i.kind === 'schedule_risk'));

    // 6. Change-order catcher: a request in an email gets caught, priced and drafted.
    await query(`INSERT INTO crm_emails (tenant_id, message_key, mailbox_email, direction, from_email, to_emails, subject, body_text, sent_at, contact_id, deal_id) VALUES
      ($1, '<c1@x>', 'sam@plus.test', 'in', 'maria@plus.test', '{sam@plus.test}', 'Island', 'Could you add two outlets on the island? Thanks!', now(), $2, $3),
      ($1, '<c2@x>', 'sam@plus.test', 'in', 'maria@plus.test', '{sam@plus.test}', 'Thanks', 'Thank you, see you Tuesday.', now(), $2, $3)`, [t, deal.contact_id, deal.id]);
    const cat = (await query(`SELECT id FROM crm_catalog_items WHERE tenant_id = $1 AND name LIKE 'Duplex%'`, [t])).rows[0].id;
    let judged = 0;
    reply = (p) => { if (/decide whether it asks for/.test(p)) { judged++; return /two outlets/.test(p) ? { isChange: true, title: 'Two island outlets', description: 'Add two outlets on the island.', quote: 'Could you add two outlets on the island?', items: [{ id: cat, quantity: 2 }], daysAdded: 0 } : { isChange: false }; } return {}; };
    const sc = await catcher.scanForChanges();
    assert.equal(sc.caught, 1); assert.equal(judged, 1, '“thanks, see you Tuesday” never reaches the AI');
    const sug = (await catcher.listSuggestions(t, deal.id))[0];
    assert.equal(Number(sug.cost), 280); assert.equal(Number(sug.amount), 280 * 1.2, 'catalog cost plus the default markup');
    assert.equal((await catcher.scanForChanges()).read, 0, 'each email is read once');
    const dr = await catcher.draftFromSuggestion({ tenantId: t, id: sug.id, userId: u });
    assert.equal(dr.changeOrder.status, 'draft'); assert.match(dr.changeOrder.description, /You asked/);
    assert.equal((await catcher.listSuggestions(t, deal.id)).length, 0);
    assert.equal(catcher.clearlyAsks('Can we move the sink to the island?'), true);
    assert.equal(catcher.worthALook('Looks great, thanks'), false);

    // 7. Products and selection ideas.
    for (const [n, p] of [['Zellige white', 900], ['Subway gloss', 400], ['Handmade terracotta', 1600], ['Marble mosaic', 2400], ['Ceramic matte', 600]]) await products.saveProduct({ tenantId: t, body: { name: n, category: 'Backsplash tile', price: p, unit: 'ls', photoBase64: n === 'Zellige white' ? JPEG : null } });
    const byPrice = products.pickByPrice((await products.listProducts(t)), 1500).map(p => p.price);
    assert.deepEqual(byPrice, [900, 1600, 2400], 'under, near and a step up');
    reply = (p) => /Pick three products/.test(p) ? { ids: [], why: '' } : {};
    const ideas = await products.suggestOptions({ tenantId: t, dealId: deal.id, category: 'Kitchen backsplash tile', allowance: 1500 });
    assert.equal(ideas.options.length, 3); assert.ok(ideas.options[0].product_id);
    const sel = await jobs.saveSelection({ tenantId: t, dealId: deal.id, body: { category: 'Kitchen backsplash', allowance: 1500, options: ideas.options } });
    assert.ok(sel.options[0].product_id, 'the option keeps its product');
    const ptok = await portal.portalToken(t, deal.id);
    const zel = (await products.listProducts(t)).find(p => p.name === 'Zellige white');
    assert.ok(await products.portalProductPhoto(ptok, zel.id), 'photo visible to the homeowner when offered on their job');
    const other = (await products.listProducts(t)).find(p => p.name === 'Ceramic matte');
    assert.equal(await products.portalProductPhoto(ptok, other.id), null, 'other products stay private');

    // 8. Portal assistant: only the homeowner's facts; requests go to the team.
    const facts = (await portalAi.factsFor(ptok)).facts;
    const fj = JSON.stringify(facts);
    assert.ok(!/cost_total|unit_cost|"cost"|margin|Gulf Coast/.test(fj), 'no costs or vendors in what it can see');
    assert.ok(facts.schedule.some(s => s.title === 'Cabinets'));
    reply = (p) => /answer a homeowner's questions/.test(p) ? (/when do the cabinets/i.test(p) ? { answer: 'Cabinets are scheduled to start in 3 days.', forward: false } : { answer: 'I’ve passed that to the team.', forward: true }) : {};
    const a1 = await portalAi.ask({ token: ptok, question: 'When do the cabinets go in?' });
    assert.equal(a1.forwarded, false); assert.match(a1.answer, /3 days/);
    const before = (await crm.listInbox(t)).length;
    const a2 = await portalAi.ask({ token: ptok, question: 'Can we switch to a darker grout?' });
    assert.equal(a2.forwarded, true); assert.ok((await crm.listInbox(t)).length > before, 'the team sees the forwarded question');
    assert.equal((await portalAi.listQuestions(t, deal.id)).length, 2);
    await assert.rejects(portalAi.ask({ token: 'f'.repeat(48), question: 'hi there' }), /not valid/);

    // 9. Punch list from a walkthrough; shared items show in the portal.
    reply = (p) => /punch list/.test(p) ? { items: [{ location: 'Kitchen', issue: 'Touch up paint by the window', trade: 'Paint', frame: 1 }, { location: 'Island', issue: 'Missing outlet cover', trade: 'Electrical', frame: null }] } : {};
    const pw = await photoAi.punchFromWalkthrough({ tenantId: t, dealId: deal.id, frames: ['data:image/jpeg;base64,' + JPEG, JPEG], notes: 'Paint by the window, outlet cover on the island.', userId: u });
    assert.equal(pw.items.length, 2); assert.ok(pw.items[0].file_id, 'the frame it points at is kept');
    await photoAi.updatePunch({ tenantId: t, id: pw.items[1].id, body: { shared: false } });
    await photoAi.updatePunch({ tenantId: t, id: pw.items[0].id, body: { status: 'done' } });
    const pview = await portal.portalView(ptok);
    assert.equal(pview.punch.length, 1); assert.equal(pview.punch[0].status, 'done');

    // 10. Photo checks: tagged, and a serious one lands in Needs you.
    const ph = await portal.addFile({ tenantId: t, dealId: deal.id, filename: 'framing.jpg', dataBase64: JPEG, userId: u });
    reply = (p) => /job-site photo/.test(p) ? { phase: 'rough plumbing', schedulePhase: 'Rough plumbing', seen: 'Open stud wall with new PEX lines.', checks: ['No nail plates where the pipes pass through the studs.'], severity: 'check soon' } : {};
    const ps = await photoAi.scanPhotos();
    assert.ok(ps.checked >= 1);
    assert.equal((await query('SELECT ai_tags FROM crm_files WHERE id = $1', [ph.id])).rows[0].ai_tags.phase, 'rough plumbing');
    assert.ok((await crm.listInbox(t)).some(i => i.kind === 'photo_check' && /not an inspection/.test(i.detail)));
    const prog = await photoAi.photoProgress(t, deal.id);
    assert.ok(prog.some(g => g.phase === 'rough plumbing' && g.checks.length));

    // 11. Coaching: private, fair, from the records.
    for (let i = 0; i < 4; i++) {
      const d = await crm.createDeal({ tenantId: t, name: 'Lead ' + i, email: `l${i}@plus.test`, title: 'Bath ' + i, ownerUserId: u2, userId: u });
      await query(`UPDATE crm_deals SET created_at = now() - interval '5 days', first_response_at = now() - interval '5 days' + interval '20 minutes' WHERE id = $1`, [d.id]);
    }
    reply = () => ({});
    const ch = await coaching.coachingFor({ tenantId: t, userId: u2, viewer: { userId: u, manager: true }, refresh: true });
    assert.equal(ch.stats.answered, 4); assert.equal(Math.round(ch.stats.firstReplyMins), 20);
    assert.ok(ch.advice.keep.some(x => /hear back fast/.test(x)));
    await assert.rejects(coaching.coachingFor({ tenantId: t, userId: u, viewer: { userId: u2, manager: false } }), /Only the owner/);
    assert.ok(await coaching.coachingFor({ tenantId: t, userId: u2, viewer: { userId: u2, manager: false } }), 'everyone sees their own');

    // 12. Win/loss: waits for enough closed deals, then finds the pattern.
    assert.equal((await coaching.winLoss(t)).enough, false);
    for (let i = 0; i < 12; i++) {
      const won = i < 6;
      const d = await crm.createDeal({ tenantId: t, name: 'Closed ' + i, email: `c${i}@plus.test`, title: 'Job ' + i, source: i % 2 ? 'referral' : 'website', value: 40000, userId: u });
      await query(`UPDATE crm_deals SET stage = $2, stage_entered_at = now(), lost_reason = $3, created_at = now() - interval '30 days', first_response_at = now() - interval '30 days' + $4::interval, site_visit_at = CASE WHEN $5 THEN now() - interval '20 days' END WHERE id = $1`,
        [d.id, won ? 'signed' : 'lost', won ? null : 'Price', won ? '30 minutes' : '3 days', won]);
    }
    const wl = await coaching.winLoss(t);
    assert.equal(wl.enough, true);
    const reply1 = wl.groups.find(g => g.label === 'First reply');
    assert.equal(reply1.rows[0].group, 'within an hour'); assert.equal(reply1.rows[0].winRate, 100);
    assert.equal(wl.lostReasons[0].reason, 'price');

    // 13. Design visualizer: off without its key; with it, the picture is saved team-only.
    await assert.rejects(vis.visualize({ tenantId: t, dealId: deal.id, fileId: ph.id, design: 'white shaker cabinets' }), /isn’t switched on/);
    process.env.OPENAI_API_KEY = 'test-only';
    let sentForm = null;
    vis.setHttp(async (url, opts) => { sentForm = opts.body; return { ok: true, json: async () => ({ data: [{ b64_json: JPEG }] }) }; });
    const vz = await vis.visualize({ tenantId: t, dealId: deal.id, fileId: ph.id, design: 'white shaker cabinets, quartz island', userId: u });
    assert.equal(vz.file.shared, false); assert.match(vz.file.caption, /AI design idea/); assert.equal(vz.used, 1);
    assert.match(sentForm.get('prompt'), /Keep the same room/);
    delete process.env.OPENAI_API_KEY;

    // 14. The assistant has the new tools.
    for (const k of ['job_outlook', 'check_estimate', 'win_loss', 'coaching', 'add_punch_item']) assert.ok(A.TOOLS[k], k);
    console.log('AI PLUS SCENARIO PASSED');
  } catch (e) {
    console.error('AI PLUS SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM tenants WHERE id = $1', [t]).catch(() => {});
    await pool.end();
  }
})();
