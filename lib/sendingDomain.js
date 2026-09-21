// Per-company sending domains, through Resend's Domains API.
//
// Flow: the company enters a domain it owns -> Resend returns the DNS records
// -> the company adds them where the domain is hosted -> "Check now" asks
// Resend to verify -> once verified, mail goes out from <local>@<domain>.
// Until then (and if verification is ever lost) sending falls back to the
// shared address, so nothing breaks while DNS propagates.
//
// The Resend API key must be a full-access key, not "sending access" only,
// to create domains; the API's own error is shown if it isn't.
const { query } = require('../db');

const API = 'https://api.resend.com';
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const LOCAL_RE = /^[a-z0-9][a-z0-9._-]{0,38}[a-z0-9]$|^[a-z0-9]$/;
// Shared providers and this app's own sending domain can never be claimed.
const BLOCKED = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'aol.com', 'msn.com', 'proton.me', 'protonmail.com', 'resend.dev', 'resend.app', 'onrender.com']);

// Injectable for tests.
const http = { fetch: (...a) => fetch(...a) };

function fail(message, status) { const e = new Error(message); e.status = status; return e; }

function normalizeDomain(input) {
  let d = String(input || '').trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');
  return d;
}

function validateDomain(d) {
  if (!DOMAIN_RE.test(d)) return 'Enter a domain like yourcompany.com (no http://, no email address).';
  if (BLOCKED.has(d) || [...BLOCKED].some(b => d.endsWith('.' + b))) return `${d} is a shared domain. Use a domain your company owns.`;
  const inbound = process.env.RESEND_INBOUND_DOMAIN;
  if (inbound && (d === inbound.toLowerCase() || d.endsWith('.' + inbound.toLowerCase()))) return 'That is the domain Eagle I receives replies on. Use your own company domain.';
  return null;
}

async function resend(method, path, body) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw fail('Email sending is not configured on this server (missing RESEND_API_KEY).', 503);
  const r = await http.fetch(`${API}${path}`, {
    method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await r.json(); } catch (_) { /* empty body */ }
  if (!r.ok) throw fail((data && (data.message || data.error)) || `Resend request failed (${r.status})`, 502);
  return data || {};
}

const cleanRecords = (records) => (Array.isArray(records) ? records : []).map(r => ({
  record: r.record || null, type: r.type || null, name: r.name || null, value: r.value || null,
  priority: r.priority == null ? null : r.priority, ttl: r.ttl || null, status: r.status || null
}));

async function getRow(tenantId) {
  return (await query('SELECT * FROM sending_domains WHERE tenant_id = $1', [tenantId])).rows[0] || null;
}

function present(row) {
  if (!row) return null;
  return {
    domain: row.domain, status: row.status, records: row.records || [], fromLocal: row.from_local,
    fromAddress: `${row.from_local}@${row.domain}`, verified: row.status === 'verified',
    verifiedAt: row.verified_at, lastCheckedAt: row.last_checked_at
  };
}

async function getStatus(tenantId) { return present(await getRow(tenantId)); }

// The address mail should go out from — only once Resend has verified the domain.
async function getVerifiedFromAddress(tenantId) {
  try {
    const row = await getRow(tenantId);
    return row && row.status === 'verified' ? `${row.from_local}@${row.domain}` : null;
  } catch (err) {
    return null; // sending must never fail because of this lookup
  }
}

async function addDomain(tenantId, rawDomain, rawLocal) {
  const domain = normalizeDomain(rawDomain);
  const bad = validateDomain(domain);
  if (bad) throw fail(bad, 400);
  const local = String(rawLocal || 'hello').trim().toLowerCase();
  if (!LOCAL_RE.test(local)) throw fail('The name before the @ can use letters, numbers, dots, dashes and underscores.', 400);
  if (await getRow(tenantId)) throw fail('This company already has a sending domain. Remove it first to use a different one.', 409);
  const taken = (await query('SELECT 1 FROM sending_domains WHERE domain = $1', [domain])).rows[0];
  if (taken) throw fail('That domain is already connected to another company.', 409);

  const created = await resend('POST', '/domains', { name: domain });
  await query(
    `INSERT INTO sending_domains (tenant_id, domain, resend_domain_id, status, records, from_local)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, domain, created.id, created.status || 'not_started', JSON.stringify(cleanRecords(created.records)), local]);
  return getStatus(tenantId);
}

// Asks Resend to check the DNS records, then reads back the result.
async function refresh(tenantId, { requestVerify = true } = {}) {
  const row = await getRow(tenantId);
  if (!row) throw fail('No sending domain is set up.', 404);
  if (requestVerify && row.status !== 'verified') await resend('POST', `/domains/${encodeURIComponent(row.resend_domain_id)}/verify`);
  const d = await resend('GET', `/domains/${encodeURIComponent(row.resend_domain_id)}`);
  const status = d.status || row.status;
  await query(
    `UPDATE sending_domains SET status = $2::varchar, records = $3, last_checked_at = now(),
            verified_at = CASE WHEN $2::text = 'verified' AND verified_at IS NULL THEN now() ELSE verified_at END
     WHERE tenant_id = $1`,
    [tenantId, status, JSON.stringify(d.records ? cleanRecords(d.records) : row.records)]);
  return getStatus(tenantId);
}

async function setFromLocal(tenantId, rawLocal) {
  const local = String(rawLocal || '').trim().toLowerCase();
  if (!LOCAL_RE.test(local)) throw fail('The name before the @ can use letters, numbers, dots, dashes and underscores.', 400);
  const r = await query('UPDATE sending_domains SET from_local = $2 WHERE tenant_id = $1 RETURNING tenant_id', [tenantId, local]);
  if (!r.rows.length) throw fail('No sending domain is set up.', 404);
  return getStatus(tenantId);
}

async function removeDomain(tenantId) {
  const row = await getRow(tenantId);
  if (!row) return { removed: false };
  try { await resend('DELETE', `/domains/${encodeURIComponent(row.resend_domain_id)}`); }
  catch (err) { console.error('[sendingDomain] Resend delete failed (removing locally anyway):', err.message); }
  await query('DELETE FROM sending_domains WHERE tenant_id = $1', [tenantId]);
  return { removed: true };
}

// Background: re-check domains still waiting on DNS, at most every 30 minutes each.
async function refreshPending() {
  const due = (await query(
    `SELECT tenant_id FROM sending_domains
     WHERE status <> 'verified' AND (last_checked_at IS NULL OR last_checked_at < now() - interval '30 minutes')
       AND created_at > now() - interval '14 days' LIMIT 20`)).rows;
  let verified = 0;
  for (const d of due) {
    try { const s = await refresh(d.tenant_id, { requestVerify: true }); if (s.verified) verified++; }
    catch (err) { await query('UPDATE sending_domains SET last_checked_at = now() WHERE tenant_id = $1', [d.tenant_id]); }
  }
  return { checked: due.length, verified };
}

module.exports = { http, normalizeDomain, validateDomain, getStatus, getVerifiedFromAddress, addDomain, refresh, setFromLocal, removeDomain, refreshPending };
