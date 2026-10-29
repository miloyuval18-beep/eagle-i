// Setup reminders: what's important and not set up yet, for the company (only to people
// allowed to set it up) and for the person; each with a guide and where to go; gone
// once done; "We don't need this" remembered per person.
const { R } = require('./_local');
const assert = require('assert/strict');
const { query, pool } = require(R + '/db');
const S = require(R + '/lib/crmSetupCheck');
const team = require(R + '/lib/crmTeam');
const tag = Date.now().toString(36);

(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Setup Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    const add = async (local, name, role) => (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role, app) VALUES ($1, $2, 'x', $3, $4, 'crm') RETURNING *`, [t, `${local}.${tag}@sc.dev`, name, role])).rows[0];
    const owner = await add('olive', 'Olive Owner', 'owner');
    const keys = async (u) => (await S.check(await team.getUser(u.id))).map(i => i.key);

    // A new company: everything the owner can set up, most important first; no Google yet, so not "your own email" too.
    assert.deepEqual(await keys(owner), ['google', 'address', 'projects', 'team', 'vendors', 'contact', 'emails']);
    const first = (await S.check(await team.getUser(owner.id)))[0];
    assert.ok(first.title && first.why && first.steps.length >= 2 && first.go && first.button, 'a guide and a place to go');

    // A member: only what they can fix themselves (nothing about the company's settings).
    const sam = await add('sam', null, 'member');
    // (Members can add subs by default, so that one too.)
    assert.deepEqual(await keys(sam), ['vendors', 'name']);

    // Done things stop showing.
    await query(`INSERT INTO business_profile (tenant_id, address, phone, email) VALUES ($1, '1 Main St, Houston TX 77002', '713-555-0100', 'office@sc.dev') ON CONFLICT (tenant_id) DO UPDATE SET address = EXCLUDED.address, phone = EXCLUDED.phone, email = EXCLUDED.email`, [t]);
    await query(`INSERT INTO crm_vendors (tenant_id, name, trade, email) VALUES ($1, 'Gulf Lumber', 'Lumber', 'g@sc.dev')`, [t]);
    await query(`INSERT INTO crm_google_connections (tenant_id, kind, status, admin_email, domain) VALUES ($1, 'signin', 'connected', '', '')`, [t]);
    let k = await keys(owner);
    assert.ok(!k.includes('address') && !k.includes('contact') && !k.includes('vendors') && !k.includes('google'));
    assert.ok(k.includes('drive'), 'Google connected but Drive off');
    assert.ok(k.includes('my_gmail'), 'signed in with Google, but not this person');
    assert.ok(!k.includes('team'), 'there are two people now');

    // "We don't need this": gone for them, not for anyone else; can be brought back.
    await S.skip(owner.id, 'drive'); await S.skip(owner.id, 'drive');
    assert.ok(!(await keys(owner)).includes('drive'));
    assert.deepEqual((await query(`SELECT setup_skips FROM users WHERE id = $1`, [owner.id])).rows[0].setup_skips, ['drive'], 'once');
    await assert.rejects(S.skip(owner.id, 'nope'), /Unknown item/);
    await S.unskipAll(owner.id);
    assert.ok((await keys(owner)).includes('drive'));
    console.log('SETUP CHECK SCENARIO PASSED');
  } catch (e) {
    console.error('SETUP CHECK SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM tenants WHERE id = $1', [t]).catch(() => {});
    await pool.end();
  }
})();
