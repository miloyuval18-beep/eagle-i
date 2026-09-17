// Automatically re-imports the TDI escrow-officer data once a month —
// same shape as the other roster workers.
const { getLastImportCompletedAt, runFullImport } = require('./tdiRegistrants');

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

    console.log('[tdiRosterWorker] Monthly TDI refresh starting...');
    const result = await runFullImport({ log: (msg) => console.log('[tdiRosterWorker]', msg) });
    console.log('[tdiRosterWorker] Done —', result.total, 'total records.');
  } catch (err) {
    console.error('[tdiRosterWorker] tick failed:', err.message);
  } finally {
    running = false;
  }
}

function startTdiRosterWorker() {
  if (pollerStarted) return;
  pollerStarted = true;
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}

module.exports = { startTdiRosterWorker };
