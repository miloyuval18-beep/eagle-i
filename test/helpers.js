// Shared test harness: spins up the real server as a child process against
// the real DB (there's no separate test DB — see README note added by this
// change), gives tests a cookie-carrying fetch, and guarantees any tenant a
// test creates gets deleted afterward regardless of pass/fail.
//
// External-service env vars (ANTHROPIC_API_KEY, GOOGLE_PLACES_API_KEY,
// RESEND_API_KEY, STRIPE_SECRET_KEY) are intentionally left unset locally —
// that makes the "service not configured" fallback paths exercisable
// safely and for free. Those same routes behave differently once real keys
// are present in production; this suite only asserts the safe-fallback
// shape, not live third-party behavior.
const { spawn } = require('child_process');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.TEST_PORT || 3999;
const BASE_URL = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');

// Deliberately SET (unlike the real external keys above) so tests can sign
// real payloads with the real svix library and exercise real signature
// verification in routes/inboundEmail.js — a fixed, fake-but-well-formed
// secret, never a real Resend value.
const TEST_WEBHOOK_SECRET = 'whsec_dGVzdG9ubHlzZWNyZXRuZXZlcnJlYWw=';

function loadDotEnvValue(key) {
  const fs = require('fs');
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const line = text.split('\n').find(l => l.startsWith(key + '='));
    return line ? line.slice(key.length + 1).trim() : undefined;
  } catch {
    return undefined;
  }
}

// db.js (required by lib/usage.js, lib/anthropic.js, etc.) reads
// process.env.DATABASE_URL at require-time — populate it in *this* process
// too (not just the spawned server's), since integration tests import those
// modules directly. Must run before anything else in this file is required.
if (!process.env.DATABASE_URL) {
  const fromDotEnv = loadDotEnvValue('DATABASE_URL');
  if (fromDotEnv) process.env.DATABASE_URL = fromDotEnv;
}

let serverProcess = null;

async function startServer() {
  const databaseUrl = process.env.DATABASE_URL || loadDotEnvValue('DATABASE_URL');
  const sessionSecret = process.env.SESSION_SECRET || loadDotEnvValue('SESSION_SECRET') || 'test-secret';
  if (!databaseUrl) {
    throw new Error('DATABASE_URL not found in env or .env — tests need a real Postgres to run against.');
  }

  serverProcess = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: databaseUrl,
      SESSION_SECRET: sessionSecret,
      // Deliberately unset: ANTHROPIC_API_KEY, GOOGLE_PLACES_API_KEY,
      // RESEND_API_KEY, STRIPE_SECRET_KEY, SOCIAL_CREDENTIALS_KEY
      ANTHROPIC_API_KEY: '',
      GOOGLE_PLACES_API_KEY: '',
      RESEND_API_KEY: '',
      STRIPE_SECRET_KEY: '',
      SOCIAL_CREDENTIALS_KEY: '',
      // Set (see TEST_WEBHOOK_SECRET above) so the inbound-email webhook's
      // signature verification is actually exercisable in tests, even
      // though RESEND_API_KEY staying unset still caps how far a "valid"
      // webhook call can be processed (same not-configured-boundary as
      // every other external-key-gated route in this suite).
      RESEND_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
      // Tests sign up and sign in many times from one address.
      CRM_RATE_LIMITS: 'off'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderrBuf = '';
  serverProcess.stderr.on('data', (d) => { stderrBuf += d.toString(); });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE_URL}/healthz`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('Server did not become healthy in time.\n' + stderrBuf);
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}

// Tiny cookie-jar fetch wrapper — enough for one session at a time, which is
// all these tests need per client.
function makeClient() {
  let cookie = null;
  async function req(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (cookie) headers.Cookie = cookie;
    const r = await fetch(`${BASE_URL}${path}`, { ...opts, headers, redirect: 'manual' });
    const setCookie = r.headers.get('set-cookie');
    // The session cookie (a reply can set others too, like a trusted-device cookie).
    const sid = String(setCookie || '').match(/connect\.sid=[^;]+/);
    if (sid) cookie = sid[0];
    // Read the whole reply before handing it back, like a browser does. The
    // server only finishes saving a new session as the reply ends, so a test
    // that checked just the status and fired the next request at once could
    // arrive before the session existed (an occasional 401).
    const body = [101, 204, 205, 304].includes(r.status) ? null : await r.arrayBuffer();
    return new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
  }
  return {
    get: (path) => req(path, { method: 'GET' }),
    post: (path, body) => req(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined }),
    put: (path, body) => req(path, { method: 'PUT', body: body !== undefined ? JSON.stringify(body) : undefined }),
    patch: (path, body) => req(path, { method: 'PATCH', body: body !== undefined ? JSON.stringify(body) : undefined }),
    delete: (path) => req(path, { method: 'DELETE' }),
    raw: req
  };
}

// Every test tenant created MUST be registered here so it's cleaned up even
// if an assertion throws mid-test.
const tenantsToClean = new Set();
function trackTenant(tenantId) {
  if (tenantId) tenantsToClean.add(tenantId);
}

async function cleanupTenants() {
  if (!tenantsToClean.size) return;
  const databaseUrl = process.env.DATABASE_URL || loadDotEnvValue('DATABASE_URL');
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    for (const id of tenantsToClean) {
      await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
    }
  } finally {
    await pool.end();
  }
  tenantsToClean.clear();
}

function uniqueEmail(tag) {
  return `test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@eagle-i-test.com`;
}

// For tests that need to poke the DB directly (seed a row, force a cap) —
// caller is responsible for pool.end() when done.
function getTestPool() {
  const databaseUrl = process.env.DATABASE_URL || loadDotEnvValue('DATABASE_URL');
  return new Pool({ connectionString: databaseUrl });
}

module.exports = { BASE_URL, startServer, stopServer, makeClient, trackTenant, cleanupTenants, uniqueEmail, getTestPool, TEST_WEBHOOK_SECRET };
