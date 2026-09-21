// One automatic follow-up per initial vendor email. The exact follow-up text
// was shown to and approved by the user in the same confirmation as the
// first email; nothing here writes new copy. At send time each follow-up is
// re-checked and dropped if the person has since replied, opted out, bounced
// or complained — so "no reply" really means no reply.
const crypto = require('crypto');
const { query } = require('../db');
const outreach = require('./vendorOutreach');

const MIN_DAYS = 3;
const MAX_DAYS = 21;
const DEFAULT_DAYS = 7;
// Directories here are Houston-only, so business hours are Central time.
const SEND_TZ = 'America/Chicago';
const SEND_FROM_HOUR = 9;
const SEND_UNTIL_HOUR = 17;

const clampDays = (d) => Math.min(MAX_DAYS, Math.max(MIN_DAYS, parseInt(d, 10) || DEFAULT_DAYS));

// Mon–Fri, 9:00–16:59 Central. A follow-up that comes due at midnight simply
// waits for the next tick inside this window.
function inSendWindow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: SEND_TZ, weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(date);
  const weekday = parts.find(p => p.type === 'weekday').value;
  const hour = parseInt(parts.find(p => p.type === 'hour').value, 10) % 24;
  return !['Sat', 'Sun'].includes(weekday) && hour >= SEND_FROM_HOUR && hour < SEND_UNTIL_HOUR;
}

async function scheduleFollowUp({ tenantId, outreachId, toEmail, vendorName, message, days, baseUrl, step = 1, nextDays = null, nextMessage = null }) {
  const id = crypto.randomUUID();
  // (outreach_id, step) is unique: re-running a send can never queue a second copy of the same step.
  // nextDays/nextMessage hold the approved text for step 2, which is only queued once step 1 has really gone out.
  const r = await query(
    `INSERT INTO outreach_followups (id, tenant_id, outreach_id, to_email, vendor_name, message, due_at, base_url, step, next_days, next_message)
     VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' days')::interval, $8, $9, $10, $11)
     ON CONFLICT (outreach_id, step) DO NOTHING RETURNING id, due_at`,
    [id, tenantId, outreachId, toEmail, vendorName, message, String(clampDays(days)), baseUrl || '', step,
     nextMessage ? clampDays(nextDays) : null, nextMessage || null]
  );
  return r.rows[0] || null;
}

// Pending follow-ups only — one already mid-send can't be recalled.
async function cancelFollowUps(tenantId, email, reason) {
  const r = await query(
    `UPDATE outreach_followups SET status = 'cancelled', cancel_reason = $3, updated_at = now()
     WHERE tenant_id = $1 AND LOWER(to_email) = LOWER($2) AND status = 'pending'`,
    [tenantId, email, reason]
  );
  return r.rowCount;
}
async function cancelFollowUpForOutreach(outreachId, reason) {
  const r = await query(
    `UPDATE outreach_followups SET status = 'cancelled', cancel_reason = $2, updated_at = now()
     WHERE outreach_id = $1 AND status = 'pending'`,
    [outreachId, reason]
  );
  return r.rowCount;
}
async function cancelOne(tenantId, id) {
  const r = await query(
    `UPDATE outreach_followups SET status = 'cancelled', cancel_reason = 'user', updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'pending'`,
    [id, tenantId]
  );
  return r.rowCount;
}
async function cancelAll(tenantId) {
  const r = await query(
    `UPDATE outreach_followups SET status = 'cancelled', cancel_reason = 'user', updated_at = now()
     WHERE tenant_id = $1 AND status = 'pending'`,
    [tenantId]
  );
  return r.rowCount;
}

async function listFollowUps(tenantId) {
  const pending = await query(
    `SELECT id, vendor_name, to_email, due_at, step FROM outreach_followups
     WHERE tenant_id = $1 AND status = 'pending' ORDER BY due_at ASC LIMIT 200`,
    [tenantId]
  );
  const counts = await query(
    `SELECT status, COUNT(*)::int AS n FROM outreach_followups WHERE tenant_id = $1 GROUP BY status`,
    [tenantId]
  );
  return { pending: pending.rows, counts: Object.fromEntries(counts.rows.map(r => [r.status, r.n])) };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Sends whatever is due. `send` and `now` are injectable so the rules can be
// tested without email or waiting.
async function processDueFollowUps({ now = new Date(), send = outreach.sendOutreach, limit = 20, spacingMs = outreach.SEND_SPACING_MS } = {}) {
  const summary = { claimed: 0, sent: 0, cancelled: 0, deferred: 0, failed: 0 };
  if (!inSendWindow(now)) return { ...summary, outsideWindow: true };

  // SKIP LOCKED + the 'sending' status: two workers (or a restart mid-tick)
  // can never send the same follow-up twice.
  const claimed = (await query(
    `UPDATE outreach_followups SET status = 'sending', updated_at = now()
     WHERE id IN (SELECT id FROM outreach_followups WHERE status = 'pending' AND due_at <= $1
                  ORDER BY due_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [now, limit]
  )).rows;
  summary.claimed = claimed.length;

  const finish = (id, status, extra = {}) => query(
    `UPDATE outreach_followups SET status = $2, cancel_reason = $3, sent_outreach_id = $4, error = $5, updated_at = now() WHERE id = $1`,
    [id, status, extra.reason || null, extra.sentId || null, extra.error || null]
  );
  const ctxCache = new Map();
  let sentThisRun = 0;

  for (const f of claimed) {
    try {
      const initial = (await query('SELECT category_key, city, source, source_id FROM vendor_outreach WHERE id = $1', [f.outreach_id])).rows[0];
      if (!initial) { await finish(f.id, 'cancelled', { reason: 'user' }); summary.cancelled++; continue; }
      // Judge by the ADDRESS across every email we've sent it — a reply to the
      // first follow-up must stop the second, not just a reply to the original.
      const chain = (await query(
        `SELECT BOOL_OR(replied_at IS NOT NULL) AS replied,
                MAX(delivery_status) FILTER (WHERE delivery_status IN ('bounced', 'complained')) AS bad
         FROM vendor_outreach WHERE tenant_id = $1 AND LOWER(to_email) = LOWER($2)`,
        [f.tenant_id, f.to_email]
      )).rows[0];
      if (chain.replied) { await finish(f.id, 'cancelled', { reason: 'replied' }); summary.cancelled++; continue; }
      if (chain.bad) { await finish(f.id, 'cancelled', { reason: chain.bad }); summary.cancelled++; continue; }

      let ctx = ctxCache.get(f.tenant_id);
      if (!ctx) { ctx = await outreach.getSenderContext(f.tenant_id); ctxCache.set(f.tenant_id, ctx); }
      if (!ctx || (ctx.profile.address || '').trim().length < 8) { await finish(f.id, 'cancelled', { reason: 'no_address' }); summary.cancelled++; continue; }

      // The daily send cap covers follow-ups too; over the cap it waits for tomorrow.
      if ((await outreach.sentInLast24h(f.tenant_id)) >= outreach.BULK_DAILY_CAP) {
        await query(`UPDATE outreach_followups SET status = 'pending', updated_at = now() WHERE id = $1`, [f.id]);
        summary.deferred++; continue;
      }

      if (sentThisRun++ > 0) await sleep(spacingMs);
      const res = await send({
        tenantId: f.tenant_id, ctx, baseUrl: f.base_url || '', toEmail: f.to_email, vendorName: f.vendor_name, message: f.message,
        subject: f.step === 2 ? `One last note from ${ctx.companyName}` : `Following up on my note from ${ctx.companyName}`,
        meta: { kind: f.step === 2 ? 'followup2' : 'followup1', categoryKey: initial.category_key, city: initial.city, source: initial.source, sourceId: initial.source_id }
      });
      if (res.ok) {
        await finish(f.id, 'sent', { sentId: res.outreachId }); summary.sent++;
        // Step 1 went out: queue the approved step 2, counted from now.
        if (f.step === 1 && f.next_message && f.next_days) {
          await scheduleFollowUp({ tenantId: f.tenant_id, outreachId: f.outreach_id, toEmail: f.to_email, vendorName: f.vendor_name,
            message: f.next_message, days: f.next_days, baseUrl: f.base_url, step: 2 });
        }
      }
      else if (res.reason === 'opted_out') { await finish(f.id, 'cancelled', { reason: 'opted_out' }); summary.cancelled++; }
      else if (res.reason === 'domain_cannot_receive_mail') { await finish(f.id, 'cancelled', { reason: 'domain' }); summary.cancelled++; }
      else { await finish(f.id, 'failed', { error: res.error || res.reason }); summary.failed++; }
    } catch (err) {
      // Anything unexpected: mark it failed rather than leave it 'sending' forever.
      await finish(f.id, 'failed', { error: err.message }).catch(() => {});
      summary.failed++;
    }
  }
  return summary;
}

module.exports = {
  MIN_DAYS, MAX_DAYS, DEFAULT_DAYS, clampDays, inSendWindow,
  scheduleFollowUp, cancelFollowUps, cancelFollowUpForOutreach, cancelOne, cancelAll, listFollowUps, processDueFollowUps
};
