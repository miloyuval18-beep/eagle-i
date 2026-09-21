// The one path every vendor outreach email goes through — the single
// "Find & Send" button and the bulk send both — so the same rules apply to
// both: opted-out addresses are never emailed, every message carries the
// sender's physical address and a working unsubscribe link (what CAN-SPAM
// requires of commercial email; cold B2B email is legal under it, but only
// with these), and each send is recorded in vendor_outreach so replies can
// be matched back to it.
const crypto = require('crypto');
const { query } = require('../db');
const { sendEmail, buildReplyToAddress } = require('./email');
const { domainAcceptsMail } = require('./emailVerification');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BULK_DAILY_CAP = Math.max(1, parseInt(process.env.VENDOR_BULK_DAILY_CAP, 10) || 100);
// Resend's default limit is 2 requests/second per account.
const SEND_SPACING_MS = 600;

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normEmail = (e) => String(e || '').trim().toLowerCase();

function unsubscribeSig(tenantId, email) {
  const secret = process.env.SESSION_SECRET || 'insecure-dev-secret';
  return crypto.createHmac('sha256', secret).update(`unsub|${tenantId}|${normEmail(email)}`).digest('hex').slice(0, 32);
}
function verifyUnsubscribeSig(tenantId, email, sig) {
  const expected = Buffer.from(unsubscribeSig(tenantId, email));
  const given = Buffer.from(String(sig || ''));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
function buildUnsubscribeUrl(baseUrl, tenantId, email) {
  const q = new URLSearchParams({ t: tenantId, e: normEmail(email), s: unsubscribeSig(tenantId, email) });
  return `${baseUrl}/unsubscribe?${q.toString()}`;
}

async function getSenderContext(tenantId) {
  const tenantRes = await query('SELECT company_name FROM tenants WHERE id = $1', [tenantId]);
  if (!tenantRes.rows.length) return null;
  const profileRes = await query('SELECT founder_name, phone, email, address FROM business_profile WHERE tenant_id = $1', [tenantId]);
  return { companyName: tenantRes.rows[0].company_name, profile: profileRes.rows[0] || {} };
}

// Message text arrives already HTML-escaped; make web links clickable. A line
// that is just a domain ("levihomes.com") becomes a link too.
function linkifyLine(escapedLine) {
  const bareDomain = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/\S*)?)$/i.exec(escapedLine.trim());
  if (bareDomain) return `<a href="https://${bareDomain[1]}" style="color:#12203a">${bareDomain[1]}</a>`;
  return escapedLine.replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" style="color:#12203a">${u}</a>`);
}

function composeEmail({ message, companyName, profile, unsubscribeUrl }) {
  const signatureLine = [profile.founder_name || companyName, profile.phone, profile.email].filter(Boolean).map(escapeHtml).join(' · ');
  const address = (profile.address || '').trim();
  const footerText = `${companyName}${address ? ' · ' + address : ''}\nIf you'd rather not receive emails like this, unsubscribe: ${unsubscribeUrl}`;
  // Blank line = new paragraph; a single newline stays a line break, so
  // "LinkedIn: ..." and the website line below it read as one block.
  const body = String(message).trim().split(/\n{2,}/)
    .map(par => `<p style="margin:0 0 14px">${par.split('\n').map(l => linkifyLine(escapeHtml(l))).join('<br>')}</p>`)
    .join('\n');
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#12203a;line-height:1.5">
${body}
<p style="color:#5a7290;font-size:13px;margin:18px 0 0">${signatureLine}</p>
<p style="color:#8a9bb0;font-size:11px;border-top:1px solid #e3e9f0;padding-top:10px;margin-top:22px">${escapeHtml(companyName)}${address ? ' · ' + escapeHtml(address) : ''}<br>If you'd rather not receive emails like this, <a href="${escapeHtml(unsubscribeUrl)}" style="color:#8a9bb0">unsubscribe</a>.</p>
</div>`;
  return { html, text: `${message}\n\n--\n${footerText}` };
}

// Sorts recipients into sendable vs skipped, with a reason for each skip —
// used both to preview a bulk send and (again, never trusting the preview)
// right before actually sending.
async function screenRecipients(tenantId, recipients) {
  const seen = new Set();
  const candidates = [];
  const skipped = [];
  for (const r of recipients || []) {
    const email = normEmail(r && r.email);
    const name = (r && r.name) || email;
    if (!EMAIL_RE.test(email)) { skipped.push({ email, name, reason: 'invalid_email' }); continue; }
    if (seen.has(email)) { skipped.push({ email, name, reason: 'duplicate_in_batch' }); continue; }
    seen.add(email);
    candidates.push({ email, name });
  }
  if (!candidates.length) return { sendable: [], skipped };

  const emails = candidates.map(c => c.email);
  const [supp, sent] = await Promise.all([
    query('SELECT LOWER(email) AS e, reason FROM outreach_suppressions WHERE tenant_id = $1 AND LOWER(email) = ANY($2)', [tenantId, emails]),
    query("SELECT DISTINCT LOWER(to_email) AS e FROM vendor_outreach WHERE tenant_id = $1 AND status = 'sent' AND LOWER(to_email) = ANY($2)", [tenantId, emails])
  ]);
  const suppressed = new Map(supp.rows.map(x => [x.e, x.reason]));
  const already = new Set(sent.rows.map(x => x.e));
  const stillOk = [];
  for (const c of candidates) {
    if (suppressed.has(c.email)) skipped.push({ ...c, reason: suppressed.get(c.email) === 'unsubscribed' ? 'opted_out' : suppressed.get(c.email) });
    else if (already.has(c.email)) skipped.push({ ...c, reason: 'already_emailed' });
    else stillOk.push(c);
  }
  // Only a domain that definitively cannot receive mail is refused; a DNS
  // hiccup (null) never blocks a send.
  const domains = [...new Set(stillOk.map(c => c.email.split('@')[1]))];
  const dead = new Set();
  await Promise.all(Array.from({ length: Math.min(10, domains.length) }, async () => {
    while (domains.length) { const d = domains.pop(); if ((await domainAcceptsMail(d)) === false) dead.add(d); }
  }));
  const sendable = [];
  for (const c of stillOk) {
    if (dead.has(c.email.split('@')[1])) skipped.push({ ...c, reason: 'domain_cannot_receive_mail' });
    else sendable.push(c);
  }
  return { sendable, skipped };
}

async function sentInLast24h(tenantId) {
  const r = await query("SELECT COUNT(*)::int AS n FROM vendor_outreach WHERE tenant_id = $1 AND status = 'sent' AND created_at > now() - interval '24 hours'", [tenantId]);
  return r.rows[0].n;
}

// Sends one message and records it. Throws only for conditions the caller
// should surface (opted out); a Resend failure is recorded as status
// 'failed' and returned, not thrown, so a bulk loop can carry on.
async function sendOutreach({ tenantId, ctx, baseUrl, toEmail, vendorName, message, subject }) {
  const email = toEmail.trim();
  const optedOut = await query('SELECT 1 FROM outreach_suppressions WHERE tenant_id = $1 AND LOWER(email) = LOWER($2)', [tenantId, email]);
  if (optedOut.rows.length) return { ok: false, reason: 'opted_out' }; // opted out, bounced or complained — all refused

  if ((await domainAcceptsMail(email.split('@')[1])) === false) return { ok: false, reason: 'domain_cannot_receive_mail' };

  const outreachId = crypto.randomUUID();
  const unsubscribeUrl = buildUnsubscribeUrl(baseUrl, tenantId, email);
  const { html, text } = composeEmail({ message, companyName: ctx.companyName, profile: ctx.profile, unsubscribeUrl });
  const validProfileEmail = ctx.profile.email && EMAIL_RE.test(ctx.profile.email) ? ctx.profile.email : undefined;
  const replyTo = buildReplyToAddress('vendor', outreachId) || validProfileEmail;

  let sent, sendError;
  try {
    sent = await sendEmail({
      to: email, subject: subject || `Quick note from ${ctx.companyName}`, html, text, replyTo, fromName: ctx.companyName,
      headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
    });
  } catch (err) {
    sendError = err;
  }
  await query(
    `INSERT INTO vendor_outreach (id, tenant_id, vendor_name, to_email, message, status, error, resend_email_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [outreachId, tenantId, vendorName || email, email, message,
     sendError ? 'failed' : 'sent', sendError ? sendError.message : null, sent && sent.id ? sent.id : null]
  );
  if (sendError) return { ok: false, reason: 'send_failed', error: sendError.message, outreachId };
  return { ok: true, id: sent && sent.id ? sent.id : null, outreachId };
}

module.exports = {
  EMAIL_RE, BULK_DAILY_CAP, SEND_SPACING_MS,
  normEmail, unsubscribeSig, verifyUnsubscribeSig, buildUnsubscribeUrl,
  getSenderContext, composeEmail, screenRecipients, sentInLast24h, sendOutreach
};
