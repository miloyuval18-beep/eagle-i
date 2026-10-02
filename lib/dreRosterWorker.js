// Automatically re-imports the California real estate broker list (DRE) once a
// month -- same shape as the other roster workers. Only the markets we serve
// are stored (see lib/markets.js), so it is cheap and the file streams through.
const { getLastImportCompletedAt, runFullImport } = require('./dreRegistrants');

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

    console.log('[dreRosterWorker] Monthly refresh starting...');
    const result = await runFullImport({ log: (msg) => console.log('[dreRosterWorker]', msg) });
    console.log('[dreRosterWorker] Done --', result.total, 'records.');
  } catch (err) {
    console.error('[dreRosterWorker] tick failed:', err.message);
  } finally {
    running = false;
  }
}

function startDreRosterWorker() {
  if (pollerStarted) return;
  pollerStarted = true;
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}

module.exports = { startDreRosterWorker };
