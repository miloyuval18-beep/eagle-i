// Automatically re-imports the TDLR electrician/A-C-contractor data once
// a month — same shape and reasoning as lib/tbaeRosterWorker.js (a single
// global job, daily tick, 30-day due-check against tdlr_import_state, and
// safe to automate because upsertRegistrants preserves every registrant's
// already-collected website/contact_email).
const { getLastImportCompletedAt, runFullImport } = require('./tdlrRegistrants');

const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const REIMPORT_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let pollerStarted = false;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const lastCompleted = await getLastImportCompletedAt();
    const due = !lastCompleted || (Date.now() - new Date(lastCompleted).getTime()) >= REIMPORT_INTERVAL_MS;
    if (!due) return;

    console.log('[tdlrRosterWorker] Monthly TDLR refresh starting...');
    const counts = await runFullImport({ log: (msg) => console.log('[tdlrRosterWorker]', msg) });
    console.log('[tdlrRosterWorker] Done —', counts);
  } catch (err) {
    console.error('[tdlrRosterWorker] tick failed:', err.message);
  } finally {
    running = false;
  }
}

function startTdlrRosterWorker() {
  if (pollerStarted) return;
  pollerStarted = true;
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}

module.exports = { startTdlrRosterWorker };
