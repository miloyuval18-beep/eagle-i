// Receives real replies to vendor-outreach and review-request emails via
// Resend's inbound-email webhook, so a reply shows up on the dashboard
// instead of only landing in the tenant's own inbox (it still also lands
// there — see forwardToTenant below).
//
// Needs two things configured in Resend's dashboard, neither of which this
// code can do on the app's behalf — see README:
//  - Email receiving enabled on a domain (the zero-DNS-setup option is a
//    Resend-managed <id>.resend.app address; a custom domain needs an MX
//    record) — that domain goes in RESEND_INBOUND_DOMAIN.
//  - A webhook for the email.received event, pointed at
//    POST /api/webhooks/resend-inbound — its signing secret goes in
//    RESEND_WEBHOOK_SECRET.
// Without both, lib/email.js's buildReplyToAddress() returns null and
// routes/onboarding.js / routes/reviews.js fall back to Reply-To pointing
// straight at the tenant's own email (works, just isn't shown on the site).
const { Webhook } = require('svix');
const { query } = require('../db');
const { getReceivedEmail, sendEmail } = require('../lib/email');

// Matches only the reply+<kind>-<uuid>@... local-part this app generates
// itself (lib/email.js's buildReplyToAddress) — an inbound address in any
// other shape is ignored rather than trusted.
const REPLY_ADDRESS_RE = /^reply\+(vendor|review)-([0-9a-f-]{36})@/i;

async function forwardToTenant(tenantId, subjectPrefix, full) {
  try {
    const profileRes = await query('SELECT email FROM business_profile WHERE tenant_id = $1', [tenantId]);
    const tenantEmail = profileRes.rows[0] && profileRes.rows[0].email;
    if (!tenantEmail) return;
    await sendEmail({
      to: tenantEmail,
      subject: `${subjectPrefix}: ${full.subject || '(no subject)'}`,
      html: full.html || `<pre>${String(full.text || '').replace(/</g, '&lt;')}</pre>`,
      text: full.text || full.html || ''
    });
  } catch (err) {
    console.error('[inboundEmail] forwarding to tenant failed:', err.message);
  }
}

async function processInboundEmail(data) {
  const toAddresses = Array.isArray(data.to) ? data.to : [data.to].filter(Boolean);
  let match = null;
  for (const addr of toAddresses) {
    match = REPLY_ADDRESS_RE.exec(addr);
    if (match) break;
  }
  if (!match) return; // not addressed to one of our reply+ tokens — ignore

  const [, kind, id] = match;
  const full = await getReceivedEmail(data.email_id);

  if (kind === 'vendor') {
    const result = await query(
      `UPDATE vendor_outreach SET reply_text = $1, reply_html = $2, replied_at = now()
       WHERE id = $3 RETURNING tenant_id, vendor_name`,
      [full.text || null, full.html || null, id]
    );
    if (result.rows.length) {
      await forwardToTenant(result.rows[0].tenant_id, `${result.rows[0].vendor_name} replied`, full);
    }
  } else if (kind === 'review') {
    const result = await query(
      `UPDATE review_requests SET reply_text = $1, reply_html = $2, replied_at = now()
       WHERE id = $3 RETURNING tenant_id, customer_name`,
      [full.text || null, full.html || null, id]
    );
    if (result.rows.length) {
      await forwardToTenant(result.rows[0].tenant_id, `${result.rows[0].customer_name} replied`, full);
    }
  }
}

async function handleInboundWebhook(req, res) {
  if (!process.env.RESEND_WEBHOOK_SECRET) {
    return res.status(503).send('Inbound email is not configured on this server yet.');
  }

  let event;
  try {
    const raw = req.body.toString('utf8');
    const wh = new Webhook(process.env.RESEND_WEBHOOK_SECRET);
    // wh.verify() only throws on a bad signature — it does NOT hand back
    // the parsed payload (despite what some docs/examples imply), so the
    // body still has to be parsed separately once verification passes.
    wh.verify(raw, {
      'svix-id': req.headers['svix-id'],
      'svix-timestamp': req.headers['svix-timestamp'],
      'svix-signature': req.headers['svix-signature']
    });
    event = JSON.parse(raw);
  } catch (err) {
    return res.status(400).send('Webhook signature verification failed: ' + err.message);
  }

  // Acknowledge immediately — a slow/failed downstream step (the Resend API
  // call to fetch the full body, a DB write) shouldn't make Resend think
  // the webhook itself failed and retry-storm us.
  res.json({ received: true });

  if (event.type !== 'email.received') return;
  try {
    await processInboundEmail(event.data);
  } catch (err) {
    console.error('[inboundEmail] processing failed:', err.message);
  }
}

module.exports = { handleInboundWebhook, REPLY_ADDRESS_RE };
