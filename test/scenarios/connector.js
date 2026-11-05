// The Claude / ChatGPT connector: an app registers, the person allows it, it trades the
// code (with PKCE) for tokens, calls tools as that person (their permissions, no money for
// someone without "See money", no sending tools at all), saves a document to a project,
// refreshes once per refresh token, and loses access the moment it's disconnected.
const { R } = require('./_local');
const assert = require('assert/strict');
const crypto = require('crypto');
delete process.env.RESEND_API_KEY; delete process.env.ANTHROPIC_API_KEY;
const { query, pool } = require(R + '/db');
const L = (m) => require(R + '/lib/' + m);
const crm = L('crm'), team = L('crmTeam'), oauth = L('crmOAuth'), mcp = L('crmMcp');

(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Link Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, email, address) VALUES ($1, 'o@link.test', '1 Main St, Houston TX 77002')`, [t]);
    const ownerId = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role, app) VALUES ($1, 'o@link.test', 'x', 'Owner', 'owner', 'crm') RETURNING id`, [t])).rows[0].id;
    const memberId = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role, app) VALUES ($1, 'm@link.test', 'x', 'Member', 'member', 'crm') RETURNING id`, [t])).rows[0].id;
    const deal = await crm.createDeal({ tenantId: t, name: 'Ana Ruiz', address: '12 Oak St, Houston TX 77008', title: 'Ruiz kitchen', value: 85000, userId: ownerId });

    // 1. Registration only takes https (or this computer) return addresses.
    await assert.rejects(oauth.register({ redirect_uris: ['http://evil.test/cb'] }), /https/);
    const c = await oauth.register({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
    assert.equal(oauth.appName(await oauth.client(c.client_id), 'https://claude.ai/api/mcp/auth_callback'), 'Claude');
    await assert.rejects(oauth.checkAuthorize({ client_id: c.client_id, redirect_uri: 'https://other.test/cb', response_type: 'code', code_challenge: 'x', code_challenge_method: 'S256' }), /return address/);
    await assert.rejects(oauth.checkAuthorize({ client_id: c.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', response_type: 'code' }), /PKCE/);

    // 2. Allowed: the code, with the right verifier, becomes tokens (once).
    const signIn = async (userId) => {
      const v = crypto.randomBytes(32).toString('base64url'), ch = crypto.createHash('sha256').update(v).digest('base64url');
      const code = await oauth.issueCode({ clientId: c.client_id, user: await team.getUser(userId), redirectUri: 'https://claude.ai/api/mcp/auth_callback', challenge: ch });
      return { code, v };
    };
    const s1 = await signIn(ownerId);
    await assert.rejects(oauth.token({ grant_type: 'authorization_code', client_id: c.client_id, code: s1.code, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: 'wrong' }), /PKCE/);
    const s2 = await signIn(ownerId);
    const tok = await oauth.token({ grant_type: 'authorization_code', client_id: c.client_id, code: s2.code, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: s2.v });
    assert.ok(tok.access_token && tok.refresh_token);
    await assert.rejects(oauth.token({ grant_type: 'authorization_code', client_id: c.client_id, code: s2.code, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: s2.v }), /expired/, 'a code works once');

    // 3. Calls run as the owner: tools, a search, a saved document.
    const who = await oauth.whoFor(tok.access_token);
    assert.equal(who.user.id, ownerId); assert.equal(who.app, 'Claude');
    const ctx = mcp.ctxFor(who, 'https://myeaglei.com');
    const init = await mcp.handle(ctx, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(init.result.protocolVersion, '2025-06-18'); assert.equal(init.result.serverInfo.name, 'eagle-i');
    assert.equal(await mcp.handle(ctx, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    const names = (await mcp.handle(ctx, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.map(x => x.name);
    for (const n of ['search_crm', 'get_deal', 'save_document', 'create_task', 'add_cost', 'search', 'fetch']) assert.ok(names.includes(n), n);
    for (const n of ['send_email', 'send_invoice', 'send_estimate', 'email_homeowner', 'send_follow_up']) assert.ok(!names.includes(n), 'never offered: ' + n);
    const call = async (c2, name, args) => (await mcp.handle(c2, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } })).result;
    const found = await call(ctx, 'search_crm', { query: 'ruiz' });
    assert.equal(found.structuredContent.deals[0].id, deal.id); assert.equal(found.structuredContent.deals[0].value, 85000);
    const saved = await call(ctx, 'save_document', { deal_id: deal.id, title: 'Kitchen scope', content: '- Demo\n- New cabinets', folder: 'contracts' });
    assert.equal(saved.isError, false);
    const f = (await query(`SELECT filename, folder, caption FROM crm_files WHERE deal_id = $1`, [deal.id])).rows[0];
    assert.deepEqual([f.filename, f.folder, f.caption], ['Kitchen scope.md', 'contracts', 'Saved from Claude']);
    assert.equal((await call(ctx, 'send_email', {})).isError, true);
    assert.match((await call(ctx, 'fetch', { id: 'deal:' + deal.id })).content[0].text, /Ruiz kitchen/);

    // 4. Someone without "See money": no dollar figures, and no logging costs.
    await query(`UPDATE users SET permissions = $2 WHERE id = $1`, [memberId, JSON.stringify({ money: false })]);
    const s3 = await signIn(memberId);
    const mt = await oauth.token({ grant_type: 'authorization_code', client_id: c.client_id, code: s3.code, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: s3.v });
    const mctx = mcp.ctxFor(await oauth.whoFor(mt.access_token), 'https://myeaglei.com');
    const mfound = await call(mctx, 'search_crm', { query: 'ruiz' });
    assert.equal(mfound.structuredContent.deals[0].value ?? null, null, 'no money for them');
    assert.ok(!(await mcp.handle(mctx, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.some(x => x.name === 'add_cost'));

    // 5. Refresh: each refresh token once. Disconnect: everything stops.
    const t2 = await oauth.token({ grant_type: 'refresh_token', client_id: c.client_id, refresh_token: tok.refresh_token });
    await assert.rejects(oauth.token({ grant_type: 'refresh_token', client_id: c.client_id, refresh_token: tok.refresh_token }), /connect again/);
    assert.ok(await oauth.whoFor(t2.access_token));
    assert.equal((await oauth.connected(ownerId)).length, 1);
    await oauth.disconnect(ownerId, c.client_id);
    assert.equal(await oauth.whoFor(t2.access_token), null);
    await assert.rejects(oauth.token({ grant_type: 'refresh_token', client_id: c.client_id, refresh_token: t2.refresh_token }), /connect again/);
    assert.ok(await oauth.whoFor(mt.access_token), 'someone else’s connection is untouched');

    // 6. A turned-off account loses access.
    await query(`UPDATE users SET disabled_at = now() WHERE id = $1`, [memberId]);
    assert.equal(await oauth.whoFor(mt.access_token), null);
    console.log('CONNECTOR SCENARIO PASSED');
  } catch (e) {
    console.error('CONNECTOR SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query(`DELETE FROM crm_oauth_clients WHERE id IN (SELECT DISTINCT client_id FROM crm_oauth_tokens WHERE tenant_id = $1) OR (name = 'Claude' AND NOT EXISTS (SELECT 1 FROM crm_oauth_tokens x WHERE x.client_id = crm_oauth_clients.id))`, [t]).catch(() => {});
    await query('DELETE FROM tenants WHERE id = $1', [t]).catch(() => {});
    await pool.end();
  }
})();
