// Errors real people hit, and an email about them. Every server error (a 500
// from any API route) and every error in someone's browser on the CRM is
// kept, grouped by what went wrong and where (numbers and ids taken out, so
// "deal 123 failed" and "deal 456 failed" are the same problem). The first
// time a problem shows up, and again if it's still happening 6 hours later,
// Eagle I emails ADMIN_ALERT_EMAIL with who hit it, where, and how often.
const crypto = require('crypto');
const { query } = require('../db');
const { sendEmail } = require('./email');

const ALERT_TO = () => process.env.ADMIN_ALERT_EMAIL || 'miloyuval18@gmail.com';
const QUIET_HOURS = 6;
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// The same problem, whatever the ids, numbers or quoted bits in it.
const shape = (s) => String(s || '').toLowerCase()
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ':id')
  .replace(/[0-9a-f]{24,}/g, ':tok').replace(/\d+/g, '#').replace(/"[^"]*"|'[^']*'|“[^”]*”/g, '"…"').slice(0, 300);
const fingerprint = (source, message, path) => crypto.createHash('sha256').update(`${source}|${shape(message)}|${shape(String(path || '').split('?')[0])}`).digest('hex');

async function record({ source = 'server', message, detail = null, path = null, tenantId = null, userId = null, send = sendEmail }) {
  try {
    const fp = fingerprint(source, message, path);
    await query(`INSERT INTO crm_errors (source, fingerprint, message, detail, path, tenant_id, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [source, fp, clip(message, 1000), detail ? clip(detail, 4000) : null, path ? clip(path, 300) : null, /^[0-9a-f-]{36}$/.test(String(tenantId || '')) ? tenantId : null, /^[0-9a-f-]{36}$/.test(String(userId || '')) ? userId : null]);
    // Told already in the last few hours? Then just counted.
    const recent = (await query(`SELECT COUNT(*)::int AS n FROM crm_errors WHERE fingerprint = $1 AND created_at > now() - ($2 || ' hours')::interval`, [fp, String(QUIET_HOURS)])).rows[0].n;
    if (recent > 1) return { alerted: false };
    const stats = (await query(`SELECT COUNT(*)::int AS n, COUNT(DISTINCT user_id)::int AS people, MIN(created_at) AS first FROM crm_errors WHERE fingerprint = $1 AND created_at > now() - interval '7 days'`, [fp])).rows[0];
    const who = userId ? (await query('SELECT u.email, u.name, u.role, t.company_name FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1', [userId]).catch(() => ({ rows: [] }))).rows[0] : null;
    const whoLine = who ? `${who.name || who.email} (${who.role}) at ${who.company_name}` : 'someone not signed in';
    if (!process.env.RESEND_API_KEY) { console.error(`[error alert, email not set up] ${source}: ${message} @ ${path} — ${whoLine}`); return { alerted: false }; }
    const again = stats.n > 1 ? `It has happened ${stats.n} times to ${stats.people || 1} ${stats.people === 1 ? 'person' : 'people'} since ${new Date(stats.first).toLocaleString('en-US', { timeZone: 'America/Chicago' })}.` : 'First time this has happened.';
    await send({ to: ALERT_TO(), subject: `⚠ Eagle I ${source === 'browser' ? 'screen' : 'server'} error: ${clip(message, 90)}`,
      text: `${message}\n\nWhere: ${path || '?'}\nWho: ${whoLine}\n${again}\n\n${detail || ''}`,
      html: `<p style="font-size:16px"><b>${esc(message)}</b></p><p style="font-size:14px">Where: ${esc(path || '?')}<br>Who: ${esc(whoLine)}<br>${esc(again)}</p>${detail ? `<pre style="white-space:pre-wrap;font-size:12px;color:#555">${esc(clip(detail, 3000))}</pre>` : ''}<p style="font-size:12px;color:#888">You’ll hear about this problem again if it’s still happening ${QUIET_HOURS} hours from now.</p>` });
    return { alerted: true };
  } catch (e) { console.error('[crmErrors] could not record:', e.message); return { alerted: false }; }
}

// Express: catches every 5xx answer from the API (the routes handle their own
// errors and reply 500 with a message; this notices those replies).
function middleware() {
  return (req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    let body = null;
    const json = res.json.bind(res);
    res.json = (b) => { if (res.statusCode >= 500) body = b; return json(b); };
    res.on('finish', () => {
      if (res.statusCode < 500 || res.statusCode === 503) return; // 503: a service not set up (no key), not a bug
      const msg = (body && body.error && body.error.message) || `HTTP ${res.statusCode}`;
      record({ source: 'server', message: msg, path: `${req.method} ${req.originalUrl}`, tenantId: req.session && req.session.tenantId, userId: req.session && req.session.userId }).catch(() => {});
    });
    next();
  };
}

module.exports = { shape, fingerprint, record, middleware, QUIET_HOURS };
