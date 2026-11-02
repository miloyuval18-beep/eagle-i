// A vendor list in a PDF given to the AI: every company read, checked against the
// company's own vendors, shown on a card, and brought in on "Add": new ones added,
// ones already here only get their empty details filled in (nothing typed is replaced).
const { R } = require('./_local');
const assert = require('assert/strict');
process.env.ANTHROPIC_API_KEY = 'test';
let sentToAi = null;
const ai = require(R + '/lib/anthropic');
require.cache[require.resolve(R + '/lib/anthropic')].exports = { ...ai, generateJSON: async (prompt, max, opts) => { sentToAi = opts; return { vendors: [
  { name: 'Gulf Framing LLC', trade: 'Framing', email: 'gulf@frame.test', phone: '713-555-0101', contact: 'Rudy' },
  { name: 'Bayou Tile Supply', trade: 'Tile supplier', email: 'sales@bayoutile.test', phone: '713-555-0102', website: 'bayoutile.test', address: '12 Main St, Houston' },
  { name: 'Bayou Tile Supply', trade: 'Tile', phone: '713-555-0102' }, // the same one twice in the file
  { name: 'Sparks Electric', trade: 'Electrical', email: 'not an email', phone: '713-555-0103' },
  { name: '', trade: 'Nobody' }
] }; } };
const { query, pool } = require(R + '/db');
const A = require(R + '/lib/crmAssistant');
const tag = Date.now().toString(36);

(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('List Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    const owner = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role, app) VALUES ($1, $2, 'x', 'Lee Owner', 'owner', 'crm') RETURNING *`, [t, `o${tag}@list.test`])).rows[0];
    const ctx = { tenantId: t, userId: owner.id, role: 'owner', manager: true, perms: require(R + '/lib/crmTeam').permsOf(owner), name: owner.name };
    // Already a vendor: Gulf Framing, with an email someone typed and no phone.
    const gulf = (await query(`INSERT INTO crm_vendors (tenant_id, name, trade, email) VALUES ($1, 'Gulf Framing', 'Framing', 'office@gulf.test') RETURNING id`, [t])).rows[0].id;
    const file = (await query(`INSERT INTO crm_ai_files (tenant_id, user_id, filename, content_type, size, data) VALUES ($1, $2, 'Vendors.pdf', 'application/pdf', 9, $3) RETURNING id`, [t, owner.id, Buffer.from('%PDF-1.4 x')])).rows[0].id;

    const tool = A.TOOLS.import_vendor_list;
    assert.equal(tool.confirm, true, 'nothing changes until they tap Add');
    const prep = await tool.prepare(ctx, { chat_file_id: file });
    assert.equal(sentToAi.images[0].mediaType, 'application/pdf', 'the PDF itself is read');
    assert.equal(prep.summary.button, 'Add 2 vendors');
    assert.match(prep.summary.lines.join('\n'), /Read 3 companies from Vendors\.pdf/);
    assert.match(prep.summary.lines.join('\n'), /Bayou Tile Supply \(Tile supplier\) · 713-555-0102 · sales@bayoutile\.test/);
    assert.match(prep.summary.lines.join('\n'), /1 already here get their empty details filled in: Gulf Framing/);
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM crm_vendors WHERE tenant_id = $1`, [t])).rows[0].n, 1, 'nothing added yet');

    const r = await tool.execute(ctx, JSON.parse(JSON.stringify(prep.payload)));
    assert.match(r.text, /2 vendors added, 1 filled in/);
    const vs = (await query(`SELECT name, trade, contact_name, email, phone, website, notes FROM crm_vendors WHERE tenant_id = $1 ORDER BY name`, [t])).rows;
    assert.deepEqual(vs.map(v => v.name), ['Bayou Tile Supply', 'Gulf Framing', 'Sparks Electric']);
    const g = vs.find(v => v.name === 'Gulf Framing');
    assert.equal(g.email, 'office@gulf.test', 'what they typed stays'); assert.equal(g.phone, '713-555-0101', 'the empty phone filled in'); assert.equal(g.contact_name, 'Rudy');
    const b = vs.find(v => v.name === 'Bayou Tile Supply');
    assert.equal(b.website, 'https://bayoutile.test'); assert.match(b.notes, /12 Main St/);
    assert.equal(vs.find(v => v.name === 'Sparks Electric').email, null, 'a bad email isn’t kept');

    // The same file again: nothing new.
    await assert.rejects(tool.prepare(ctx, { chat_file_id: file }), /already in your vendors/);
    console.log('VENDOR LIST SCENARIO PASSED');
  } catch (e) {
    console.error('VENDOR LIST SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM tenants WHERE id = $1', [t]).catch(() => {});
    await pool.end();
  }
})();
