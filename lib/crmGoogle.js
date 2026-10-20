// Eagle I CRM reads the company's Google Workspace email, so every
// conversation with a customer lands on the right deal without anyone
// copying it in.
//
// How access works (Google "domain-wide delegation"): Eagle I has one Google
// service account (GOOGLE_SERVICE_ACCOUNT_JSON). The company's Workspace admin
// allows that account's client ID, for two read-only scopes, in their Admin
// console. Eagle I can then read every employee's mailbox and the employee
// list, with no per-person sign-in. The admin can revoke it there any time.
//
// What is kept, and what isn't:
//  - only emails to or from someone who is a contact in the CRM; everything
//    else (personal mail, vendors, newsletters) is looked at for its
//    addresses only and never stored;
//  - for those: sender, recipients, subject, date, and the text the person
//    wrote (the quoted history underneath is trimmed off) so the team and
//    the assistant can search what was said. Never attachments;
//  - one copy per email, even when several employees have it.
//
// What happens on its own:
//  - an email from a customer counts as a reply: that deal's sales follow-ups
//    stop (site-visit reminders still go);
//  - an email from an employee to a new lead counts as picking it up (the
//    "waiting" alert clears and response time is measured from it);
//  - either way it's activity, so the deal isn't flagged as stalled.
const crypto = require('crypto');
const { query } = require('../db');
const crm = require('./crm');

const SCOPES = {
  directory: 'https://www.googleapis.com/auth/admin.directory.user.readonly',
  gmail: 'https://www.googleapis.com/auth/gmail.readonly'
};
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SYNC_EVERY_MS = 10 * 60 * 1000;
const FIRST_SYNC_DAYS = 30;
const MAX_MESSAGES_PER_RUN = 200;
const MAILBOXES_PER_TICK = 25;

function err(message, status = 400) { const e = new Error(message); e.status = status; return e; }

// The service account, from GOOGLE_SERVICE_ACCOUNT_JSON (the key file's JSON, or base64 of it).
function serviceAccount(env = process.env) {
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const j = JSON.parse(text);
    if (!j.client_email || !j.private_key) return null;
    return { client_email: j.client_email, client_id: j.client_id || null, private_key: j.private_key, token_uri: j.token_uri || TOKEN_URI };
  } catch (e) {
    return null;
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// A signed request to act as `subject` (a person in the company's Workspace) for `scope`.
function buildAssertion(sa, subject, scope, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, sub: subject, scope, aud: sa.token_uri, iat, exp: iat + 3600 }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(sa.private_key))}`;
}

const tokenCache = new Map();
async function getToken({ subject, scope, http = fetch, sa = serviceAccount() }) {
  if (!sa) throw err('Google Workspace access is not set up on the server yet.', 503);
  const key = `${subject}|${scope}`;
  const hit = tokenCache.get(key);
  if (hit && hit.exp > Date.now() + 60000) return hit.token;
  const r = await http(sa.token_uri, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: buildAssertion(sa, subject, scope) }).toString()
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const code = body.error || `http_${r.status}`;
    if (code === 'unauthorized_client' || code === 'access_denied') {
      throw err('Google refused access. In your Google Admin console, check that Eagle I’s client ID is allowed for both scopes (Security → Access and data control → API controls → Domain-wide delegation).', 403);
    }
    if (code === 'invalid_grant') throw err(`Google doesn't recognise ${subject} as a user in this Workspace.`, 400);
    throw err(`Google sign-in failed (${code}).`, 502);
  }
  tokenCache.set(key, { token: body.access_token, exp: Date.now() + (body.expires_in || 3600) * 1000 });
  return body.access_token;
}

async function gget(url, token, http = fetch) {
  const r = await http(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw err((body.error && body.error.message) || `Google request failed (${r.status}).`, r.status === 404 ? 404 : 502);
  return body;
}

// Everyone with a mailbox in the Workspace (active accounts only).
async function listDomainUsers({ domain, adminEmail, http = fetch, sa }) {
  const token = await getToken({ subject: adminEmail, scope: SCOPES.directory, http, sa });
  const users = [];
  let pageToken = '';
  for (let page = 0; page < 10; page++) {
    const u = new URL('https://admin.googleapis.com/admin/directory/v1/users');
    u.searchParams.set('domain', domain);
    u.searchParams.set('maxResults', '200');
    u.searchParams.set('orderBy', 'email');
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const body = await gget(u.toString(), token, http);
    for (const x of body.users || []) {
      if (x.suspended || x.archived || !x.primaryEmail) continue;
      users.push({ email: String(x.primaryEmail).toLowerCase(), name: (x.name && x.name.fullName) || null });
    }
    pageToken = body.nextPageToken;
    if (!pageToken) break;
  }
  return users;
}

// ---------- pure helpers ----------

function addresses(header) {
  return [...String(header || '').matchAll(/[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map(m => m[0].toLowerCase());
}

function readHeaders(msg) {
  const h = {};
  for (const x of (msg.payload && msg.payload.headers) || []) h[String(x.name).toLowerCase()] = x.value;
  const from = addresses(h.from)[0] || null;
  return {
    from, to: [...new Set([...addresses(h.to), ...addresses(h.cc)])], subject: h.subject || '',
    messageKey: (h['message-id'] || '').trim() || `gmail:${msg.id}`,
    sentAt: new Date(Number(msg.internalDate) || Date.parse(h.date) || Date.now())
  };
}

// Which side of the conversation the company is on.
function directionFor({ from, mailbox, domain }) {
  if (!from) return 'in';
  return from === mailbox || from.endsWith('@' + domain) ? 'out' : 'in';
}

// ---------- connecting ----------

async function getStatus(tenantId) {
  const sa = serviceAccount();
  const conn = (await query('SELECT domain, admin_email, status, last_error, connected_at, last_synced_at FROM crm_google_connections WHERE tenant_id = $1', [tenantId])).rows[0] || null;
  const mailboxes = conn ? (await query(
    `SELECT m.id, m.email, m.name, m.included, m.last_synced_at, m.status, m.last_error,
            (SELECT COUNT(*)::int FROM crm_emails e WHERE e.tenant_id = m.tenant_id AND e.mailbox_email = m.email) AS logged
     FROM crm_mailboxes m WHERE m.tenant_id = $1 ORDER BY m.email`, [tenantId])).rows : [];
  return {
    configured: !!sa, clientId: sa ? sa.client_id : null, scopes: [SCOPES.directory, SCOPES.gmail],
    connection: conn, mailboxes
  };
}

async function connect({ tenantId, domain, adminEmail, userId = null, http = fetch, sa = serviceAccount() }) {
  if (!sa) throw err('Google Workspace access is not set up on the server yet.', 503);
  const d = String(domain || '').trim().toLowerCase().replace(/^@/, '');
  const admin = String(adminEmail || '').trim().toLowerCase();
  if (!DOMAIN_RE.test(d)) throw err('Enter your company’s email domain, like levihomes.com.');
  if (!EMAIL_RE.test(admin) || !admin.endsWith('@' + d)) throw err(`Enter a Google admin’s email address at ${d}.`);
  // Proves access works before anything is saved.
  const users = await listDomainUsers({ domain: d, adminEmail: admin, http, sa });
  await getToken({ subject: admin, scope: SCOPES.gmail, http, sa });
  await query(
    `INSERT INTO crm_google_connections (tenant_id, domain, admin_email, status, connected_by) VALUES ($1, $2, $3, 'connected', $4)
     ON CONFLICT (tenant_id) DO UPDATE SET domain = $2, admin_email = $3, status = 'connected', last_error = NULL, connected_by = $4, connected_at = now()`,
    [tenantId, d, admin, userId]);
  for (const u of users) {
    await query(
      `INSERT INTO crm_mailboxes (tenant_id, email, name) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, lower(email)) DO UPDATE SET name = EXCLUDED.name`, [tenantId, u.email, u.name]);
  }
  return { mailboxes: users.length };
}

async function setIncluded({ tenantId, id, included }) {
  return (await query('UPDATE crm_mailboxes SET included = $3 WHERE id = $1 AND tenant_id = $2 RETURNING id', [id, tenantId, !!included])).rowCount > 0;
}

// Stops reading. Emails already logged on deals stay there.
async function disconnect(tenantId) {
  await query('DELETE FROM crm_mailboxes WHERE tenant_id = $1', [tenantId]);
  await query('DELETE FROM crm_google_connections WHERE tenant_id = $1', [tenantId]);
}

// ---------- reading mail ----------

async function contactsByEmail(tenantId, emails) {
  if (!emails.length) return new Map();
  const rows = (await query(
    `SELECT id, LOWER(email) AS email, name FROM crm_contacts WHERE tenant_id = $1 AND LOWER(email) = ANY($2::text[])`, [tenantId, emails])).rows;
  return new Map(rows.map(r => [r.email, r]));
}

// The deal an email about this person belongs to: their most recent open deal, else their most recent one.
async function dealFor(tenantId, contactId) {
  return (await query(
    `SELECT * FROM crm_deals WHERE tenant_id = $1 AND contact_id = $2
     ORDER BY (stage IN ('complete', 'lost')), updated_at DESC LIMIT 1`, [tenantId, contactId])).rows[0] || null;
}

async function recordEmail({ tenantId, domain, mailbox, msg }) {
  const h = readHeaders(msg);
  const dir = directionFor({ from: h.from, mailbox: mailbox.email, domain });
  // The customer is whoever on the email isn't at the company.
  const outside = [...new Set([h.from, ...h.to].filter(e => e && !e.endsWith('@' + domain)))];
  const contacts = await contactsByEmail(tenantId, outside);
  if (!contacts.size) return null; // not about anyone in the CRM: nothing is kept
  const contact = dir === 'in' ? contacts.get(h.from) || [...contacts.values()][0] : [...contacts.values()][0];
  const deal = await dealFor(tenantId, contact.id);
  const sender = dir === 'out' ? (await query('SELECT id FROM users WHERE tenant_id = $1 AND LOWER(email) = $2', [tenantId, h.from])).rows[0] : null;
  const ins = await query(
    `INSERT INTO crm_emails (tenant_id, message_key, mailbox_email, direction, from_email, to_emails, subject, snippet, sent_at, contact_id, deal_id, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (tenant_id, message_key) DO NOTHING RETURNING id`,
    [tenantId, h.messageKey.slice(0, 500), mailbox.email, dir, h.from, h.to.slice(0, 50), String(h.subject).slice(0, 300),
     String(msg.snippet || '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').slice(0, 300), h.sentAt, contact.id, deal ? deal.id : null, sender ? sender.id : null]);
  if (!ins.rows.length || !deal) return ins.rows.length ? { stored: true, id: ins.rows[0].id } : null; // already logged from another mailbox
  const subj = h.subject ? `“${String(h.subject).slice(0, 120)}”` : '(no subject)';
  if (dir === 'in') {
    await crm.logActivity({ tenantId, dealId: deal.id, kind: 'reply', actor: 'contact', body: `Email to ${mailbox.email}: ${subj}`, meta: { gmail: true } });
    // They wrote in: the sales follow-ups have done their job.
    await require('./crmPlaybooks').cancelForDeal(deal.id, 'replied', { trigger: 'stage' });
  } else {
    await crm.logActivity({ tenantId, dealId: deal.id, kind: 'email', actor: 'owner', userId: sender ? sender.id : null, body: `Email from ${h.from}: ${subj}`, meta: { gmail: true } });
    // Writing to a new lead is picking it up.
    const upd = await query(
      `UPDATE crm_deals SET first_response_at = $2 WHERE id = $1 AND first_response_at IS NULL AND created_at <= $2 RETURNING id`, [deal.id, h.sentAt]);
    if (upd.rowCount) await crm.resolveInbox(tenantId, `waiting:${deal.id}`);
  }
  return { stored: true, id: ins.rows[0].id, dealId: deal.id, direction: dir };
}

// ---------- what the email said ----------

const fromB64url = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
function htmlToText(html) {
  return String(html || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}
// The text part of a Gmail message (plain text preferred), without the quoted history.
function bodyOf(msg) {
  let plain = null, html = null;
  const walk = (p) => {
    if (!p) return;
    if (p.mimeType === 'text/plain' && p.body && p.body.data && plain == null && !(p.filename)) plain = fromB64url(p.body.data);
    else if (p.mimeType === 'text/html' && p.body && p.body.data && html == null && !(p.filename)) html = fromB64url(p.body.data);
    for (const c of p.parts || []) walk(c);
  };
  walk(msg.payload);
  const text = plain != null ? plain : htmlToText(html);
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const l = line.trim();
    if (/^>/.test(l) || /^On .{4,200} wrote:$/.test(l) || /^-{2,}\s*(Original Message|Forwarded message)/i.test(l) || /^From:\s.+/.test(l) && out.length > 2) break;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 20000);
}
async function fetchBody({ tenantId, rowId, gmailId, token, http = fetch }) {
  const u = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(gmailId)}`);
  u.searchParams.set('format', 'full');
  const msg = await gget(u.toString(), token, http);
  await query('UPDATE crm_emails SET body_text = $3, gmail_id = $4, body_tried_at = now() WHERE id = $1 AND tenant_id = $2', [rowId, tenantId, bodyOf(msg) || null, gmailId]);
}

// Emails logged before their text was kept: fetch it, a few at a time, from the mailbox that has them.
async function backfillBodies({ http = fetch, sa = null, limit = 40 } = {}) {
  const account = sa || serviceAccount();
  if (!account) return { filled: 0 };
  const rows = (await query(
    `SELECT e.id, e.tenant_id, e.message_key, e.mailbox_email FROM crm_emails e JOIN crm_google_connections g ON g.tenant_id = e.tenant_id
     WHERE e.body_text IS NULL AND e.body_tried_at IS NULL ORDER BY e.sent_at DESC LIMIT $1`, [limit])).rows;
  let filled = 0;
  for (const r of rows) {
    await query('UPDATE crm_emails SET body_tried_at = now() WHERE id = $1', [r.id]);
    try {
      const token = await getToken({ subject: r.mailbox_email, scope: SCOPES.gmail, http, sa: account });
      const u = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
      u.searchParams.set('q', `rfc822msgid:${String(r.message_key).replace(/[<>]/g, '')}`);
      const found = await gget(u.toString(), token, http);
      const id = found.messages && found.messages[0] && found.messages[0].id;
      if (!id) continue;
      await fetchBody({ tenantId: r.tenant_id, rowId: r.id, gmailId: id, token, http });
      filled++;
    } catch (e) { console.error('[crmGoogle] backfill failed:', e.message); }
  }
  return { filled };
}

async function syncMailbox({ tenantId, domain, mailbox, http = fetch, sa, now = new Date() }) {
  const token = await getToken({ subject: mailbox.email, scope: SCOPES.gmail, http, sa });
  const sinceMs = mailbox.last_internal_date ? Number(mailbox.last_internal_date) : now.getTime() - FIRST_SYNC_DAYS * 86400000;
  const q = `after:${Math.floor(sinceMs / 1000)} -in:chats`;
  let pageToken = '';
  const ids = [];
  while (ids.length < MAX_MESSAGES_PER_RUN) {
    const u = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    u.searchParams.set('q', q);
    u.searchParams.set('maxResults', '100');
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const body = await gget(u.toString(), token, http);
    ids.push(...(body.messages || []).map(m => m.id));
    pageToken = body.nextPageToken;
    if (!pageToken) break;
  }
  let newest = Number(mailbox.last_internal_date) || 0;
  let stored = 0;
  for (const id of ids.slice(0, MAX_MESSAGES_PER_RUN)) {
    const u = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`);
    u.searchParams.set('format', 'metadata');
    for (const hname of ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID']) u.searchParams.append('metadataHeaders', hname);
    const msg = await gget(u.toString(), token, http);
    newest = Math.max(newest, Number(msg.internalDate) || 0);
    const r = await recordEmail({ tenantId, domain, mailbox, msg });
    if (r && r.stored) {
      stored++;
      // A customer email: keep what it said (one more read, for this email only).
      await fetchBody({ tenantId, rowId: r.id, gmailId: id, token, http }).catch(e => console.error('[crmGoogle] body failed:', e.message));
      // The homeowner wrote in: a reply is drafted and waiting on the deal (lib/crmCoach.js).
      if (r.direction === 'in' && r.dealId && process.env.ANTHROPIC_API_KEY) await require('./crmCoach').draftReply(tenantId, r.dealId, { emailId: r.id }).catch(e => console.error('[crmGoogle] reply draft failed:', e.message));
    }
  }
  await query(`UPDATE crm_mailboxes SET last_internal_date = $2, last_synced_at = now(), status = 'ok', last_error = NULL WHERE id = $1`, [mailbox.id, newest || sinceMs]);
  return { read: ids.length, stored };
}

// Background tick: reads the mailboxes that are due, a few at a time.
async function processGoogleSync({ http = fetch, sa = serviceAccount(), now = new Date(), onlyTenantId = null } = {}) {
  const summary = { mailboxes: 0, read: 0, stored: 0, errors: 0 };
  if (!sa) return summary;
  const due = (await query(
    `SELECT m.*, c.domain FROM crm_mailboxes m JOIN crm_google_connections c ON c.tenant_id = m.tenant_id
     JOIN tenants t ON t.id = m.tenant_id
     WHERE c.status = 'connected' AND m.included = true AND 'crm' = ANY(t.products)
       AND ($1::uuid IS NULL OR m.tenant_id = $1::uuid)
       AND (m.last_synced_at IS NULL OR m.last_synced_at < $2::timestamptz - ($3 || ' milliseconds')::interval OR $1::uuid IS NOT NULL)
     ORDER BY m.last_synced_at NULLS FIRST LIMIT $4`,
    [onlyTenantId, now, String(SYNC_EVERY_MS), onlyTenantId ? 500 : MAILBOXES_PER_TICK])).rows;
  for (const m of due) {
    summary.mailboxes++;
    try {
      const r = await syncMailbox({ tenantId: m.tenant_id, domain: m.domain, mailbox: m, http, sa, now });
      summary.read += r.read; summary.stored += r.stored;
    } catch (e) {
      summary.errors++;
      await query(`UPDATE crm_mailboxes SET status = 'error', last_error = $2, last_synced_at = now() WHERE id = $1`, [m.id, String(e.message).slice(0, 300)]);
      // Access taken away in Google: say so once on the connection, instead of failing quietly forever.
      if (e.status === 403) await query(`UPDATE crm_google_connections SET status = 'error', last_error = $2 WHERE tenant_id = $1`, [m.tenant_id, String(e.message).slice(0, 300)]);
    }
  }
  if (due.length) await query(`UPDATE crm_google_connections SET last_synced_at = now() WHERE tenant_id = ANY($1::uuid[])`, [[...new Set(due.map(m => m.tenant_id))]]);
  return summary;
}

module.exports = {
  SCOPES, serviceAccount, buildAssertion, getToken, listDomainUsers, addresses, readHeaders, directionFor,
  getStatus, connect, setIncluded, disconnect, recordEmail, syncMailbox, processGoogleSync, bodyOf, htmlToText, fetchBody, backfillBodies, _tokenCache: tokenCache
};
