// "Spread these over several days": instead of sending a whole batch at once
// (which looks like a blast to mail providers and to the people receiving it),
// the batch is queued with a due time per recipient, spaced evenly through
// business hours (Mon–Fri, 9:30am–4:30pm Central) over the chosen number of
// business days.
//
// The exact message — and any follow-up text — was shown to and approved by
// the user when the batch was confirmed. Nothing new is written later; the
// worker only re-checks that each person is still safe to email (not opted
// out, bounced, complained, or already emailed) and that the daily cap has
// room, then sends through the same path as an immediate send.
const crypto = require('crypto');
const { query } = require('../db');
const outreach = require('./vendorOutreach');
const followUps = require('./followUps');

const TZ = 'America/Chicago';
const WINDOW_START_MIN = 9 * 60 + 30;  // 9:30am
const WINDOW_END_MIN = 16 * 60 + 30;   // 4:30pm
const MAX_SPREAD_DAYS = 15;
const MAX_PENDING_PER_TENANT = 500;

function tzParts(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: false, weekday: 'short'
  }).formatToParts(date).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, wd: p.weekday };
}

// The UTC instant at which the wall clock in Central time reads y-m-d h:mi.
function zonedToUtc(y, m, d, h, mi) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const p = tzParts(new Date(guess));
  const seenAsUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
  return new Date(guess - (seenAsUtc - guess));
}

const isWeekend = (wd) => wd === 'Sat' || wd === 'Sun';

// One due time per recipient, in send order. Today counts only if there is
// still room in today's window; otherwise the first business day is the next one.
function buildSchedule(count, days, now = new Date()) {
  if (count <= 0) return [];
  const spread = Math.min(MAX_SPREAD_DAYS, Math.max(1, parseInt(days, 10) || 1));
  const perDay = Math.ceil(count / spread);
  const out = [];

  let cur = tzParts(now);
  let first = true;
  while (out.length < count) {
    if (!isWeekend(cur.wd)) {
      const winStart = zonedToUtc(cur.y, cur.m, cur.d, Math.floor(WINDOW_START_MIN / 60), WINDOW_START_MIN % 60);
      const winEnd = zonedToUtc(cur.y, cur.m, cur.d, Math.floor(WINDOW_END_MIN / 60), WINDOW_END_MIN % 60);
      let start = winStart;
      if (first) start = new Date(Math.max(winStart.getTime(), now.getTime() + 3 * 60000)); // never in the past
      if (start.getTime() < winEnd.getTime() - 20 * 60000) {
        const n = Math.min(perDay, count - out.length);
        const step = (winEnd.getTime() - start.getTime()) / n;
        for (let i = 0; i < n; i++) out.push(new Date(start.getTime() + i * step));
      }
    }
    first = false;
    // next calendar day in Central time
    const noon = zonedToUtc(cur.y, cur.m, cur.d, 12, 0);
    cur = tzParts(new Date(noon.getTime() + 24 * 3600 * 1000));
  }
  return out;
}

async function pendingCount(tenantId) {
  return (await query("SELECT COUNT(*)::int AS n FROM outreach_queue WHERE tenant_id = $1 AND status = 'pending'", [tenantId])).rows[0].n;
}

// recipients: [{ email, name, message, follow1Message, follow2Message }] — every
// text already has the greeting filled in for that person.
async function enqueue({ tenantId, recipients, follow1Days = null, follow2Days = null, baseUrl, days, now = new Date() }) {
  const due = buildSchedule(recipients.length, days, now);
  const queued = [];
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const has1 = follow1Days && r.follow1Message;
    const has2 = has1 && follow2Days && r.follow2Message;
    const res = await query(
      `INSERT INTO outreach_queue (id, tenant_id, to_email, vendor_name, message, due_at, base_url,
                                   follow1_days, follow1_message, follow2_days, follow2_message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (tenant_id, lower(to_email)) WHERE status IN ('pending','sending') DO NOTHING
       RETURNING id, due_at`,
      [crypto.randomUUID(), tenantId, r.email, r.name, r.message, due[i], baseUrl || '',
       has1 ? follow1Days : null, has1 ? r.follow1Message : null, has2 ? follow2Days : null, has2 ? r.follow2Message : null]
    );
    if (res.rows[0]) queued.push({ email: r.email, name: r.name, dueAt: res.rows[0].due_at });
  }
  return queued;
}

async function cancelQueued(tenantId, email, reason) {
  return (await query(
    `UPDATE outreach_queue SET status = 'cancelled', cancel_reason = $3, updated_at = now()
     WHERE tenant_id = $1 AND LOWER(to_email) = LOWER($2) AND status = 'pending'`, [tenantId, email, reason])).rowCount;
}
async function cancelQueueOne(tenantId, id) {
  return (await query(
    `UPDATE outreach_queue SET status = 'cancelled', cancel_reason = 'user', updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'pending'`, [id, tenantId])).rowCount;
}
async function cancelQueueAll(tenantId) {
  return (await query(
    `UPDATE outreach_queue SET status = 'cancelled', cancel_reason = 'user', updated_at = now()
     WHERE tenant_id = $1 AND status = 'pending'`, [tenantId])).rowCount;
}

async function listQueue(tenantId) {
  const pending = await query(
    `SELECT id, vendor_name, to_email, due_at FROM outreach_queue
     WHERE tenant_id = $1 AND status = 'pending' ORDER BY due_at ASC LIMIT 200`, [tenantId]);
  const range = await query(
    `SELECT COUNT(*)::int AS n, MIN(due_at) AS first_due, MAX(due_at) AS last_due
     FROM outreach_queue WHERE tenant_id = $1 AND status = 'pending'`, [tenantId]);
  return { pending: pending.rows, total: range.rows[0].n, firstDue: range.rows[0].first_due, lastDue: range.rows[0].last_due };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SKIP_TO_CANCEL = { opted_out: 'opted_out', bounced: 'bounced', complained: 'complained', already_emailed: 'already_emailed', domain_cannot_receive_mail: 'domain', invalid_email: 'domain' };

async function processDueQueue({ now = new Date(), send = outreach.sendOutreach, limit = 20, spacingMs = outreach.SEND_SPACING_MS } = {}) {
  const summary = { claimed: 0, sent: 0, cancelled: 0, deferred: 0, failed: 0 };
  if (!followUps.inSendWindow(now)) return { ...summary, outsideWindow: true };

  const claimed = (await query(
    `UPDATE outreach_queue SET status = 'sending', updated_at = now()
     WHERE id IN (SELECT id FROM outreach_queue WHERE status = 'pending' AND due_at <= $1
                  ORDER BY due_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED)
     RETURNING *`, [now, limit])).rows;
  summary.claimed = claimed.length;

  const finish = (id, status, extra = {}) => query(
    `UPDATE outreach_queue SET status = $2, cancel_reason = $3, sent_outreach_id = $4, error = $5, updated_at = now() WHERE id = $1`,
    [id, status, extra.reason || null, extra.sentId || null, extra.error || null]);
  const ctxCache = new Map();
  let sentThisRun = 0;

  for (const q of claimed) {
    try {
      const screen = await outreach.screenRecipients(q.tenant_id, [{ email: q.to_email, name: q.vendor_name }]);
      if (screen.skipped.length) {
        await finish(q.id, 'cancelled', { reason: SKIP_TO_CANCEL[screen.skipped[0].reason] || 'user' }); summary.cancelled++; continue;
      }
      let ctx = ctxCache.get(q.tenant_id);
      if (!ctx) { ctx = await outreach.getSenderContext(q.tenant_id); ctxCache.set(q.tenant_id, ctx); }
      if (!ctx || (ctx.profile.address || '').trim().length < 8) { await finish(q.id, 'cancelled', { reason: 'no_address' }); summary.cancelled++; continue; }

      // The daily cap covers scheduled sends too; over it, wait for tomorrow.
      if ((await outreach.sentInLast24h(q.tenant_id)) >= outreach.BULK_DAILY_CAP) {
        await query(`UPDATE outreach_queue SET status = 'pending', updated_at = now() WHERE id = $1`, [q.id]);
        summary.deferred++; continue;
      }

      if (sentThisRun++ > 0) await sleep(spacingMs);
      const res = await send({ tenantId: q.tenant_id, ctx, baseUrl: q.base_url || '', toEmail: q.to_email, vendorName: q.vendor_name, message: q.message });
      if (res.ok) {
        await finish(q.id, 'sent', { sentId: res.outreachId }); summary.sent++;
        if (q.follow1_message && q.follow1_days) {
          await followUps.scheduleFollowUp({
            tenantId: q.tenant_id, outreachId: res.outreachId, toEmail: q.to_email, vendorName: q.vendor_name,
            message: q.follow1_message, days: q.follow1_days, baseUrl: q.base_url, step: 1,
            nextDays: q.follow2_days, nextMessage: q.follow2_message
          });
        }
      } else if (res.reason === 'opted_out') { await finish(q.id, 'cancelled', { reason: 'opted_out' }); summary.cancelled++; }
      else if (res.reason === 'domain_cannot_receive_mail') { await finish(q.id, 'cancelled', { reason: 'domain' }); summary.cancelled++; }
      else { await finish(q.id, 'failed', { error: res.error || res.reason }); summary.failed++; }
    } catch (err) {
      await finish(q.id, 'failed', { error: err.message }).catch(() => {});
      summary.failed++;
    }
  }
  return summary;
}

module.exports = {
  MAX_SPREAD_DAYS, MAX_PENDING_PER_TENANT, buildSchedule, zonedToUtc, tzParts, pendingCount,
  enqueue, cancelQueued, cancelQueueOne, cancelQueueAll, listQueue, processDueQueue
};
