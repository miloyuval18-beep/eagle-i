// One optional reminder for a review request that hasn't been answered.
//
// Honest about what it can and can't know: Eagle I can't see whether someone
// left a Google or Yelp review, only whether they replied to the email. So the
// reminder says outright "if you've already left a review, thank you — please
// ignore this", goes out once, in business hours, and carries an unsubscribe
// link (the same opt-out list as vendor outreach) so nobody is reminded twice
// against their wishes.
const { query } = require('../db');
const { sendEmail, buildReplyToAddress } = require('./email');
const { inSendWindow } = require('./followUps');
const { buildUnsubscribeUrl } = require('./vendorOutreach');

const REMINDER_DAYS = 7;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function buildReminder({ companyName, customerName, links, address, unsubscribeUrl }) {
  const buttons = links.map(l =>
    `<p style="margin:10px 0"><a href="${esc(l.url)}" style="display:inline-block;background:#12203a;color:#fff;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:600">Leave a ${esc(l.label)} review</a></p>`).join('');
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;color:#12203a;line-height:1.5">
<p>Hi ${esc(customerName)},</p>
<p>A quick reminder from ${esc(companyName)}: if you have a minute, a short review would mean a lot to us. If you have already left one, thank you so much, and please ignore this note.</p>
${buttons}
<p style="color:#5a7290;font-size:13px">Thank you,<br>${esc(companyName)}</p>
<p style="color:#8a9bb0;font-size:11px;border-top:1px solid #e3e9f0;padding-top:10px;margin-top:22px">${esc(companyName)}${address ? ' · ' + esc(address) : ''}<br>This is a one-time reminder. <a href="${esc(unsubscribeUrl)}" style="color:#8a9bb0">Unsubscribe</a> from emails like this.</p>
</div>`;
  const textLinks = links.map(l => `${l.label}: ${l.url}`).join('\n');
  const text = `Hi ${customerName},\n\nA quick reminder from ${companyName}: if you have a minute, a short review would mean a lot to us. If you have already left one, thank you so much, and please ignore this note.\n\n${textLinks}\n\nThank you,\n${companyName}\n\n--\n${companyName}${address ? ' · ' + address : ''}\nThis is a one-time reminder. Unsubscribe: ${unsubscribeUrl}`;
  return { subject: `Quick reminder: leave ${companyName} a review`, html, text };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function processDueReminders({ now = new Date(), send = sendEmail, limit = 20, spacingMs = 600 } = {}) {
  const summary = { claimed: 0, sent: 0, cancelled: 0, failed: 0 };
  if (!inSendWindow(now)) return { ...summary, outsideWindow: true };

  const claimed = (await query(
    `UPDATE review_requests SET reminder_status = 'sending'
     WHERE id IN (SELECT id FROM review_requests WHERE reminder_status = 'pending' AND reminder_due_at <= $1 AND status = 'sent'
                  ORDER BY reminder_due_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED)
     RETURNING *`, [now, limit])).rows;
  summary.claimed = claimed.length;
  const finish = (id, status) => query(
    `UPDATE review_requests SET reminder_status = $2::varchar, reminder_sent_at = CASE WHEN $2::text = 'sent' THEN now() ELSE reminder_sent_at END WHERE id = $1`, [id, status]);

  let n = 0;
  for (const r of claimed) {
    try {
      if (r.replied_at) { await finish(r.id, 'cancelled'); summary.cancelled++; continue; }
      const opted = await query('SELECT 1 FROM outreach_suppressions WHERE tenant_id = $1 AND LOWER(email) = LOWER($2)', [r.tenant_id, r.customer_email]);
      if (opted.rows.length) { await finish(r.id, 'cancelled'); summary.cancelled++; continue; }
      const t = await query(
        `SELECT t.company_name, bp.google_review_url, bp.yelp_review_url, bp.email, bp.address
         FROM tenants t LEFT JOIN business_profile bp ON bp.tenant_id = t.id WHERE t.id = $1`, [r.tenant_id]);
      const row = t.rows[0];
      const links = [];
      if (row && row.google_review_url) links.push({ label: 'Google', url: row.google_review_url });
      if (row && row.yelp_review_url) links.push({ label: 'Yelp', url: row.yelp_review_url });
      if (!row || !links.length) { await finish(r.id, 'cancelled'); summary.cancelled++; continue; }

      const unsubscribeUrl = buildUnsubscribeUrl(r.reminder_base_url || '', r.tenant_id, r.customer_email);
      const { subject, html, text } = buildReminder({ companyName: row.company_name, customerName: r.customer_name, links, address: (row.address || '').trim(), unsubscribeUrl });
      const validProfileEmail = row.email && EMAIL_RE.test(row.email) ? row.email : undefined;
      if (n++ > 0) await sleep(spacingMs);
      await send({
        to: r.customer_email, subject, html, text, fromName: row.company_name,
        replyTo: buildReplyToAddress('review', r.id) || validProfileEmail,
        headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
      });
      await finish(r.id, 'sent'); summary.sent++;
    } catch (err) {
      await finish(r.id, 'cancelled').catch(() => {});
      summary.failed++;
      console.error('[reviewReminders] failed:', err.message);
    }
  }
  return summary;
}

module.exports = { REMINDER_DAYS, buildReminder, processDueReminders };
