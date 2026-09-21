// Automatically re-imports the TDI insurance-agency list once a month —
// same shape as the other roster workers.
const { getLastImportCompletedAt, runFullImport } = require('./tdiAgencies');

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

    console.log('[tdiAgenciesWorker] Monthly TDI agency refresh starting...');
    const result = await runFullImport({ log: (msg) => console.log('[tdiAgenciesWorker]', msg) });
    console.log('[tdiAgenciesWorker] Done —', result.total, 'agencies.');
  } catch (err) {
    console.error('[tdiAgenciesWorker] tick failed:', err.message);
  } finally {
    running = false;
  }
}

function startTdiAgenciesWorker() {
  if (pollerStarted) return;
  pollerStarted = true;
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}

module.exports = { startTdiAgenciesWorker };
