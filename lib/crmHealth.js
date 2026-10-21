// Eagle I watching itself. Every 30 minutes it checks that the background
// work is actually happening (the 5-minute tick that sends automatic emails
// and reminders, Gmail reading, emails due going out) and emails the admin
// (lib/alerting.js) if something has stopped, instead of failing quietly.
const { query } = require('../db');

const beats = new Map(); // what ran last, in this process
const startedAt = Date.now();
const told = new Map(); // problem -> when the admin was last told
const RETELL_MS = 6 * 3600000;

function beat(name) { beats.set(name, Date.now()); }

async function check(now = Date.now()) {
  const problems = [];
  const last = beats.get('followUpWorker');
  if (now - startedAt > 30 * 60000 && (!last || now - last > 30 * 60000)) {
    problems.push(`The background tick (automatic emails, reminders, Today checks) hasn't finished since ${last ? new Date(last).toISOString() : 'the server started'}. It may be stuck; restarting the server clears it.`);
  }
  const late = (await query(
    `SELECT COUNT(*)::int AS n, COUNT(DISTINCT s.tenant_id)::int AS companies FROM crm_playbook_sends s JOIN business_profile bp ON bp.tenant_id = s.tenant_id
     WHERE s.status = 'pending' AND s.due_at < now() - interval '30 hours' AND COALESCE((bp.crm_settings->>'paused')::boolean, false) = false`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0];
  if (late.n) problems.push(`${late.n} automatic email${late.n === 1 ? ' is' : 's are'} more than a day overdue at ${late.companies} compan${late.companies === 1 ? 'y' : 'ies'} (not paused).`);
  const mail = (await query(
    `SELECT COUNT(*)::int AS n FROM crm_mailboxes m JOIN crm_google_connections c ON c.tenant_id = m.tenant_id
     WHERE c.status = 'connected' AND m.included AND m.status = 'ok' AND (c.kind = 'workspace' OR m.refresh_token_enc IS NOT NULL) AND m.last_synced_at < now() - interval '3 hours'`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0];
  if (mail.n) problems.push(`${mail.n} connected Gmail mailbox${mail.n === 1 ? ' hasn’t' : 'es haven’t'} been read in over 3 hours.`);
  return problems;
}

async function runCheck({ alert = require('./alerting').sendCrashAlert, now = Date.now() } = {}) {
  const problems = await check(now).catch(e => [`The self-check itself failed: ${e.message}`]);
  const fresh = problems.filter(p => { const k = p.replace(/\d+/g, '#'); if (now - (told.get(k) || 0) < RETELL_MS) return false; told.set(k, now); return true; });
  if (fresh.length) await alert('Eagle I self-check', fresh.join('\n\n'));
  return problems;
}

let timer = null;
function startHealthWatch() {
  if (timer) return;
  timer = setInterval(() => runCheck().catch(() => {}), 30 * 60000);
  if (timer.unref) timer.unref();
}

module.exports = { beat, check, runCheck, startHealthWatch, _beats: beats };
