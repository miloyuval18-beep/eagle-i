// "Sign in with Google" for companies on personal Gmail: each person connects
// their own account; their customer emails land on deals; the owner's Drive
// holds the project files. Against a fake Google (no network).
const { R } = require('./_local');
const assert = require('assert/strict');
const crypto = require('crypto');
delete process.env.RESEND_API_KEY; delete process.env.ANTHROPIC_API_KEY; delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
process.env.GOOGLE_CRM_CLIENT_ID = 'cid.apps.googleusercontent.com'; process.env.GOOGLE_CRM_CLIENT_SECRET = 'secret';
process.env.SOCIAL_CREDENTIALS_KEY = process.env.SOCIAL_CREDENTIALS_KEY || crypto.randomBytes(32).toString('hex');
const { query, pool } = require(R + '/db');
const crm = require(R + '/lib/crm'); const G = require(R + '/lib/crmGoogle'); const drive = require(R + '/lib/crmDrive'); const portal = require(R + '/lib/crmPortal');

// ---------- a fake Google ----------
const people = { 'code-owner': { rt: 'rt-owner', email: 'levihomes@gmail.com', name: 'Moran Levi', scope: 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive' },
  'code-alex': { rt: 'rt-alex', email: 'alex.levihomes@gmail.com', name: 'Alex', scope: 'openid email https://www.googleapis.com/auth/gmail.readonly' } };
const revoked = new Set(); const revokeCalls = [];
const mail = {
  'levihomes@gmail.com': [{ id: 'm1', from: 'Maria Garcia <maria.garcia@gmail.com>', to: 'levihomes@gmail.com', subject: 'Island size', body: 'Can the island seat four?' }],
  'alex.levihomes@gmail.com': [{ id: 'm2', from: 'alex.levihomes@gmail.com', to: 'maria.garcia@gmail.com', subject: 'Re: Island size', body: 'Yes, 8 feet does it.' }, { id: 'm3', from: 'newsletter@shop.com', to: 'alex.levihomes@gmail.com', subject: 'Sale', body: 'x' }]
};
const driveFiles = new Map(); let fid = 0; const changes = [];
const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
const b64url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function fakeGoogle(url, opts = {}) {
  const u = new URL(url); const auth = (opts.headers && opts.headers.Authorization) || '';
  const who = Object.values(people).find(p => auth === 'Bearer at-' + p.rt);
  if (u.hostname === 'oauth2.googleapis.com' && u.pathname === '/token') {
    const b = new URLSearchParams(opts.body);
    if (b.get('client_id') !== process.env.GOOGLE_CRM_CLIENT_ID) return json({ error: 'invalid_client' }, 401);
    if (b.get('grant_type') === 'authorization_code') { const p = people[b.get('code')]; return p ? json({ access_token: 'at-' + p.rt, refresh_token: p.rt, scope: p.scope, expires_in: 3600 }) : json({ error: 'invalid_grant' }, 400); }
    if (b.get('grant_type') === 'refresh_token') return revoked.has(b.get('refresh_token')) ? json({ error: 'invalid_grant' }, 400) : json({ access_token: 'at-' + b.get('refresh_token'), expires_in: 3600 });
  }
  if (u.hostname === 'oauth2.googleapis.com' && u.pathname === '/revoke') { revokeCalls.push(new URLSearchParams(opts.body).get('token')); return json({}); }
  if (!who) return json({ error: { message: 'unauthenticated' } }, 401);
  if (u.pathname === '/v1/userinfo') return json({ email: who.email, name: who.name });
  if (u.pathname === '/gmail/v1/users/me/messages') return json({ messages: (mail[who.email] || []).map(m => ({ id: m.id })) });
  const mm = u.pathname.match(/^\/gmail\/v1\/users\/me\/messages\/(\w+)$/);
  if (mm) {
    const m = (mail[who.email] || []).find(x => x.id === mm[1]);
    return json({ id: m.id, internalDate: String(Date.now()), snippet: m.body, payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: m.from }, { name: 'To', value: m.to }, { name: 'Subject', value: m.subject }, { name: 'Message-ID', value: `<${m.id}@x>` }], body: { data: b64url(m.body) } } });
  }
  // Drive (a personal account: no shared drives)
  const p = u.pathname.replace('/drive/v3', '').replace('/upload', '');
  if (opts.method === 'POST' && p === '/drives') return json({ error: { message: 'The user does not have sufficient permissions to create a shared drive.' } }, 403);
  if (p === '/changes/startPageToken') return json({ startPageToken: '0' });
  if (p === '/changes') return json({ changes: changes.slice(Number(u.searchParams.get('pageToken'))), newStartPageToken: String(changes.length) });
  if (opts.method === 'POST' && p === '/files') { const b = JSON.parse(opts.body || '{}'); const f = { id: 'd' + (++fid), name: b.name, parents: b.parents, owner: who.email }; driveFiles.set(f.id, f); return json({ id: f.id }); }
  return json({ error: { message: 'unexpected ' + url } }, 400);
}
drive.setHttp(fakeGoogle);

(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Levi Homes Test', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    const owner = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'moran@levi.test', 'x', 'Moran', 'owner') RETURNING id`, [t])).rows[0].id;
    const alex = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'alex@levi.test', 'x', 'Alex', 'member') RETURNING id`, [t])).rows[0].id;
    await query(`INSERT INTO business_profile (tenant_id, email) VALUES ($1, 'o@levi.test')`, [t]);
    const deal = await crm.createDeal({ tenantId: t, name: 'Maria Garcia', email: 'maria.garcia@gmail.com', title: 'Garcia kitchen', userId: owner });
    const redirectUri = 'https://app.test/api/crm/google/oauth/callback';

    // 1. The sign-in link asks for email (and Drive, for the owner) with lasting access.
    const st = await G.getStatus(t, owner);
    assert.equal(st.signIn, true); assert.equal(st.configured, false, 'no Workspace service account needed');
    const url = new URL(await G.signInUrl({ tenantId: t, userId: owner, wantDrive: true, redirectUri }));
    assert.equal(url.hostname, 'accounts.google.com');
    assert.match(url.searchParams.get('scope'), /gmail\.readonly.*auth\/drive/);
    assert.equal(url.searchParams.get('access_type'), 'offline'); assert.equal(url.searchParams.get('redirect_uri'), redirectUri);
    const state = url.searchParams.get('state');
    // Someone else can't finish your sign-in, and a state works once.
    await assert.rejects(G.finishSignIn({ tenantId: t, userId: alex, code: 'code-owner', state, redirectUri, http: fakeGoogle }), /expired/);
    const url2 = new URL(await G.signInUrl({ tenantId: t, userId: owner, wantDrive: true, redirectUri }));
    const r1 = await G.finishSignIn({ tenantId: t, userId: owner, code: 'code-owner', state: url2.searchParams.get('state'), redirectUri, http: fakeGoogle });
    assert.deepEqual([r1.email, r1.mail, r1.drive, r1.wantedDrive], ['levihomes@gmail.com', true, true, true]);
    await assert.rejects(G.finishSignIn({ tenantId: t, userId: owner, code: 'code-owner', state: url2.searchParams.get('state'), redirectUri, http: fakeGoogle }), /expired/, 'a state is used once');
    const conn = (await query('SELECT * FROM crm_google_connections WHERE tenant_id = $1', [t])).rows[0];
    assert.equal(conn.kind, 'signin'); assert.equal(conn.domain, '');
    const mb = (await query('SELECT * FROM crm_mailboxes WHERE tenant_id = $1', [t])).rows[0];
    assert.ok(mb.refresh_token_enc && !JSON.stringify(mb.refresh_token_enc).includes('rt-owner'), 'the refresh token is stored encrypted');
    assert.equal(conn.drive_mailbox_id, mb.id, 'the owner’s Drive holds the files');

    // 2. Alex connects his own Gmail (email only).
    const u3 = new URL(await G.signInUrl({ tenantId: t, userId: alex, redirectUri }));
    assert.doesNotMatch(u3.searchParams.get('scope'), /auth\/drive/);
    await G.finishSignIn({ tenantId: t, userId: alex, code: 'code-alex', state: u3.searchParams.get('state'), redirectUri, http: fakeGoogle });
    const st2 = await G.getStatus(t, alex);
    assert.equal(st2.mailboxes.length, 2); assert.ok(st2.mineConnected);
    assert.ok(st2.mailboxes.find(m => m.email === 'levihomes@gmail.com').drive);

    // 3. Reading email: a customer on gmail.com is still the customer; Alex writing to her is the team.
    const sync = await G.processGoogleSync({ http: fakeGoogle, onlyTenantId: t });
    assert.equal(sync.errors, 0); assert.equal(sync.stored, 2, 'the newsletter is not kept');
    const emails = (await query('SELECT message_key, direction, deal_id, body_text FROM crm_emails WHERE tenant_id = $1 ORDER BY message_key', [t])).rows;
    assert.deepEqual(emails.map(e => [e.message_key, e.direction, e.deal_id]), [['<m1@x>', 'in', deal.id], ['<m2@x>', 'out', deal.id]]);
    assert.match(emails[0].body_text, /seat four/);
    assert.equal(G.isCompany('maria.garcia@gmail.com', '', new Set(['levihomes@gmail.com'])), false);

    // 4. Drive in a personal account: an "Eagle I Projects" folder in My Drive (no shared drive), a folder per job.
    const ds = await drive.enable(t);
    assert.equal(ds.on, true); assert.equal(ds.sharedDrive, false); assert.equal(ds.account, 'levihomes@gmail.com');
    await drive.processDriveSync();
    const root = [...driveFiles.values()].find(f => f.name === 'Eagle I Projects');
    assert.deepEqual(root.parents, ['root']); assert.equal(root.owner, 'levihomes@gmail.com');
    assert.ok([...driveFiles.values()].some(f => f.name.startsWith('Garcia kitchen')));

    // 5. Access removed in Google: that mailbox says so (the others keep working).
    revoked.add('rt-alex'); G._tokenCache.clear();
    await query(`UPDATE crm_mailboxes SET last_synced_at = NULL WHERE tenant_id = $1`, [t]);
    const s2 = await G.processGoogleSync({ http: fakeGoogle, onlyTenantId: t });
    assert.equal(s2.errors, 1);
    const bad = (await query(`SELECT status, last_error FROM crm_mailboxes WHERE tenant_id = $1 AND email = 'alex.levihomes@gmail.com'`, [t])).rows[0];
    assert.equal(bad.status, 'error'); assert.match(bad.last_error, /Sign in with Google again/);
    assert.equal((await query('SELECT status FROM crm_google_connections WHERE tenant_id = $1', [t])).rows[0].status, 'connected', 'one person’s problem doesn’t switch off the company');

    // 6. Removing a mailbox hands the access back to Google; removing the Drive holder switches Drive off.
    await G.removeMailbox({ tenantId: t, id: (await query(`SELECT id FROM crm_mailboxes WHERE tenant_id = $1 AND email = 'alex.levihomes@gmail.com'`, [t])).rows[0].id, http: fakeGoogle });
    assert.ok(revokeCalls.includes('rt-alex'));
    await G.removeMailbox({ tenantId: t, id: mb.id, http: fakeGoogle });
    assert.equal((await query('SELECT 1 FROM crm_google_connections WHERE tenant_id = $1', [t])).rows.length, 0, 'nobody left: the connection is gone');
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM crm_emails WHERE tenant_id = $1', [t])).rows[0].n, 2, 'emails already on deals stay');

    // 7. A Workspace company doesn't use the personal sign-in.
    await query(`INSERT INTO crm_google_connections (tenant_id, kind, domain, admin_email) VALUES ($1, 'workspace', 'levi.test', 'admin@levi.test')`, [t]);
    await assert.rejects(G.signInUrl({ tenantId: t, userId: alex, redirectUri }), /Google Workspace already/);
    console.log('GOOGLE SIGN-IN SCENARIO PASSED');
  } catch (e) {
    console.error('GOOGLE SIGN-IN SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM tenants WHERE id = $1', [t]).catch(() => {});
    await pool.end();
  }
})();
