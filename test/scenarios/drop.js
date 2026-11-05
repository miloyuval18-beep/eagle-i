// The drop box on Home (lib/crmDrop.js): a receipt lands in its project's files and costs,
// a permit on the project's permits (and updates it the second time), insurance on the
// sub, a business card adds the vendor; Undo takes each back; a file with no clear project
// waits for the person to pick one; "Wrong? Change it" moves it. Only the person's own drops.
const { R } = require('./_local');
const assert = require('assert/strict');
const http = require('http');
delete process.env.RESEND_API_KEY;
const { query, pool } = require(R + '/db');
const L = (m) => require(R + '/lib/' + m);
const crm = L('crm'), team = L('crmTeam'), dz = L('crmDrop');

// A stand-in for the AI: answers in order.
const answers = [];
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
    const next = answers.shift() || { kind: 'other', project: null, sure: false, summary: 'Something' };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(next) }], stop_reason: 'end_turn' }));
  });
});

(async () => {
  await new Promise(r => server.listen(0, r));
  process.env.ANTHROPIC_API_KEY = 'test'; process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Drop Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, email, address) VALUES ($1, 'o@drop.test', '1 Main St, Houston TX 77002')`, [t]);
    const ownerId = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role, app) VALUES ($1, 'o@drop.test', 'x', 'Owner', 'owner', 'crm') RETURNING id`, [t])).rows[0].id;
    const otherId = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role, app) VALUES ($1, 'm@drop.test', 'x', 'Member', 'member', 'crm') RETURNING id`, [t])).rows[0].id;
    const me = await team.getUser(ownerId), other = await team.getUser(otherId);
    const deal = await crm.createDeal({ tenantId: t, name: 'Jordan Job', address: '404 Tryout Ln, Houston TX 77009', title: 'Job remodel', userId: ownerId });
    await crm.changeStage({ tenantId: t, dealId: deal.id, stage: 'production', userId: ownerId });
    const sub = (await query(`INSERT INTO crm_vendors (tenant_id, name) VALUES ($1, 'Test Plumbing Co') RETURNING id`, [t])).rows[0].id;
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4 '), Buffer.alloc(200, 2)]);
    const n = async () => (await query(`SELECT (SELECT COUNT(*) FROM crm_costs WHERE tenant_id = $1)::int costs, (SELECT COUNT(*) FROM crm_files WHERE tenant_id = $1)::int files,
      (SELECT COUNT(*) FROM crm_permits WHERE tenant_id = $1)::int permits, (SELECT COUNT(*) FROM crm_vendors WHERE tenant_id = $1)::int vendors`, [t])).rows[0];

    // 1. A receipt for the job: in its Receipts, and a cost.
    answers.push({ kind: 'receipt', project: 0, sure: true, summary: 'Home Depot receipt, $490.56', receipt: { vendor: 'The Home Depot', date: '2026-11-03', total: 490.56, category: 'materials', description: 'Studs and drywall' } });
    const r1 = await dz.drop({ tenantId: t, user: me, filename: 'receipt.jpg', buf: jpg });
    assert.equal(r1.status, 'done'); assert.equal(r1.dealId, deal.id); assert.match(r1.text, /\$490\.56 cost/);
    const cost = (await query(`SELECT amount, vendor_name, source FROM crm_costs WHERE tenant_id = $1`, [t])).rows[0];
    assert.equal(Number(cost.amount), 490.56); assert.equal(cost.vendor_name, 'The Home Depot');
    assert.equal((await query(`SELECT folder FROM crm_files WHERE tenant_id = $1`, [t])).rows[0].folder, 'receipts');

    // 2. A permit: on the project's permits; the same permit again updates it, not a second one.
    answers.push({ kind: 'permit', project: 0, sure: true, summary: 'Building permit', permit: { title: 'Building permit', kind: 'building', permitNo: 'BP-1', status: 'submitted' } });
    const r2 = await dz.drop({ tenantId: t, user: me, filename: 'permit.pdf', buf: pdf });
    assert.match(r2.text, /added the Building permit \(#BP-1\)/);
    answers.push({ kind: 'permit', project: 0, sure: true, summary: 'Building permit, issued', permit: { title: 'Building permit', kind: 'building', permitNo: 'BP-1', status: 'approved', issued: '2026-10-28', expires: '2027-04-26', fee: 1245 } });
    const r2b = await dz.drop({ tenantId: t, user: me, filename: 'permit-issued.pdf', buf: pdf });
    assert.match(r2b.text, /updated the Building permit/);
    const p = (await query(`SELECT status, fee, to_char(expires_at, 'YYYY-MM-DD') exp FROM crm_permits WHERE tenant_id = $1`, [t])).rows;
    assert.equal(p.length, 1); assert.equal(p[0].status, 'approved'); assert.equal(Number(p[0].fee), 1245); assert.equal(p[0].exp, '2027-04-26');
    await dz.undo({ tenantId: t, user: me, id: r2b.id });
    assert.equal((await query(`SELECT status FROM crm_permits WHERE tenant_id = $1`, [t])).rows[0].status, 'submitted', 'undo puts the permit back as it was');

    // 3. Insurance: the sub's date, no project needed; undo restores it.
    answers.push({ kind: 'insurance', project: null, sure: false, summary: 'Insurance for Test Plumbing', insurance: { insured: 'Test Plumbing Co', expires: '2027-11-01' } });
    const r3 = await dz.drop({ tenantId: t, user: me, filename: 'coi.pdf', buf: pdf });
    assert.equal(r3.status, 'done'); assert.match(r3.text, /Test Plumbing Co’s insurance is good until Nov 1, 2027/);
    assert.equal((await query(`SELECT to_char(insurance_expires, 'YYYY-MM-DD') d FROM crm_vendors WHERE id = $1`, [sub])).rows[0].d, '2027-11-01');
    await dz.undo({ tenantId: t, user: me, id: r3.id });
    assert.equal((await query(`SELECT insurance_expires FROM crm_vendors WHERE id = $1`, [sub])).rows[0].insurance_expires, null);

    // 4. Not sure which project: it waits; picking one files it; changing what it is moves it.
    answers.push({ kind: 'receipt', project: 0, sure: false, summary: 'Lowe’s receipt', receipt: { vendor: 'Lowe’s', total: 204.59 } });
    const before = await n();
    const r4 = await dz.drop({ tenantId: t, user: me, filename: 'lowes.jpg', buf: jpg });
    assert.equal(r4.status, 'needs_project'); assert.equal(r4.guess.id, deal.id, 'its best guess is offered');
    assert.deepEqual(await n(), before, 'nothing filed yet');
    const r4b = await dz.move({ tenantId: t, user: me, id: r4.id, dealId: deal.id });
    assert.equal(r4b.status, 'done'); assert.match(r4b.text, /\$204\.59/);
    const r4c = await dz.move({ tenantId: t, user: me, id: r4.id, kind: 'other' });
    assert.equal(r4c.status, 'done'); assert.equal(r4c.kind, 'other');
    assert.equal((await n()).costs, before.costs, 'the cost went with the change');
    assert.equal((await n()).files, before.files + 1, 'still filed once');

    // 5. Only their own: someone else can't undo or move it, and doesn't see it.
    await assert.rejects(dz.undo({ tenantId: t, user: other, id: r1.id }), /Not found/);
    assert.equal((await dz.recent({ tenantId: t, user: other })).length, 0);
    assert.equal((await dz.recent({ tenantId: t, user: me })).length, 3, "undone ones leave the list");

    // 6. Undo the receipt: the file and the cost are gone.
    await dz.undo({ tenantId: t, user: me, id: r1.id });
    assert.equal((await query(`SELECT COUNT(*)::int n FROM crm_costs WHERE tenant_id = $1 AND vendor_name = 'The Home Depot'`, [t])).rows[0].n, 0);

    // 7. Without the AI, a file still lands: it asks which project.
    delete process.env.ANTHROPIC_API_KEY;
    const r7 = await dz.drop({ tenantId: t, user: me, filename: 'IMG_1.jpg', buf: jpg });
    assert.equal(r7.status, 'needs_project'); assert.equal(r7.kind, 'photo');
    await assert.rejects(dz.drop({ tenantId: t, user: me, filename: 'empty.pdf', buf: Buffer.alloc(0) }), /empty/);
    // Every kind of file a builder has: an iPhone HEIC photo is kept as it is; a Word file is read for its words.
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(100, 3)]);
    const r8 = await dz.drop({ tenantId: t, user: me, filename: 'IMG_7.HEIC', buf: heic });
    assert.equal(r8.kind, 'photo');
    const r8b = await dz.move({ tenantId: t, user: me, id: r8.id, dealId: deal.id });
    assert.equal(r8b.status, 'done'); assert.match(r8b.text, /Photos/);
    assert.equal((await query(`SELECT content_type FROM crm_files WHERE tenant_id = $1 AND filename LIKE 'IMG_7%'`, [t])).rows[0].content_type, 'image/heic');
    const dwg = Buffer.concat([Buffer.from('AC1032'), Buffer.alloc(100, 4)]);
    assert.equal((await dz.drop({ tenantId: t, user: me, filename: 'A2 elevations.dwg', buf: dwg })).kind, 'plans', 'a CAD drawing is plans');
    console.log('DROP SCENARIO PASSED');
  } catch (e) {
    console.error('DROP SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    server.close();
    await query('DELETE FROM tenants WHERE id = $1', [t]).catch(() => {});
    await pool.end();
  }
})();
