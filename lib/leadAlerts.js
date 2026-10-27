// Emails the business owner the moment a landing-page lead comes in, so a
// phone number sitting in the Leads inbox isn't found hours later.
//
// Everything in a lead comes from an anonymous public form, so it is treated
// as untrusted: every field is HTML-escaped, the subject is stripped of
// control characters (no header injection), phone/email only become links when
// they are well-formed, and a flood of submissions (a bot getting past the
// form's own limits) can't turn into a flood of email — at most
// MAX_PER_HOUR alerts per business per hour.
const { query } = require('../db');
const { sendEmail } = require('./email');

const MAX_PER_HOUR = 20;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const oneLine = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

async function sendLeadAlert({ tenantId, lead, baseUrl, send = sendEmail }) {
  const r = await query(
    `SELECT t.company_name, bp.email AS profile_email, bp.lead_alerts_enabled,
            (SELECT u.email FROM users u WHERE u.tenant_id = t.id ORDER BY u.created_at ASC LIMIT 1) AS account_email
     FROM tenants t LEFT JOIN business_profile bp ON bp.tenant_id = t.id WHERE t.id = $1`,
    [tenantId]
  );
  const row = r.rows[0];
  if (!row || row.lead_alerts_enabled === false) return { sent: false, reason: 'disabled' };
  const to = [row.profile_email, row.account_email].find(e => e && EMAIL_RE.test(e.trim()));
  if (!to) return { sent: false, reason: 'no_recipient' };

  const recent = await query("SELECT COUNT(*)::int AS n FROM leads WHERE tenant_id = $1 AND created_at > now() - interval '1 hour'", [tenantId]);
  if (recent.rows[0].n > MAX_PER_HOUR) return { sent: false, reason: 'rate_limited' };

  const name = oneLine(lead.name, 80) || 'Someone';
  const phone = oneLine(lead.phone, 40);
  const email = oneLine(lead.email, 120);
  const message = String(lead.message || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, 1500);
  const phoneDigits = phone.replace(/[^0-9+]/g, '');
  const validEmail = EMAIL_RE.test(email);
  const inbox = `${baseUrl || ''}/marketing`;

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;color:#12203a;line-height:1.5">
<p style="font-size:16px;margin:0 0 4px"><b>New lead for ${esc(row.company_name)}</b></p>
<p style="margin:0 0 14px;color:#5a7290">Someone just filled out the form on your landing page.</p>
<table style="border-collapse:collapse;font-size:14px">
<tr><td style="padding:3px 14px 3px 0;color:#5a7290">Name</td><td><b>${esc(name)}</b></td></tr>
${phone ? `<tr><td style="padding:3px 14px 3px 0;color:#5a7290">Phone</td><td>${phoneDigits ? `<a href="tel:${esc(phoneDigits)}" style="color:#12203a">${esc(phone)}</a>` : esc(phone)}</td></tr>` : ''}
${email ? `<tr><td style="padding:3px 14px 3px 0;color:#5a7290">Email</td><td>${validEmail ? `<a href="mailto:${esc(email)}" style="color:#12203a">${esc(email)}</a>` : esc(email)}</td></tr>` : ''}
</table>
${message ? `<p style="margin:14px 0 4px;color:#5a7290">Message</p><p style="margin:0;white-space:pre-wrap">${esc(message)}</p>` : ''}
<p style="margin:18px 0 0">The sooner you call, the better the odds. <a href="${esc(inbox)}" style="color:#12203a">Open your Leads inbox</a>.</p>
<p style="color:#8a9bb0;font-size:11px;margin-top:20px">You can turn these alerts off in Account Settings, under Company Profile.</p>
</div>`;
  const text = `New lead for ${row.company_name}\n\nName: ${name}${phone ? `\nPhone: ${phone}` : ''}${email ? `\nEmail: ${email}` : ''}${message ? `\n\nMessage:\n${message}` : ''}\n\nOpen your Leads inbox: ${inbox}\n(Turn these alerts off in Account Settings.)`;

  // Replying to the alert reaches the lead directly, when they gave a real address.
  await send({ to: to.trim(), subject: `New lead: ${name}`, html, text, replyTo: validEmail ? email : undefined, fromName: 'Eagle I' });
  return { sent: true };
}

module.exports = { sendLeadAlert, MAX_PER_HOUR };
