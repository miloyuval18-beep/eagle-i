// Generic "send this AI-drafted message to one named person" endpoint —
// the send half of three previously advisory-only features that now
// actually go out: the Outreach Generator's email/event-follow-up
// channels (Growth & Partners), and the Real Signals card's weather-alert
// / permit-spike outreach drafts (Market Intel). All three already showed
// a human the exact text before this existed; this route is only what
// happens after they click Send — same one-at-a-time, no-bulk-blast
// posture as /api/vendors/outreach-email in routes/onboarding.js, and it
// shares that route's exact pattern (including the reply-capture wiring)
// rather than introducing a second way of doing the same thing.
const express = require('express');
const crypto = require('crypto');
const { query } = require('../db');
const { requireAuth } = require('../auth');
const { sendEmail, buildReplyToAddress } = require('../lib/email');
const { escapeHtml } = require('../lib/landingPageTemplate');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_CHANNELS = new Set(['email', 'event', 'signal_weather', 'signal_permit']);

const router = express.Router();

router.post('/api/partners/outreach-email', requireAuth, async (req, res) => {
  const { toEmail, recipientName, subject, message, channel } = req.body || {};
  if (!toEmail || !EMAIL_RE.test(toEmail)) {
    return res.status(400).json({ error: { message: 'A valid recipient email is required.' } });
  }
  if (!message || !message.trim()) {
    return res.status(400).json({ error: { message: 'Message text is required.' } });
  }
  const safeChannel = VALID_CHANNELS.has(channel) ? channel : 'email';
  if (!process.env.RESEND_API_KEY) {
    return res.status(503).json({ error: { message: 'Outreach emails are not configured on this server yet (missing RESEND_API_KEY).' } });
  }
  const outreachId = crypto.randomUUID();
  try {
    const tenantRes = await query('SELECT company_name FROM tenants WHERE id = $1', [req.tenantId]);
    const profileRes = await query('SELECT founder_name, phone, email FROM business_profile WHERE tenant_id = $1', [req.tenantId]);
    if (!tenantRes.rows.length) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    const companyName = tenantRes.rows[0].company_name;
    const profile = profileRes.rows[0] || {};

    const signatureLine = [profile.founder_name || companyName, profile.phone, profile.email].filter(Boolean).map(escapeHtml).join(' · ');
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;color:#12203a">
${escapeHtml(message).split('\n').map(line => `<p>${line}</p>`).join('')}
<p style="color:#5a7290;font-size:13px">${signatureLine}</p>
</div>`;

    const validProfileEmail = profile.email && EMAIL_RE.test(profile.email) ? profile.email : undefined;
    const replyTo = buildReplyToAddress('partner', outreachId) || validProfileEmail;

    let sent, sendError;
    try {
      sent = await sendEmail({
        to: toEmail.trim(),
        subject: (subject && subject.trim()) || `A note from ${companyName}`,
        html, text: message, replyTo
      });
    } catch (err) {
      sendError = err;
    }

    await query(
      `INSERT INTO partner_outreach (id, tenant_id, sent_by, recipient_name, to_email, channel, subject, message, status, error, resend_email_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [outreachId, req.tenantId, req.userId || null, recipientName || toEmail.trim(), toEmail.trim(), safeChannel,
       subject || null, message, sendError ? 'failed' : 'sent', sendError ? sendError.message : null, sent && sent.id ? sent.id : null]
    );

    if (sendError) return res.status(502).json({ error: { message: 'Failed to send: ' + sendError.message } });
    res.json({ ok: true, id: sent.id || null, recipientName: recipientName || null });
  } catch (err) {
    res.status(502).json({ error: { message: 'Failed to send: ' + err.message } });
  }
});

router.get('/api/partners/outreach', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, recipient_name, to_email, channel, subject, message, status, error, reply_text, replied_at, created_at
       FROM partner_outreach WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.tenantId]
    );
    res.json({ outreach: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load outreach history: ' + err.message } });
  }
});

module.exports = router;
