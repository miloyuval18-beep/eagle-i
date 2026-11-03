// SOPs: the company's own SOP is there from the start (the house style); Eagle I writes a new
// one for any kind of work in that style (tailored to a project or a vendor), changes it when
// told, prints it like the paper SOPs, and the company's own can't be deleted.
const { R } = require('./_local');
const assert = require('assert/strict');
process.env.ANTHROPIC_API_KEY = 'test';
let prompts = [];
const ai = require(R + '/lib/anthropic');
ai.generateJSON = async (p) => { prompts.push(p);
  if (/<change>/.test(p)) return { title: 'Shower Waterproofing Checklist', subtitle: 'SOP', intro: 'Do every step.', fields: ['Project'], sections: [{ heading: 'Prep', steps: [{ title: 'Photograph the pan.', text: 'Before tile.', done: 'photos in the file.' }, { title: 'Flood test.', text: '24 hours.', done: 'no drop in level.' }] }], boxes: [], signoff: 'Reviewed by' };
  return { title: 'Shower Waterproofing Checklist', subtitle: 'SOP', intro: 'Do every step, in order.', fields: ['Project', 'Installer'], sections: [{ heading: 'Prep', steps: [{ title: 'Flood test.', text: 'Fill the pan 24 hours.', done: 'no drop in level.' }] }, { heading: 'Sign off', steps: [{ title: 'PM checks.', text: 'In person.', done: 'signed.' }] }],
    boxes: [{ heading: 'Not sure? Stop and ask', tone: 'warn', text: 'Ask the PM.' }, { heading: 'Bad', tone: 'weird', items: ['x'] }], signoff: 'All steps complete. Reviewed by' }; };
const { query, pool } = require(R + '/db');
const S = require(R + '/lib/crmSops');
const tag = Date.now().toString(36);

(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Levi Test ${tag}', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    const u = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role, app) VALUES ($1, $2, 'x', 'Pat PM', 'project_manager', 'crm') RETURNING *`, [t, `pat${tag}@sop.test`])).rows[0];
    const l = await S.list(t);
    assert.deepEqual(l.categories.map(c => c.key), ['kitchen', 'bath', 'whole_house', 'additions', 'new_construction', 'structural', 'all']);
    const ref = l.sops.find(x => x.reference);
    assert.equal(ref.title, 'Define the Scope of Work Checklist', 'the company’s own SOP');
    assert.equal((await S.get(t, ref.id)).content.sections.reduce((n, s) => n + s.steps.length, 0), 17);
    await S.list(t); assert.equal((await query(`SELECT COUNT(*)::int AS n FROM crm_sops WHERE tenant_id = $1`, [t])).rows[0].n, 1, 'only once');

    const deal = await require(R + '/lib/crm').createDeal({ tenantId: t, name: 'Kim Lee', title: 'Lee bath', stage: 'production', address: '1 Main St, Houston' });
    const v = (await query(`INSERT INTO crm_vendors (tenant_id, name, trade, email) VALUES ($1, 'Gulf Tile', 'Tile', 'tile@gulf.test') RETURNING id`, [t])).rows[0];
    const s = await S.generate({ tenantId: t, userId: u.id, category: 'bath', kind: 'trade', request: 'Shower waterproofing for the tile sub', dealId: deal.id, vendorId: v.id });
    assert.match(prompts[0], /Bathroom remodeling/); assert.match(prompts[0], /Define the Scope of Work Checklist/, 'written in the house style');
    assert.match(prompts[0], /Lee bath/); assert.match(prompts[0], /Gulf Tile/);
    assert.equal(s.title, 'Shower Waterproofing Checklist'); assert.equal(s.deal, 'Lee bath'); assert.equal(s.vendor, 'Gulf Tile'); assert.equal(s.vendorEmail, 'tile@gulf.test');
    assert.equal(s.content.boxes[1].tone, 'note', 'cleaned up');
    const page = S.html(s, { company_name: 'Levi Construction Group', phone: '713-922-5715' });
    assert.match(page, /A\. PREP/); assert.match(page, /☐ 1\./); assert.match(page, /Done when: no drop in level\./); assert.match(page, /LEVI CONSTRUCTION GROUP \| LEVI HOMES LLC \| SOP/); assert.match(page, /713-922-5715/);
    // In this category: it and the company's own.
    assert.deepEqual((await S.list(t, { category: 'bath' })).sops.map(x => x.title).sort(), ['Define the Scope of Work Checklist', 'Shower Waterproofing Checklist']);
    assert.equal((await S.list(t, { category: 'kitchen' })).sops.length, 1);
    // Who it goes to: written for Gulf Tile → Gulf Tile ticked; the homeowner and the PM there to add.
    await query(`UPDATE crm_contacts SET email = 'kim@home.test' WHERE id = (SELECT contact_id FROM crm_deals WHERE id = $1)`, [deal.id]);
    await query(`UPDATE crm_deals SET pm_user_id = $2 WHERE id = $1`, [deal.id, u.id]);
    const other = (await query(`INSERT INTO crm_vendors (tenant_id, name, trade, email) VALUES ($1, 'Bayou Plumbing', 'Plumbing', 'p@bayou.test') RETURNING id`, [t])).rows[0];
    await query(`INSERT INTO crm_job_items (tenant_id, deal_id, title, vendor_id, position) VALUES ($1, $2, 'Rough plumbing', $3, 1)`, [t, deal.id, other.id]);
    const tick = (rs) => rs.filter(r => r.suggested).map(r => r.email).sort();
    let rs = await S.recipients(t, await S.get(t, s.id));
    assert.deepEqual(tick(rs), ['tile@gulf.test'], 'a vendor’s scope: that vendor');
    assert.ok(rs.some(r => r.email === 'kim@home.test' && r.label === 'Homeowner') && rs.some(r => r.email === u.email && /Project manager/.test(r.label)), 'others there to add');
    await query(`UPDATE crm_sops SET kind = 'client' WHERE id = $1`, [s.id]);
    assert.deepEqual(tick(await S.recipients(t, await S.get(t, s.id))), ['kim@home.test', 'tile@gulf.test'].filter(e => e !== 'tile@gulf.test' || true).sort(), 'a homeowner guide: the homeowner (and the vendor it was written for)');
    await query(`UPDATE crm_sops SET kind = 'project', vendor_id = NULL WHERE id = $1`, [s.id]);
    assert.deepEqual(tick(await S.recipients(t, await S.get(t, s.id))), [u.email, 'p@bayou.test'].sort(), 'a full project SOP: the PM and the project’s subs');
    await query(`UPDATE crm_sops SET kind = 'trade', vendor_id = $2 WHERE id = $1`, [s.id, v.id]);
    // Changed.
    const s2 = await S.revise({ tenantId: t, id: s.id, instruction: 'Add a step to photograph the pan' });
    assert.match(prompts[1], /Add a step to photograph the pan/); assert.equal(s2.content.sections[0].steps[0].title, 'Photograph the pan.');
    await assert.rejects(S.remove(t, ref.id), /can’t be deleted/);
    await S.remove(t, s.id);
    assert.equal(await S.get(t, s.id), null);
    await assert.rejects(S.generate({ tenantId: t, category: 'nope', request: 'x' }), /kind of work/);
    console.log('SOPS SCENARIO PASSED');
  } catch (e) {
    console.error('SOPS SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM tenants WHERE id = $1', [t]).catch(() => {});
    await pool.end();
  }
})();
