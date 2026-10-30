// Price this project: the plans read into a scope of work, a material takeoff and a
// rough budget split into packages; the company's own vendors and ones found nearby
// suggested for each; the person's checks; one email per vendor with their part (lines
// to price, the plans, the due date, a reply address); prices back from the page and
// by email; the best price per package (one supplier, or line by line) on a new
// estimate; the person told; on signing, the winning sub on their phase and purchase
// orders drafted; the reminder the day prices are due; building with what's in after
// the due date; a stuck read given up on.
const { R, endOfDay } = require('./_local');
const assert = require('assert/strict');
process.env.ANTHROPIC_API_KEY = 'test-only'; process.env.RESEND_API_KEY = 'test-only';
process.env.RESEND_INBOUND_DOMAIN = 'in.eaglei.dev'; process.env.GOOGLE_PLACES_API_KEY = 'test-only';
const { query, pool } = require(R + '/db');
const sent = [];
const sender = async (m) => { sent.push(m); return { id: 'e' + sent.length }; };
const realEmail = require(R + '/lib/email');
require.cache[require.resolve(R + '/lib/email')].exports = { ...realEmail, sendEmail: sender };

// Stand-in AI: what it "reads" from the plans, and a vendor's emailed prices.
const READING = {
  project: 'Primary bath remodel with a new wall', summary: 'Gut and rebuild the primary bath, adding a framed wall for a linen closet.',
  sections: [{ trade: 'Framing', work: ['Frame the new 8 ft linen closet wall.'] }, { trade: 'Plumbing', work: ['Move the shower valve; new PEX supply lines.'] }],
  exclusions: ['Appliances'], assumptions: ['Existing subfloor is sound.'], questions: ['Which shower valve does the homeowner want?'],
  materials: [
    { name: '2x4 studs', spec: '8 ft SPF #2', quantity: 100, unit: 'ea', trade: 'Framing', how: 'Wall 8 ft at 16 in o.c. plus 10% waste', confidence: 'high', rough_unit_cost: 5 },
    { name: 'OSB sheathing', spec: '7/16 in 4x8', quantity: 40, unit: 'sheet', trade: 'Framing', how: 'Wall area / 32 sf', confidence: 'medium', rough_unit_cost: 30 },
    { name: 'PEX supply line', spec: '1/2 in', quantity: 200, unit: 'lf', trade: 'Plumbing', how: 'Runs on sheet P1', confidence: 'low', rough_unit_cost: 1 }
  ],
  packages: [
    { kind: 'sub', trade: 'Plumbing', label: 'Plumbing (rough-in and fixtures set)', search: 'plumbing contractor', scope: 'Move the shower valve and run new PEX.', materials: [2], rough_labor: 4000 },
    { kind: 'supplier', trade: 'Lumber', label: 'Framing lumber and sheathing', search: 'lumber yard', materials: [0, 1] },
    { kind: 'crew', trade: 'Framing', label: 'Framing labor (your crew)', materials: [], rough_labor: 6000 }
  ]
};
let emailReply = null;
const prompts = [];
const A0 = require(R + '/lib/anthropic');
require.cache[require.resolve(R + '/lib/anthropic')].exports = { ...A0, generateJSON: async (p, max, opts) => {
  prompts.push({ p, opts });
  if (/You are the estimator/.test(p)) return JSON.parse(JSON.stringify(READING));
  if (/A vendor replied by email/.test(p)) return emailReply;
  return {};
} };
// Stand-in Google: businesses near the job, and the emails on their websites.
const searches = [];
const places = require(R + '/lib/googlePlaces');
places.searchPlaces = async (q) => {
  searches.push(q);
  if (/plumbing/.test(q)) return [{ name: 'Bayou Plumbing', website: 'https://bayou.dev' }, { name: 'Ace Plumbing', website: 'https://ace.dev', rating: 4.8, reviews: 120, phone: '713-555-0101' }];
  if (/lumber/.test(q)) return [{ name: 'Gulf Lumber', website: 'https://gulf.dev', rating: 4.6 }, { name: 'Oak Yard', website: null, rating: 4.9 }];
  return [];
};
require(R + '/lib/vendorContactFinder').findContactEmail = async (url) => ({ email: { 'https://ace.dev': 'bids@ace.dev', 'https://gulf.dev': 'sales@gulf.dev' }[url] || null });

const P = require(R + '/lib/crmPricing');
const bids = require(R + '/lib/crmBids');
const crm = require(R + '/lib/crm');
const tag = Date.now().toString(36);

(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Pricing Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    const owner = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role, app) VALUES ($1, $2, 'x', 'Olive Owner', 'owner', 'crm') RETURNING *`, [t, `olive.${tag}@pz.dev`])).rows[0];
    const deal = await crm.createDeal({ tenantId: t, name: 'Rita Ruiz', title: 'Ruiz primary bath', address: '12 Oak St, Houston, TX 77008', stage: 'estimate', userId: owner.id });
    const file = (await query(`INSERT INTO crm_files (tenant_id, deal_id, filename, content_type, size, data) VALUES ($1, $2, 'A1 floor plan.pdf', 'application/pdf', 9, '\\x255044462d312e340a'::bytea) RETURNING id`, [t, deal.id])).rows[0];
    await query(`INSERT INTO crm_files (tenant_id, deal_id, filename, content_type, size, data, caption) VALUES ($1, $2, 'receipt.jpg', 'image/jpeg', 3, '\\xffd8ff'::bytea, 'Receipt')`, [t, deal.id]);
    const bayou = (await query(`INSERT INTO crm_vendors (tenant_id, name, trade, email) VALUES ($1, 'Bayou Plumbing', 'Plumbing', 'office@bayou.dev') RETURNING id`, [t])).rows[0];

    // 1. Read: only the plans (not the receipt), all of them at once, with the job's area.
    assert.deepEqual((await P.planFiles(t, deal.id)).map(f => f.filename), ['A1 floor plan.pdf']);
    let run = await P.start({ tenantId: t, dealId: deal.id, notes: 'Mid-range finishes', userId: owner.id, wait: true });
    assert.equal(run.status, 'review', run.error || '');
    const read = prompts.find(x => /You are the estimator/.test(x.p));
    assert.equal(read.opts.images.length, 1); assert.equal(read.opts.images[0].mediaType, 'application/pdf'); assert.equal(read.opts.effort, 'medium', 'high thinking once used the whole answer allowance');
    assert.match(read.p, /Houston, TX 77008/); assert.ok(!/12 Oak St/.test(read.p), 'never the street'); assert.match(read.p, /Mid-range finishes/);
    assert.equal(run.scope.sections.length, 2); assert.equal(run.materials.length, 3);
    // Rough budget: plumbing 4000 + 200 PEX, lumber 500 + 1200, crew 6000.
    assert.equal(run.roughTotal, 11900);
    assert.ok(run.dueDate > new Date().toISOString().slice(0, 10));

    // 2. Vendors: theirs first; found nearby only when short, never one they already have; picked only with an email.
    const plumb = run.packages.find(p => p.trade === 'Plumbing'), lumber = run.packages.find(p => p.trade === 'Lumber'), crew = run.packages.find(p => p.kind === 'crew');
    assert.deepEqual(plumb.vendors.map(v => [v.name, v.source, v.picked]), [['Bayou Plumbing', 'yours', true], ['Ace Plumbing', 'found', true]]);
    assert.deepEqual(lumber.vendors.map(v => [v.name, v.email, v.picked]), [['Oak Yard', null, false], ['Gulf Lumber', 'sales@gulf.dev', true]]);
    assert.equal(crew.vendors.length, 0);
    assert.ok(searches.every(q => /near Houston, TX 77008/.test(q)));
    assert.ok((await query(`SELECT 1 FROM crm_inbox WHERE tenant_id = $1 AND kind = 'pricing'`, [t])).rows.length, 'ready to check, in Needs you');

    // 3. The person's checks: 42 sheets, someone added by hand.
    run = await P.saveRun({ tenantId: t, id: run.id, materials: [{ i: 1, name: 'OSB sheathing', quantity: '42', unit: 'sheet', spec: '7/16 in 4x8' }],
      packages: [{ key: lumber.key, vendors: [{ picked: false }, { picked: true, email: 'sales@gulf.dev' }], add: [{ name: 'Hill Lumber', email: 'quotes@hill.dev' }] }] });
    assert.equal(run.materials[1].quantity, 42);
    assert.equal(run.roughTotal, 11960);
    await assert.rejects(P.compile({ tenantId: t, id: run.id }), /isn’t waiting/);

    // 4. Send: one email per vendor with their part, the plans and a reply address; found vendors join the company's list.
    const out = await P.send({ tenantId: t, id: run.id, userId: owner.id, baseUrl: 'https://app.test', send: sender });
    assert.equal(out.sent.length, 4);
    await assert.rejects(P.send({ tenantId: t, id: run.id, send: sender }), /already gone out/);
    assert.equal((await query(`SELECT resolved_at IS NOT NULL AS r FROM crm_inbox WHERE tenant_id = $1 AND dedupe_key = $2`, [t, `pricing:read:${run.id}`])).rows[0].r, true, 'the “ready to check” alert clears once sent');
    const toGulf = sent.find(m => m.to === 'sales@gulf.dev');
    assert.match(toGulf.html, /OSB sheathing/); assert.match(toGulf.html, />42 sheet</); assert.match(toGulf.html, /A1 floor plan\.pdf/); assert.ok(!/PEX/.test(toGulf.html), 'only their lines');
    assert.match(toGulf.replyTo, /^reply\+bid-[0-9a-f-]{36}@in\.eaglei\.dev$/); assert.match(toGulf.html, /just reply to this email/);
    assert.ok(!/12 Oak St/.test(toGulf.html), 'no street before it’s theirs');
    assert.match(sent.find(m => m.to === 'office@bayou.dev').html, /Move the shower valve/);
    // A sub gives one total: the materials they bring are listed, not priced line by line (so labor is never left out).
    const toBayou = sent.find(m => m.to === 'office@bayou.dev');
    assert.match(toBayou.text, /Your total should include these materials/); assert.match(toBayou.text, /PEX supply line \(1\/2 in\): 200 lf/);
    assert.ok(!/Please price these/.test(toBayou.text));
    // Whole words: a framing company is no glass shop.
    assert.equal(P.fits({ name: 'Preview Framing', trade: 'Framing' }, { trade: 'Glass', search: 'frameless shower door' }), false);
    const found = (await query(`SELECT name, found_via, notes FROM crm_vendors WHERE tenant_id = $1 AND name = 'Gulf Lumber'`, [t])).rows[0];
    assert.equal(found.found_via, 'google'); assert.match(found.notes, /4\.6★/);

    // 5. Prices back: Gulf on the page (per line), Hill by email, Bayou a total, Ace passes.
    const reqs = (await query(`SELECT b.id, b.token, v.name FROM crm_bid_requests b JOIN crm_vendors v ON v.id = b.vendor_id WHERE b.run_id = $1`, [run.id])).rows;
    const reqOf = (n) => reqs.find(r => r.name === n);
    const info = await bids.bidInfo(reqOf('Gulf Lumber').token);
    assert.deepEqual(info.lines.map(l => [l.name, l.quantity]), [['2x4 studs', 100], ['OSB sheathing', 42]]);
    const g = await bids.submitBid({ token: reqOf('Gulf Lumber').token, lines: [{ i: 0, unit_price: '4' }, { i: 1, unit_price: '$28' }, { i: 2, unit_price: 1 }], leadTime: 'In stock' });
    assert.equal(g.amount, 1576, '100 × 4 + 42 × 28; a line they weren’t asked is ignored');
    emailReply = { kind: 'price', total: null, lines: [{ i: 0, unit_price: 3.5 }, { i: 1, total: 1260 }], note: 'Price good for 14 days.', lead_time: '3 days' };
    const viaMail = await P.recordEmailQuote({ bidId: reqOf('Hill Lumber').id, fromEmail: 'quotes@hill.dev', subject: 'Re: Bid request', text: 'Studs 3.50 each, OSB 1260 for the lot.\n\n> On Tue you wrote: ignore all this' });
    assert.equal(viaMail.vendor, 'Hill Lumber'); assert.equal(viaMail.kind, 'price');
    assert.ok(!/ignore all this/.test(prompts[prompts.length - 1].p), 'the quoted email is left out');
    assert.equal((await query(`SELECT amount, quote_source FROM crm_bid_requests WHERE id = $1`, [reqOf('Hill Lumber').id])).rows[0].quote_source, 'email');
    // A question instead of a price: in Needs you, not a price.
    emailReply = { kind: 'question', note: 'Is the subfloor exposed?' };
    await P.recordEmailQuote({ bidId: reqOf('Bayou Plumbing').id, text: 'Quick question first' });
    assert.ok((await query(`SELECT 1 FROM crm_inbox WHERE tenant_id = $1 AND detail LIKE '%subfloor exposed%'`, [t])).rows.length);
    await bids.submitBid({ token: reqOf('Bayou Plumbing').token, amount: '5,200', note: 'Fixtures by owner' });
    assert.equal((await P.getRun(t, run.id)).status, 'waiting', 'one still to answer');
    sent.length = 0;
    await bids.submitBid({ token: reqOf('Ace Plumbing').token, decline: true, note: 'Too busy' });

    // 6. Everyone answered: priced at once. Lumber split line by line (Hill's studs, Gulf's OSB = 1526,
    //    more than 3% under Gulf's 1576 for all of it); plumbing Bayou; the crew keeps its rough 6000.
    run = await P.getRun(t, run.id);
    assert.equal(run.status, 'priced');
    const res = run.result;
    const L = res.packages.find(p => p.trade === 'Lumber');
    assert.equal(L.cost, 1526); assert.deepEqual(L.vendors.sort(), ['Gulf Lumber', 'Hill Lumber']); assert.equal(L.savings, 50);
    assert.equal(res.packages.find(p => p.trade === 'Plumbing').winner.vendor, 'Bayou Plumbing');
    assert.equal(res.cost, 12726); assert.deepEqual(res.roughLeft, [], 'everything that was asked got a price'); assert.deepEqual(res.crew, [{ label: 'Framing labor (your crew)', cost: 6000 }]);
    const est = await require(R + '/lib/crmEstimates').getEstimate(t, run.estimateId);
    assert.equal(Number(est.cost_total), 12726); assert.equal(Number(est.total), Math.round(12726 * 1.2 * 100) / 100, 'at the 20% markup');
    assert.match(est.intro, /Gut and rebuild/); assert.match(est.intro, /Not included: Appliances/);
    const osb = est.lines.find(l => /OSB/.test(l.description));
    assert.equal(Number(osb.unit_cost), 28); assert.equal(osb.unit, 'ea'); assert.match(osb.description, /42 sheet/);
    assert.ok(!est.lines.some(l => /Gulf|Hill|Bayou/.test(l.description)), 'no vendor names for the homeowner');
    // In the owner's end-of-day email, not one of its own.
    assert.ok(!sent.some(m => m.to === owner.email), 'not one by one');
    await endOfDay(t);
    const told = sent.find(m => m.to === owner.email);
    assert.match(told.text, /PRICING\n- Prices are in: Ruiz primary bath/); assert.match(told.html, /#price\//); assert.match(told.html, /Cost \$12,726/);
    await assert.rejects(P.compile({ tenantId: t, id: run.id }), /isn’t waiting/, 'built once');
    // A late change of price is kept on the bid but doesn't rebuild the estimate.
    await bids.submitBid({ token: reqOf('Gulf Lumber').token, lines: [{ i: 0, unit_price: 1 }, { i: 1, unit_price: 1 }] });
    assert.equal((await P.getRun(t, run.id)).result.cost, 12726);

    // 7. Signed: Bayou on the plumbing phase, a purchase order per lumber supplier (drafts).
    await crm.changeStage({ tenantId: t, dealId: deal.id, stage: 'signed', userId: owner.id });
    const phase = (await query(`SELECT i.title, v.name FROM crm_job_items i JOIN crm_vendors v ON v.id = i.vendor_id WHERE i.deal_id = $1`, [deal.id])).rows;
    assert.deepEqual(phase, [{ title: 'Rough plumbing & electrical', name: 'Bayou Plumbing' }]);
    const pos = (await query(`SELECT p.title, p.status, p.total, v.name FROM crm_purchase_orders p JOIN crm_vendors v ON v.id = p.vendor_id WHERE p.deal_id = $1 ORDER BY v.name`, [deal.id])).rows;
    assert.deepEqual(pos.map(p => [p.name, p.status, Number(p.total)]), [['Gulf Lumber', 'draft', 1176], ['Hill Lumber', 'draft', 350]]);
    assert.equal((await query(`SELECT status FROM crm_bid_requests WHERE id = $1`, [reqOf('Bayou Plumbing').id])).rows[0].status, 'awarded');
    assert.ok((await P.getRun(t, run.id)).handedOff);
    assert.equal(await P.onSigned({ tenantId: t, dealId: deal.id }), null, 'once');

    // 8. Another round: a reminder the day prices are due (once), then built with what's in after it.
    const deal2 = await crm.createDeal({ tenantId: t, name: 'Sam Lee', title: 'Lee deck', address: '3 Elm St, Houston, TX 77009', stage: 'estimate', userId: owner.id });
    await query(`INSERT INTO crm_files (tenant_id, deal_id, filename, content_type, size, data) VALUES ($1, $2, 'deck.pdf', 'application/pdf', 9, '\\x255044462d312e340a'::bytea)`, [t, deal2.id]);
    let r2 = await P.start({ tenantId: t, dealId: deal2.id, userId: owner.id, wait: true });
    await P.send({ tenantId: t, id: r2.id, baseUrl: 'https://app.test', send: sender });
    const due = r2.dueDate, dueMorning = new Date(due + 'T15:00:00Z'); // 9 or 10am Central
    sent.length = 0;
    let z = await P.processPricing({ now: dueMorning, send: sender, appUrl: 'https://app.test' });
    assert.equal(z.reminded, 4); assert.match(sent[0].subject, /Reminder: prices for Lee deck are due today/);
    z = await P.processPricing({ now: new Date(dueMorning.getTime() + 3600000), send: sender, appUrl: 'https://app.test' });
    assert.equal(z.reminded, 0, 'once');
    z = await P.processPricing({ now: new Date(new Date(due + 'T12:00:00Z').getTime() + 2 * 86400000), send: sender, appUrl: 'https://app.test' });
    assert.equal(z.built, 1);
    r2 = await P.getRun(t, r2.id);
    assert.equal(r2.status, 'priced'); assert.equal(r2.result.cost, 11900, 'nothing came back: the rough budget');
    assert.equal(r2.result.roughLeft.length, 2, 'the plumbing and lumber; the crew is listed apart');

    // 9. A read that never finished is given up on, so it can be tried again.
    const stuck = (await query(`INSERT INTO crm_pricing_runs (tenant_id, deal_id, created_at) VALUES ($1, $2, now() - interval '1 hour') RETURNING id`, [t, deal2.id])).rows[0];
    assert.equal((await P.processPricing({ send: sender })).stuck, 1);
    assert.match((await P.getRun(t, stuck.id)).error, /took too long/);

    // Pure: choosing between one supplier and splitting.
    const mats = [{ i: 0, quantity: 10, rough: 1 }, { i: 1, quantity: 10, rough: 1 }];
    const pk = { kind: 'supplier', items: [0, 1], rough: 20 };
    const near = P.bestFor(pk, mats, [{ id: 'a', vendor: 'A', status: 'submitted', amount: 200, linePrices: [{ i: 0, unit_price: 10 }, { i: 1, unit_price: 10 }] }, { id: 'b', vendor: 'B', status: 'submitted', amount: 210, linePrices: [{ i: 0, unit_price: 9.8 }, { i: 1, unit_price: 11.2 }] }]);
    assert.equal(near.winner.vendor, 'A', 'within 3%: one supplier');
    const lump = P.bestFor(pk, mats, [{ id: 'c', vendor: 'C', status: 'submitted', amount: 150, linePrices: null }]);
    assert.equal(lump.winner.vendor, 'C'); assert.equal(lump.cost, 150);
    console.log('PRICING SCENARIO PASSED');
  } catch (e) {
    console.error('PRICING SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM tenants WHERE id = $1', [t]).catch(() => {});
    await pool.end();
  }
})();
