// Claude and ChatGPT, connected to Eagle I: the OAuth sign-in they use (lib/crmOAuth.js),
// the MCP endpoint they call (lib/crmMcp.js, at /mcp), and the Account screen's list of
// connected apps. Discovery follows the MCP spec: /.well-known/oauth-protected-resource
// points to this server, /.well-known/oauth-authorization-server describes it.
const express = require('express');
const crypto = require('crypto');
const oauth = require('../lib/crmOAuth');
const mcp = require('../lib/crmMcp');
const team = require('../lib/crmTeam');
const { query } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
const base = (req) => require('../lib/appUrl').appUrl() || `${req.protocol}://${req.get('host')}`;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const form = express.urlencoded({ extended: false, limit: '64kb' });

// Server-to-server calls (no cookies are read on these), so any origin may call them.
function cors(req, res, next) {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id' });
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}
const oerr = (res, e) => res.status(e.status || 500).json({ error: e.oauth || 'server_error', error_description: e.message || 'Something went wrong.' });

// ---------- discovery ----------
const resourceMeta = (req) => ({ resource: `${base(req)}/mcp`, authorization_servers: [base(req)], bearer_methods_supported: ['header'], resource_name: 'Eagle I', resource_documentation: `${base(req)}/crm/app` });
const serverMeta = (req) => {
  const b = base(req);
  return { issuer: b, authorization_endpoint: `${b}/oauth/authorize`, token_endpoint: `${b}/oauth/token`, registration_endpoint: `${b}/oauth/register`, revocation_endpoint: `${b}/oauth/revoke`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'], scopes_supported: ['eagle-i'], service_documentation: `${b}/crm/app` };
};
router.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], cors, (req, res) => res.json(resourceMeta(req)));
router.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp', '/.well-known/openid-configuration'], cors, (req, res) => res.json(serverMeta(req)));

// ---------- the app registers itself ----------
router.options('/oauth/register', cors);
router.post('/oauth/register', cors, async (req, res) => {
  try { res.status(201).json(await oauth.register(req.body || {})); } catch (e) { oerr(res, e); }
});

// ---------- the person signs in and taps Allow ----------
const PAGE = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Eagle I</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
<style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px 16px;background:radial-gradient(1200px 600px at 50% -10%,#2a2215,#0b0a08 60%);color:#f3ecdc;font:18px/1.55 Inter,system-ui,sans-serif}
.c{width:min(520px,100%);background:linear-gradient(180deg,#17140f,#0e0c09);border:1.5px solid rgba(212,175,97,.55);border-radius:20px;padding:26px 24px;box-shadow:0 0 50px -18px rgba(212,175,97,.6)}
h1{font-family:'Cormorant Garamond',Georgia,serif;font-size:34px;line-height:1.1;margin:0 0 6px;color:#f6ecd4}.k{font-size:13px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#d4af61}
.who{margin:14px 0;padding:12px 14px;border-radius:12px;background:rgba(212,175,97,.07);border:1px solid rgba(212,175,97,.25)}ul{padding-left:22px;margin:8px 0 14px}li{margin:6px 0}
.b{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}button,a.x{font:inherit;font-weight:800;font-size:18px;border-radius:14px;padding:13px 22px;min-height:52px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}
.go{border:0;color:#16130c;background:linear-gradient(180deg,#f2d690 0%,#dab364 45%,#b98d3c 100%)}.no{background:transparent;color:#dcd0b6;border:1px solid rgba(212,175,97,.45)}.sm{font-size:15px;color:#b9ae96}a{color:#e8c983}</style></head>
<body><main class="c">${body}</main></body></html>`;

async function signedIn(req) {
  const s = req.session || {};
  // An Eagle I admin looking into a company, or "See as", can't hand out access.
  if (!s.userId || s.viewAs || s.lookUser || s.lookRole || s.twoStep) return null;
  const u = await team.getUser(s.userId);
  if (!u || u.disabled_at || u.tenant_id !== s.tenantId || u.app === 'marketing') return null;
  const t = (await query(`SELECT company_name, products FROM tenants WHERE id = $1`, [u.tenant_id])).rows[0];
  if (!t || !(t.products || []).includes('crm')) return null;
  return { ...u, company: t.company_name };
}

const AUTH_KEYS = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'];
router.get('/oauth/authorize', async (req, res) => {
  res.set({ 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'", 'Cache-Control': 'no-store' });
  const q = Object.fromEntries(AUTH_KEYS.map(k => [k, typeof req.query[k] === 'string' ? req.query[k] : undefined]));
  let c;
  try { c = await oauth.checkAuthorize(q); }
  catch (e) { return res.status(400).send(PAGE('Can’t connect', `<div class="k">Eagle I</div><h1>This link didn’t work</h1><p>${esc(e.message)}</p><p class="sm">Go back to Claude or ChatGPT and add the Eagle I connector again.</p>`)); }
  const app = oauth.appName(c, q.redirect_uri);
  const u = await signedIn(req);
  const here = '/oauth/authorize?' + new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined)).toString();
  if (!u) return res.redirect('/crm/login?next=' + encodeURIComponent(here));
  const csrf = crypto.randomBytes(24).toString('base64url');
  req.session.oauthCsrf = csrf;
  const hidden = Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  res.send(PAGE(`Connect ${app}`, `<div class="k">Eagle I</div><h1>Connect ${esc(app)} to Eagle I?</h1>
    <div class="who">Signed in as <b>${esc(u.name || u.email)}</b> (${esc(u.email)})<br>${esc(u.company || '')}</div>
    <p>${esc(app)} will be able to, as you and only with your permissions:</p>
    <ul><li>See your projects, customers, schedule, subs, permits${team.can(u, 'money') ? ' and money' : ''}, the same as you can in Eagle I.</li>
    <li>Save things from your chats to a project: documents, notes, tasks, costs, permits, and change a project’s status.</li>
    <li>It can’t email or text your customers or subs.</li></ul>
    <p class="sm">You can disconnect it any time in Eagle I: Account → Claude &amp; ChatGPT.</p>
    <form method="post" action="/oauth/authorize">${hidden}<input type="hidden" name="csrf" value="${esc(csrf)}">
      <div class="b"><button class="go" name="decision" value="allow" type="submit">Allow</button><button class="no" name="decision" value="deny" type="submit">Cancel</button></div></form>
    <p class="sm" style="margin-top:16px">Not you? <a href="/crm/login?next=${esc(encodeURIComponent(here))}">Sign in as someone else</a></p>`));
});

router.post('/oauth/authorize', form, async (req, res) => {
  res.set({ 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store' });
  const b = req.body || {};
  const q = Object.fromEntries(AUTH_KEYS.map(k => [k, typeof b[k] === 'string' ? b[k] : undefined]));
  try {
    const c = await oauth.checkAuthorize(q);
    const u = await signedIn(req);
    const want = req.session && req.session.oauthCsrf;
    if (!u || !want || typeof b.csrf !== 'string' || b.csrf.length !== want.length || !crypto.timingSafeEqual(Buffer.from(b.csrf), Buffer.from(want))) {
      return res.status(400).send(PAGE('Try again', `<div class="k">Eagle I</div><h1>Please try again</h1><p>That page was open too long. Go back to ${esc(oauth.appName(c, q.redirect_uri))} and connect again.</p>`));
    }
    delete req.session.oauthCsrf;
    const back = new URL(q.redirect_uri);
    if (b.decision !== 'allow') { back.searchParams.set('error', 'access_denied'); if (q.state) back.searchParams.set('state', q.state); return res.redirect(back.toString()); }
    const code = await oauth.issueCode({ clientId: c.id, user: u, redirectUri: q.redirect_uri, challenge: q.code_challenge });
    back.searchParams.set('code', code);
    if (q.state) back.searchParams.set('state', q.state);
    back.searchParams.set('iss', base(req));
    res.redirect(back.toString());
  } catch (e) { res.status(400).send(PAGE('Can’t connect', `<div class="k">Eagle I</div><h1>This didn’t work</h1><p>${esc(e.message)}</p>`)); }
});

// ---------- tokens ----------
function basicAuth(req) {
  const h = req.get('authorization') || '';
  if (!/^Basic /i.test(h)) return null;
  try { const [id, secret] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':'); return { id: decodeURIComponent(id), secret: decodeURIComponent(secret || '') }; } catch (e) { return null; }
}
router.options(['/oauth/token', '/oauth/revoke'], cors);
router.post('/oauth/token', cors, form, async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  try { res.json(await oauth.token(req.body || {}, basicAuth(req))); } catch (e) { oerr(res, e); }
});
router.post('/oauth/revoke', cors, form, async (req, res) => {
  const t = String((req.body || {}).token || '');
  await query(`UPDATE crm_oauth_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [oauth.hash(t)]).catch(() => {});
  res.status(200).end();
});

// ---------- the MCP endpoint ----------
router.options('/mcp', cors);
router.get('/mcp', cors, (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Use POST. This connector answers with JSON, not a stream.' }));
router.delete('/mcp', cors, (req, res) => res.status(204).end());
router.post('/mcp', cors, async (req, res) => {
  const h = req.get('authorization') || '';
  const who = /^Bearer /i.test(h) ? await oauth.whoFor(h.slice(7).trim()).catch(() => null) : null;
  if (!who) {
    res.set('WWW-Authenticate', `Bearer resource_metadata="${base(req)}/.well-known/oauth-protected-resource", error="invalid_token"`);
    return res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Sign in to Eagle I to use this connector.' } });
  }
  const ctx = mcp.ctxFor(who, base(req));
  const body = req.body;
  try {
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(m => mcp.handle(ctx, m)))).filter(Boolean);
      return out.length ? res.json(out) : res.status(202).end();
    }
    const out = await mcp.handle(ctx, body);
    if (!out) return res.status(202).end();
    res.json(out);
  } catch (e) {
    console.error('[mcp]', e.message);
    res.json({ jsonrpc: '2.0', id: body && body.id !== undefined ? body.id : null, error: { code: -32603, message: 'Something went wrong in Eagle I.' } });
  }
});

// ---------- Account → Claude & ChatGPT ----------
router.get('/api/crm/connectors', requireAuth, async (req, res) => {
  try { res.json({ url: `${base(req)}/mcp`, apps: await oauth.connected(req.userId) }); } catch (e) { res.status(500).json({ error: { message: 'Failed to load' } }); }
});
router.delete('/api/crm/connectors/:clientId', requireAuth, async (req, res) => {
  try { res.json(await oauth.disconnect(req.userId, String(req.params.clientId))); } catch (e) { res.status(500).json({ error: { message: 'Failed to disconnect' } }); }
});

module.exports = router;
