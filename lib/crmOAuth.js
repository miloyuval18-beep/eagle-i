// Signing Claude or ChatGPT in to Eagle I (OAuth 2.1 with PKCE, as the MCP connector spec asks).
// The app registers itself (dynamic client registration), sends the person here to sign in
// to Eagle I and tap Allow, and gets a short-lived access token (refreshed as it's used).
// Each token acts as that one person, with their permissions. Tokens and codes are stored
// hashed; a person can disconnect an app any time (Account → Claude & ChatGPT).
const crypto = require('crypto');
const { query } = require('../db');

const ACCESS_TTL = 3600; // seconds
const REFRESH_DAYS = 60;
const CODE_TTL = 600;

function err(message, status = 400, code = 'invalid_request') { const e = new Error(message); e.status = status; e.oauth = code; return e; }
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const random = (n = 32) => crypto.randomBytes(n).toString('base64url');
const clip = (s, n) => (s == null ? null : String(s).trim().slice(0, n) || null);

// Where an app may send people back to: https, or this computer (for testing).
function okRedirect(u) {
  try {
    const x = new URL(u);
    if (x.hash) return false;
    if (x.protocol === 'https:') return true;
    return x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname);
  } catch (e) { return false; }
}

async function register(body = {}) {
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > 10 || !uris.every(okRedirect)) throw err('redirect_uris must be https addresses.', 400, 'invalid_redirect_uri');
  const method = ['client_secret_post', 'client_secret_basic'].includes(body.token_endpoint_auth_method) ? body.token_endpoint_auth_method : 'none';
  const id = 'eic_' + random(18);
  const secret = method === 'none' ? null : random(32);
  await query(`INSERT INTO crm_oauth_clients (id, name, redirect_uris, secret_hash) VALUES ($1, $2, $3, $4)`, [id, clip(body.client_name, 120), uris, secret ? hash(secret) : null]);
  return {
    client_id: id, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}), client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: clip(body.client_name, 120) || undefined, redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: method
  };
}

async function client(id) {
  if (!/^eic_[\w-]{10,40}$/.test(String(id || ''))) return null;
  return (await query(`SELECT * FROM crm_oauth_clients WHERE id = $1`, [id])).rows[0] || null;
}

// What the app is called on the Allow screen: its name if it gave one, else where it sends you back to.
function appName(c, redirectUri) {
  let host = '';
  try { host = new URL(redirectUri).hostname; } catch (e) {}
  if (/(^|\.)claude\.(ai|com)$|(^|\.)anthropic\.com$/.test(host)) return 'Claude';
  if (/(^|\.)chatgpt\.com$|(^|\.)openai\.com$/.test(host)) return 'ChatGPT';
  return clip(c && c.name, 60) || host || 'An app';
}

// Checks the request to sign in; returns the app.
async function checkAuthorize(q) {
  const c = await client(q.client_id);
  if (!c) throw err('This app isn’t registered with Eagle I. Remove it and add it again.', 400, 'invalid_client');
  if (!q.redirect_uri || !c.redirect_uris.includes(q.redirect_uri)) throw err('That return address isn’t one this app registered.', 400, 'invalid_redirect_uri');
  if (q.response_type !== 'code') throw err('Only response_type=code is supported.', 400, 'unsupported_response_type');
  if (!q.code_challenge || q.code_challenge_method !== 'S256') throw err('PKCE (S256) is required.');
  return c;
}

async function issueCode({ clientId, user, redirectUri, challenge }) {
  const code = random(32);
  await query(`INSERT INTO crm_oauth_codes (code_hash, client_id, user_id, tenant_id, redirect_uri, challenge, expires_at) VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' seconds')::interval)`,
    [hash(code), clientId, user.id, user.tenant_id, redirectUri, challenge, String(CODE_TTL)]);
  return code;
}

async function tokensFor({ clientId, userId, tenantId }) {
  const access = 'eia_' + random(32), refresh = 'eir_' + random(32);
  await query(`INSERT INTO crm_oauth_tokens (kind, token_hash, client_id, user_id, tenant_id, expires_at) VALUES
    ('access', $1, $3, $4, $5, now() + ($6 || ' seconds')::interval), ('refresh', $2, $3, $4, $5, now() + ($7 || ' days')::interval)`,
    [hash(access), hash(refresh), clientId, userId, tenantId, String(ACCESS_TTL), String(REFRESH_DAYS)]);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: 'eagle-i' };
}

async function authClient(c, secret) {
  if (!c.secret_hash) return true;
  const a = Buffer.from(hash(secret || '')), b = Buffer.from(c.secret_hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function token(body = {}, basic = null) {
  const clientId = (basic && basic.id) || body.client_id;
  const c = await client(clientId);
  if (!c || !(await authClient(c, (basic && basic.secret) || body.client_secret))) throw err('Unknown app.', 401, 'invalid_client');
  if (body.grant_type === 'authorization_code') {
    const row = (await query(`UPDATE crm_oauth_codes SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL RETURNING *`, [hash(body.code || '')])).rows[0];
    if (!row || row.client_id !== c.id || new Date(row.expires_at) < new Date()) throw err('That sign-in has expired. Try connecting again.', 400, 'invalid_grant');
    if (row.redirect_uri !== body.redirect_uri) throw err('The return address doesn’t match.', 400, 'invalid_grant');
    const check = crypto.createHash('sha256').update(String(body.code_verifier || '')).digest('base64url');
    if (check !== row.challenge) throw err('The sign-in check (PKCE) failed.', 400, 'invalid_grant');
    return tokensFor({ clientId: c.id, userId: row.user_id, tenantId: row.tenant_id });
  }
  if (body.grant_type === 'refresh_token') {
    // Each refresh token works once: it's swapped for a new pair.
    const row = (await query(`UPDATE crm_oauth_tokens SET revoked_at = now() WHERE token_hash = $1 AND kind = 'refresh' AND revoked_at IS NULL AND expires_at > now() RETURNING *`, [hash(body.refresh_token || '')])).rows[0];
    if (!row || row.client_id !== c.id) throw err('Please connect again.', 400, 'invalid_grant');
    const u = (await query(`SELECT disabled_at FROM users WHERE id = $1`, [row.user_id])).rows[0];
    if (!u || u.disabled_at) throw err('This account has been turned off.', 400, 'invalid_grant');
    return tokensFor({ clientId: c.id, userId: row.user_id, tenantId: row.tenant_id });
  }
  throw err('Only authorization_code and refresh_token are supported.', 400, 'unsupported_grant_type');
}

// The person behind a request's access token, or null.
async function whoFor(bearer) {
  if (!/^eia_[\w-]{20,80}$/.test(String(bearer || ''))) return null;
  const row = (await query(
    `UPDATE crm_oauth_tokens t SET last_used_at = now() WHERE t.token_hash = $1 AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > now()
     RETURNING t.user_id, t.tenant_id, t.client_id`, [hash(bearer)])).rows[0];
  if (!row) return null;
  const user = await require('./crmTeam').getUser(row.user_id);
  if (!user || user.disabled_at || user.tenant_id !== row.tenant_id || user.app === 'marketing') return null;
  const c = await client(row.client_id);
  return { user, clientId: row.client_id, app: appName(c, c && c.redirect_uris[0]) };
}

// Account → Claude & ChatGPT: the apps this person has connected.
async function connected(userId) {
  const rows = (await query(
    `SELECT c.id, c.name, c.redirect_uris, MIN(t.created_at) AS since, MAX(t.last_used_at) AS used FROM crm_oauth_tokens t JOIN crm_oauth_clients c ON c.id = t.client_id
     WHERE t.user_id = $1 AND t.revoked_at IS NULL AND t.expires_at > now() GROUP BY c.id ORDER BY MAX(t.created_at) DESC`, [userId])).rows;
  return rows.map(r => ({ id: r.id, app: appName(r, r.redirect_uris[0]), since: r.since, lastUsed: r.used }));
}
async function disconnect(userId, clientId) {
  const r = await query(`UPDATE crm_oauth_tokens SET revoked_at = now() WHERE user_id = $1 AND client_id = $2 AND revoked_at IS NULL`, [userId, clientId]);
  return { ok: true, revoked: r.rowCount };
}

module.exports = { ACCESS_TTL, okRedirect, register, client, appName, checkAuthorize, issueCode, token, whoFor, connected, disconnect, hash };
