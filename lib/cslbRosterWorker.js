// Automatically re-imports the California contractor license list (CSLB) once a
// month -- same shape as the other roster workers. Only the markets we serve
// are stored (see lib/markets.js), so it is cheap and the file streams through.
const { getLastImportCompletedAt, runFullImport } = require('./cslbContractors');

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

    console.log('[cslbRosterWorker] Monthly refresh starting...');
    const result = await runFullImport({ log: (msg) => console.log('[cslbRosterWorker]', msg) });
    console.log('[cslbRosterWorker] Done --', result.total, 'records.');
  } catch (err) {
    console.error('[cslbRosterWorker] tick failed:', err.message);
  } finally {
    running = false;
  }
}

function startCslbRosterWorker() {
  if (pollerStarted) return;
  pollerStarted = true;
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}

module.exports = { startCslbRosterWorker };
