// What to do when Resend reports that a vendor email hard-bounced or was
// marked as spam. Either way the address must never be emailed again — a
// repeat bounce or complaint is what damages a sending reputation, and the
// sending account is shared by every company on Eagle I.
//
// - Suppress it for the tenant that sent it (labelled bounced/complained, so
//   the panel doesn't call it an unsubscribe).
// - Cancel any follow-up still waiting to go to it.
// - A HARD bounce also means the address is dead for everyone: mark it
//   unusable in every vendor directory table. A complaint is about one
//   sender's email, so it only affects that tenant.
// - Soft (transient/undetermined) bounces — a full mailbox, a server hiccup —
//   are recorded but change nothing, since the address may be fine.
const { query } = require('../db');
const { SOURCES } = require('./vendorDirectories');
const { cancelFollowUps } = require('./followUps');
const { cancelQueued } = require('./outreachQueue');

const isHardBounce = (bounce) => /permanent/i.test(String((bounce && bounce.type) || ''));

async function processDeliveryEvent(event) {
  const type = event && event.type;
  if (type !== 'email.bounced' && type !== 'email.complained') return { handled: false };
  const data = event.data || {};
  if (!data.email_id) return { handled: false, reason: 'no email id' };

  const row = (await query('SELECT id, tenant_id, to_email FROM vendor_outreach WHERE resend_email_id = $1', [data.email_id])).rows[0];
  // Not a vendor email (e.g. a review request) or not ours — nothing to do here.
  if (!row) return { handled: false, reason: 'not a vendor outreach email' };

  let status, detail, suppress = false, invalidateEverywhere = false;
  if (type === 'email.complained') {
    status = 'complained'; detail = 'Recipient marked the email as spam'; suppress = true;
  } else if (isHardBounce(data.bounce)) {
    status = 'bounced'; detail = (data.bounce && data.bounce.message) || 'Address does not exist or rejected the email';
    suppress = true; invalidateEverywhere = true;
  } else {
    status = 'soft_bounce'; detail = (data.bounce && data.bounce.message) || 'Temporary delivery problem';
  }

  await query(
    'UPDATE vendor_outreach SET delivery_status = $1, delivery_detail = $2, delivery_at = now() WHERE id = $3',
    [status, String(detail).slice(0, 500), row.id]
  );
  if (suppress) {
    await query(
      `INSERT INTO outreach_suppressions (tenant_id, email, reason) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, lower(email)) DO NOTHING`,
      [row.tenant_id, row.to_email, status]
    );
    await cancelFollowUps(row.tenant_id, row.to_email, status);
    await cancelQueued(row.tenant_id, row.to_email, status);
  }
  if (invalidateEverywhere) {
    for (const s of Object.values(SOURCES)) {
      await query(
        `UPDATE ${s.table} SET email_check_status = 'invalid', email_check_reason = 'the address bounced when emailed', email_checked_at = now()
         WHERE LOWER(contact_email) = LOWER($1)`,
        [row.to_email]
      );
    }
  }
  return { handled: true, status, tenantId: row.tenant_id, email: row.to_email };
}

module.exports = { processDeliveryEvent, isHardBounce };
