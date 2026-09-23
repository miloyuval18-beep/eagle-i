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
//    RESEND_WEBHOOK_SECRET. Also tick email.bounced and email.complained on
//    the same webhook: those keep dead and spam-reporting addresses from
//    being emailed again (lib/deliveryEvents.js).
// Without both, lib/email.js's buildReplyToAddress() returns null and
// routes/onboarding.js / routes/reviews.js fall back to Reply-To pointing
// straight at the tenant's own email (works, just isn't shown on the site).
const { Webhook } = require('svix');
const { query } = require('../db');
const { getReceivedEmail, sendEmail } = require('../lib/email');
const { processDeliveryEvent } = require('../lib/deliveryEvents');
const { cancelFollowUpForOutreach, cancelFollowUps } = require('../lib/followUps');
const { cancelQueued } = require('../lib/outreachQueue');
const { classifyReply, senderAddress } = require('../lib/replyClassifier');
const relationships = require('../lib/relationships');

// Matches only the reply+<kind>-<uuid>@... local-part this app generates
// itself (lib/email.js's buildReplyToAddress) — an inbound address in any
// other shape is ignored rather than trusted.
const REPLY_ADDRESS_RE = /^reply\+(vendor|review|partner)-([0-9a-f-]{36})@/i;

// replyToEmail is whoever actually sent the reply (not necessarily the
// address Eagle I originally wrote to — a reply can come from a different
// address than the one on file). Set as Reply-To so that hitting "reply" on
// this notification in the tenant's own inbox goes straight back to them,
// instead of to Eagle I's own default sending address (a dead end nobody
// reads).
async function forwardToTenant(tenantId, subjectPrefix, full, replyToEmail) {
  try {
    const profileRes = await query('SELECT email FROM business_profile WHERE tenant_id = $1', [tenantId]);
    const tenantEmail = profileRes.rows[0] && profileRes.rows[0].email;
    if (!tenantEmail) return;
    await sendEmail({
      to: tenantEmail,
      subject: `${subjectPrefix}: ${full.subject || '(no subject)'}`,
      html: full.html || `<pre>${String(full.text || '').replace(/</g, '&lt;')}</pre>`,
      text: full.text || full.html || '',
      replyTo: replyToEmail || undefined
    });
  } catch (err) {
    console.error('[inboundEmail] forwarding to tenant failed:', err.message);
  }
}

const htmlToText = (html) => String(html || '').replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');

// What each kind of reply is called in the alert email the owner receives.
const ALERT_PREFIX = {
  interested: (name) => `Interested: ${name} replied`,
  not_now: (name) => `Not now: ${name} replied`,
  unsubscribe: (name) => `${name} asked to be removed (done, they will not be emailed again)`,
  other: (name) => `${name} replied`
};

async function suppress(tenantId, email) {
  await query(
    `INSERT INTO outreach_suppressions (tenant_id, email, reason) VALUES ($1, $2, 'unsubscribed')
     ON CONFLICT (tenant_id, lower(email)) DO NOTHING`, [tenantId, email]);
  await cancelFollowUps(tenantId, email, 'opted_out');
  await cancelQueued(tenantId, email, 'opted_out');
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
    const text = full.text || htmlToText(full.html);
    const cls = classifyReply({ subject: full.subject, text });

    // Out-of-office and other automatic replies are recorded, but they are not
    // a reply from a person: they don't stop follow-ups, don't alert the owner,
    // and never overwrite a real reply already on file.
    if (cls.category === 'auto_reply') {
      await query(
        `UPDATE vendor_outreach SET reply_text = $1, reply_html = $2, reply_category = 'auto_reply', reply_category_by = 'auto'
         WHERE id = $3 AND replied_at IS NULL`, [full.text || null, full.html || null, id]);
      return;
    }

    const result = await query(
      `UPDATE vendor_outreach SET reply_text = $1, reply_html = $2, replied_at = now(), reply_category = $4, reply_category_by = 'auto'
       WHERE id = $3 RETURNING tenant_id, vendor_name, to_email, source, source_id`,
      [full.text || null, full.html || null, id, cls.category]
    );
    if (result.rows.length) {
      const row = result.rows[0];
      // They answered, so no scheduled follow-up (either step) or queued send may go out.
      await cancelFollowUpForOutreach(id, 'replied');
      await cancelFollowUps(row.tenant_id, row.to_email, 'replied');
      await cancelQueued(row.tenant_id, row.to_email, 'replied');
      if (cls.category === 'unsubscribe') {
        // Honour it at once — for the address we wrote to and for whoever actually replied.
        await suppress(row.tenant_id, row.to_email);
        const from = senderAddress(full.from);
        if (from && from !== String(row.to_email).toLowerCase()) await suppress(row.tenant_id, from);
      }
      relationships.noteReply({ tenantId: row.tenant_id, source: row.source, sourceId: row.source_id ? Number(row.source_id) : null })
        .catch(err => console.error('[inboundEmail] relationship update failed:', err.message));
      await forwardToTenant(row.tenant_id, (ALERT_PREFIX[cls.category] || ALERT_PREFIX.other)(row.vendor_name), full, senderAddress(full.from) || row.to_email);
    }
  } else if (kind === 'review') {
    const result = await query(
      `UPDATE review_requests SET reply_text = $1, reply_html = $2, replied_at = now()
       WHERE id = $3 RETURNING tenant_id, customer_name, customer_email`,
      [full.text || null, full.html || null, id]
    );
    if (result.rows.length) {
      const row = result.rows[0];
      await forwardToTenant(row.tenant_id, `${row.customer_name} replied`, full, senderAddress(full.from) || row.customer_email);
    }
  } else if (kind === 'partner') {
    const result = await query(
      `UPDATE partner_outreach SET reply_text = $1, reply_html = $2, replied_at = now()
       WHERE id = $3 RETURNING tenant_id, recipient_name, to_email`,
      [full.text || null, full.html || null, id]
    );
    if (result.rows.length) {
      const row = result.rows[0];
      await forwardToTenant(row.tenant_id, `${row.recipient_name} replied`, full, senderAddress(full.from) || row.to_email);
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

  try {
    if (event.type === 'email.received') await processInboundEmail(event.data);
    // email.bounced / email.complained: see lib/deliveryEvents.js. Any other
    // event type is acknowledged and ignored.
    else await processDeliveryEvent(event);
  } catch (err) {
    console.error('[inboundEmail] processing failed:', err.message);
  }
}

module.exports = { handleInboundWebhook, processInboundEmail, REPLY_ADDRESS_RE };
