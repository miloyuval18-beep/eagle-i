const express = require('express');
const crypto = require('crypto');
const { query } = require('../db');
const { requireAuth } = require('../auth');
const { sendEmail, buildReplyToAddress } = require('../lib/email');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function buildReviewRequestEmail(companyName, customerName, links) {
  const buttons = links.map(l =>
    `<p style="margin:10px 0"><a href="${l.url}" style="display:inline-block;background:#1a7ee8;color:#fff;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:600">Leave a ${l.label} review</a></p>`
  ).join('');
  const textLinks = links.map(l => `${l.label}: ${l.url}`).join('\n');

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;color:#12203a">
<p>Hi ${customerName},</p>
<p>Thanks for choosing ${companyName}! If you have a minute, a quick review would mean a lot to us.</p>
${buttons}
<p style="color:#5a7290;font-size:13px">Thank you,<br>${companyName}</p>
</div>`;
  const text = `Hi ${customerName},\n\nThanks for choosing ${companyName}! If you have a minute, a quick review would mean a lot to us.\n\n${textLinks}\n\nThank you,\n${companyName}`;

  return { subject: `Quick favor? Leave ${companyName} a review`, html, text };
}

router.post('/api/review-requests', requireAuth, async (req, res) => {
  const { customerName, customerEmail } = req.body || {};
  if (!customerName || !customerName.trim()) {
    return res.status(400).json({ error: { message: 'Customer name is required.' } });
  }
  if (!customerEmail || !customerEmail.trim()) {
    return res.status(400).json({ error: { message: 'Customer email is required.' } });
  }
  if (!process.env.RESEND_API_KEY) {
    return res.status(503).json({ error: { message: 'Review request emails are not configured on this server yet (missing RESEND_API_KEY).' } });
  }

  try {
    const tenantRes = await query('SELECT company_name FROM tenants WHERE id = $1', [req.tenantId]);
    const profileRes = await query('SELECT google_review_url, yelp_review_url, email FROM business_profile WHERE tenant_id = $1', [req.tenantId]);
    if (!tenantRes.rows.length) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    const companyName = tenantRes.rows[0].company_name;
    const profile = profileRes.rows[0] || {};

    const links = [];
    if (profile.google_review_url) links.push({ label: 'Google', url: profile.google_review_url });
    if (profile.yelp_review_url) links.push({ label: 'Yelp', url: profile.yelp_review_url });
    if (!links.length) {
      return res.status(400).json({ error: { message: 'Add a Google or Yelp review link in your business profile first.' } });
    }

    const { subject, html, text } = buildReviewRequestEmail(companyName, customerName.trim(), links);
    const includedPlatforms = links.map(l => l.label.toLowerCase());
    const reviewRequestId = crypto.randomUUID();

    // Reply-To is a reply+review-<id>@ address this app controls when
    // inbound email is configured (RESEND_INBOUND_DOMAIN) — that's what
    // lets a customer's reply show up on the dashboard. Otherwise it falls
    // back to the tenant's own email directly: still reaches them via
    // normal email routing, just not captured/shown here.
    const validProfileEmail = profile.email && EMAIL_RE.test(profile.email) ? profile.email : undefined;
    const replyTo = buildReplyToAddress('review', reviewRequestId) || validProfileEmail;

    try {
      const sent = await sendEmail({ to: customerEmail.trim(), subject, html, text, replyTo });
      const row = await query(
        `INSERT INTO review_requests (id, tenant_id, sent_by, customer_name, customer_email, included_platforms, status, resend_email_id)
         VALUES ($1,$2,$3,$4,$5,$6,'sent',$7) RETURNING *`,
        [reviewRequestId, req.tenantId, req.userId, customerName.trim(), customerEmail.trim(), JSON.stringify(includedPlatforms), sent.id || null]
      );
      res.json({ ok: true, reviewRequest: row.rows[0] });
    } catch (sendErr) {
      const row = await query(
        `INSERT INTO review_requests (id, tenant_id, sent_by, customer_name, customer_email, included_platforms, status, error)
         VALUES ($1,$2,$3,$4,$5,$6,'failed',$7) RETURNING *`,
        [reviewRequestId, req.tenantId, req.userId, customerName.trim(), customerEmail.trim(), JSON.stringify(includedPlatforms), sendErr.message]
      );
      res.status(502).json({ error: { message: 'Failed to send: ' + sendErr.message }, reviewRequest: row.rows[0] });
    }
  } catch (err) {
    res.status(500).json({ error: { message: 'Review request failed: ' + err.message } });
  }
});

router.get('/api/review-requests', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM review_requests WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [req.tenantId]
    );
    res.json({ reviewRequests: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load review requests: ' + err.message } });
  }
});

module.exports = router;
