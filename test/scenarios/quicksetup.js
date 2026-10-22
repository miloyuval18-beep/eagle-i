// The quick way through setup: signing up with Google (company, join, homeowner,
// sub, sign-in), the company's details from its Google listing and signature,
// customers and subs found in Gmail (added as one undoable import, nobody
// emailed), a whole team invited at once, and the core automatic emails on
// with one tap. Google is a stand-in here.
const { R } = require('./_local');
const assert = require('assert/strict');
const crypto = require('crypto');
delete process.env.RESEND_API_KEY; delete process.env.ANTHROPIC_API_KEY;
process.env.GOOGLE_CRM_CLIENT_ID = 'cid.apps.googleusercontent.com'; process.env.GOOGLE_CRM_CLIENT_SECRET = 'secret';
process.env.SOCIAL_CREDENTIALS_KEY = process.env.SOCIAL_CREDENTIALS_KEY || crypto.randomBytes(32).toString('hex');
const sent = [];
const realEmail = require(R + '/lib/email');
require.cache[require.resolve(R + '/lib/email')].exports = { ...realEmail, sendEmail: async (m) => { sent.push(m); return { id: 'e' + sent.length }; } };
const { query, pool } = require(R + '/db');
const acc = require(R + '/lib/crmAccounts');
const quick = require(R + '/lib/crmQuickSetup');
const tag = Date.now().toString(36);

// A stand-in Google: who signs in, and what's in their Gmail.
let who = { email: `olga.${tag}@buildco-${tag}.test`, name: 'Olga Owner', email_verified: true };
const gmail = {
  list: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }, { id: 'm4' }, { id: 'm5' }, { id: 'm6' }],
  msgs: {}
};
const hdr = (o) => ({ payload: { headers: Object.entries(o).map(([name, value]) => ({ name, value })) }, internalDate: String(Date.now() - 86400000) });
function setMail(me) {
  gmail.msgs = {
    m1: hdr({ From: me, To: 'Ana Ruiz <ana.ruiz@gmail.com>', Subject: 'Your kitchen remodel estimate' }),
    m2: hdr({ From: 'Ana Ruiz <ana.ruiz@gmail.com>', To: me, Subject: 'Re: Your kitchen remodel estimate' }),
    m3: hdr({ From: me, To: 'Pete <pete@acmeplumbing.test>', Subject: 'Rough-in at the Ruiz job' }),
    m4: hdr({ From: 'Deals <no-reply@lumberdeals.test>', To: me, Subject: '50% off' }),
    m5: hdr({ From: me, To: `Sam Super <sam@buildco-${tag}.test>`, Subject: 'Schedule' }),
    m6: hdr({ From: 'Stranger <who@random.test>', To: me, Subject: 'Hi' })
  };
}
const json = (o, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => o });
async function http(url, opts = {}) {
  const u = String(url);
  if (u.startsWith('https://oauth2.googleapis.com/token')) {
    const body = String(opts.body || '');
    if (/grant_type=refresh_token/.test(body)) return json({ access_token: 'at-refresh', expires_in: 3600 });
    return json({ access_token: 'at-1', refresh_token: 'rt-1', scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly', expires_in: 3600 });
  }
  if (u.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) return json(who);
  if (u.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages?')) {
    if (/in%3Asent|in:sent/.test(u)) return json({ messages: [{ id: 's1' }] });
    return json({ messages: gmail.list });
  }
  const m = u.match(/messages\/(\w+)\?format=(\w+)/);
  if (m && m[1] === 's1') return json({ payload: { mimeType: 'text/plain', body: { data: Buffer.from('Thanks,\nOlga Owner\nBuildCo\n(713) 555-0142\n1200 Main St, Houston, TX 77002').toString('base64url') } } });
  if (m) return json(gmail.msgs[m[1]] || {});
  if (u.startsWith('https://places.googleapis.com/')) return json({ places: [{ displayName: { text: 'BuildCo' }, formattedAddress: '1200 Main St, Houston, TX 77002, USA', nationalPhoneNumber: '(713) 555-0100', websiteUri: `https://buildco-${tag}.test/` }] });
  throw new Error('unexpected ' + u);
}
global.fetch = http; // the lookup and the Gmail token use fetch by default
const startState = async (type, extra = {}) => new URL(await acc.googleStart({ type, redirectUri: 'https://app.test/api/crm/google/oauth/callback', ...extra })).searchParams.get('state');
const finish = (state) => acc.googleFinish({ code: 'c', state, redirectUri: 'https://app.test/api/crm/google/oauth/callback', baseUrl: 'https://app.test', http });

(async () => {
  const tenants = [];
  const emails = [];
  try {
    // 1. Continue with Google: a new company, signed in, Gmail connected, email confirmed.
    const url = new URL(await acc.googleStart({ type: 'company', companyName: 'BuildCo', redirectUri: 'https://app.test/cb' }));
    assert.match(url.searchParams.get('scope'), /gmail\.readonly/); assert.equal(url.searchParams.get('access_type'), 'offline');
    await assert.rejects(acc.googleStart({ type: 'company', companyName: '', redirectUri: 'x' }), /company’s name/);
    await assert.rejects(acc.googleStart({ type: 'join', code: 'ZZZZ-ZZZZ', redirectUri: 'x' }), /doesn’t match/);
    emails.push(who.email);
    const r = await finish(await startState('company', { companyName: 'BuildCo' }));
    assert.equal(r.as, 'staff'); assert.equal(r.isNew, true);
    tenants.push(r.tenantId);
    const owner = (await query('SELECT * FROM users WHERE id = $1', [r.id])).rows[0];
    assert.equal(owner.role, 'owner'); assert.equal(owner.app, 'crm'); assert.equal(owner.email_verified, true); assert.equal(owner.name, 'Olga Owner');
    const box = (await query('SELECT * FROM crm_mailboxes WHERE tenant_id = $1', [r.tenantId])).rows[0];
    assert.ok(box && box.refresh_token_enc && /gmail/.test(box.scopes), 'their Gmail is connected in the same step');
    assert.equal(sent.length, 0, 'no “confirm your email”: Google already did');
    const dup = await finish(await startState('company', { companyName: 'BuildCo again' }));
    assert.equal(dup.id, r.id, 'someone who already has a company is signed in, not given a second one');
    const again = await finish(await startState('signin'));
    assert.equal(again.as, 'staff'); assert.equal(again.id, r.id, 'signing in with Google finds them');
    await assert.rejects(finish('f'.repeat(48)), /took too long/);
    const t = r.tenantId;

    // 2. The company's details: the Google listing and the email signature.
    setMail(who.email);
    const lk = await quick.lookup({ tenantId: t, userId: r.id, http, apiKey: 'k' });
    assert.equal(lk.listings[0].name, 'BuildCo'); assert.equal(lk.listings[0].match, true, 'the website matches their email');
    assert.equal(lk.signature.phone, '(713) 555-0142'); assert.match(lk.signature.address, /1200 Main St, Houston, TX 77002/);
    assert.match(lk.suggest.address, /1200 Main St/); assert.equal(lk.suggest.email, who.email);
    assert.deepEqual(quick.fromSignature('Bob\n12 Oak Ln\nHouston TX 77008'), { phone: null, address: '12 Oak Ln, Houston TX 77008' });

    // 3. Customers, subs and coworkers from Gmail.
    const sc = await quick.scan({ tenantId: t, userId: r.id, http, fresh: true });
    assert.equal(sc.connected, true);
    const ana = sc.people.find(p => p.email === 'ana.ruiz@gmail.com');
    assert.equal(ana.kind, 'customer'); assert.equal(ana.tick, true); assert.equal(ana.name, 'Ana Ruiz'); assert.equal(ana.emails, 2);
    const pete = sc.people.find(p => p.email === 'pete@acmeplumbing.test');
    assert.equal(pete.kind, 'sub'); assert.equal(pete.trade, 'Plumbing'); assert.equal(pete.tick, true);
    assert.ok(!sc.people.some(p => /no-reply|random\.test/.test(p.email)), 'no robots, nobody they never wrote to');
    assert.deepEqual(sc.coworkers.map(c => c.email), [`sam@buildco-${tag}.test`]);
    const added = await quick.addFound({ tenantId: t, userId: r.id, customers: [ana], subs: [pete] });
    assert.equal(added.added, 2);
    const deal = (await query(`SELECT d.*, c.email FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id WHERE d.tenant_id = $1`, [t])).rows[0];
    assert.equal(deal.email, 'ana.ruiz@gmail.com');
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM crm_playbook_sends WHERE deal_id = $1', [deal.id])).rows[0].n, 0, 'nobody is emailed');
    assert.equal((await query('SELECT trade FROM crm_vendors WHERE tenant_id = $1', [t])).rows[0].trade, 'Plumbing');
    assert.equal((await quick.scan({ tenantId: t, userId: r.id, http })).people.length, 0, 'already added ones aren’t offered again');
    assert.equal((await require(R + '/lib/crmImport').list(t))[0].kindLabel, 'Customers and subs from your email');
    await require(R + '/lib/crmImport').undo({ tenantId: t, id: added.id });
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM crm_deals WHERE tenant_id = $1', [t])).rows[0].n, 0, 'undone in one tap');
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM crm_vendors WHERE tenant_id = $1', [t])).rows[0].n, 0);
    await assert.rejects(quick.addFound({ tenantId: t, userId: r.id }), /Tick at least one/);

    // 4. The whole team at once.
    assert.deepEqual(quick.parseList('Pat Smith, pat@x.test\nsam@x.test; lee@x.test\nnot an email\npat@x.test'), [
      { email: 'pat@x.test', name: 'Pat Smith' }, { email: 'sam@x.test', name: null }, { email: 'lee@x.test', name: null }]);
    sent.length = 0;
    const inv = await quick.inviteMany({ tenantId: t, actor: owner, people: [{ email: `sam@buildco-${tag}.test`, name: 'Sam Super', role: 'superintendent' }, { email: 'bad' }, { email: `pat.${tag}@x.test` }], baseUrl: 'https://app.test' });
    assert.equal(inv.sent, 2); assert.equal(inv.results[1].ok, false);
    assert.equal((await query('SELECT role FROM crm_invites WHERE tenant_id = $1 AND email = $2', [t, `sam@buildco-${tag}.test`])).rows[0].role, 'superintendent');
    assert.equal(sent.length, 2, 'each gets their invitation');

    // 5. Joining with Google and the company code: an invitation lets Sam straight in.
    const code = await acc.joinCode(t);
    who = { email: `sam@buildco-${tag}.test`, name: 'Sam Super', email_verified: true };
    const j = await finish(await startState('join', { code }));
    assert.equal(j.as, 'staff'); assert.equal((await query('SELECT role, email_verified FROM users WHERE id = $1', [j.id])).rows[0].role, 'superintendent');
    who = { email: `nobody.${tag}@x.test`, name: 'No Body', email_verified: true };
    const p = await finish(await startState('join', { code }));
    assert.equal(p.pending, true, 'without an invitation, the owner is asked');
    await assert.rejects(finish(await startState('signin')), /waiting for the owner/);

    // 6. Homeowners and subs: no password, confirmed at once.
    who = { email: `hana.${tag}@gmail.com`, name: 'Hana Home', email_verified: true }; emails.push(who.email);
    const h = await finish(await startState('homeowner'));
    assert.equal(h.as, 'homeowner');
    assert.equal((await acc.getAccount(h.id)).email_verified, true);
    assert.equal((await finish(await startState('homeowner'))).id, h.id, 'a second time signs them in');
    assert.equal((await finish(await startState('signin'))).as, 'homeowner');
    who = { email: `stan.${tag}@tile.test`, name: 'Stan', email_verified: true }; emails.push(who.email);
    const sb = await finish(await startState('sub', { businessName: 'Stan Tile', trade: 'Tile' }));
    assert.equal((await acc.getAccount(sb.id)).business_name, 'Stan Tile');
    who = { email: `unknown.${tag}@x.test`, name: 'U', email_verified: true };
    await assert.rejects(finish(await startState('signin')), /No Eagle I CRM account uses/);
    who = { email: `unconfirmed.${tag}@x.test`, name: 'U', email_verified: false };
    await assert.rejects(finish(await startState('homeowner')), /hasn’t confirmed/);

    // 7. The core automatic emails, on with one tap.
    const rec = await quick.recommended(t);
    assert.ok(rec.length >= 6 && rec.every(e => !e.on && e.what));
    const on = await quick.turnOn({ tenantId: t, ids: rec.slice(0, 3).map(e => e.id) });
    assert.equal(on.on, 3); assert.equal(on.waitingForAddress, true, 'says they wait for the address');
    const after = await quick.recommended(t);
    assert.equal(after.filter(e => e.on).length, 3);
    console.log('QUICK SETUP SCENARIO PASSED');
  } catch (e) {
    console.error('QUICK SETUP SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM crm_accounts WHERE email LIKE $1', [`%${tag}%`]).catch(() => {});
    await query(`DELETE FROM tenants WHERE id = ANY($1::uuid[]) OR company_name = 'BuildCo' AND created_at > now() - interval '1 hour'`, [tenants]).catch(() => {});
    await pool.end();
  }
})();
