// Automatically re-imports the TDA pest-control-business list once a
// month — same shape as the other roster workers.
const { getLastImportCompletedAt, runFullImport } = require('./tdaRegistrants');

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

    console.log('[tdaRosterWorker] Monthly TDA refresh starting...');
    const result = await runFullImport({ log: (msg) => console.log('[tdaRosterWorker]', msg) });
    console.log('[tdaRosterWorker] Done —', result.total, 'total records.');
  } catch (err) {
    console.error('[tdaRosterWorker] tick failed:', err.message);
  } finally {
    running = false;
  }
}

function startTdaRosterWorker() {
  if (pollerStarted) return;
  pollerStarted = true;
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}

module.exports = { startTdaRosterWorker };
