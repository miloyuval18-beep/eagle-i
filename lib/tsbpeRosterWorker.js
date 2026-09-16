// Automatically re-imports the TSBPE Responsible Master Plumber list once
// a month — same shape and reasoning as lib/tbaeRosterWorker.js and
// lib/tdlrRosterWorker.js.
const { getLastImportCompletedAt, runFullImport } = require('./tsbpeRegistrants');

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

    console.log('[tsbpeRosterWorker] Monthly TSBPE refresh starting...');
    const result = await runFullImport({ log: (msg) => console.log('[tsbpeRosterWorker]', msg) });
    console.log('[tsbpeRosterWorker] Done —', result.total, 'total records.');
  } catch (err) {
    console.error('[tsbpeRosterWorker] tick failed:', err.message);
  } finally {
    running = false;
  }
}

function startTsbpeRosterWorker() {
  if (pollerStarted) return;
  pollerStarted = true;
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}

module.exports = { startTsbpeRosterWorker };
