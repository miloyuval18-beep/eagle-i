// Automatically re-imports the Comptroller sales-tax-permit trade list
// once a month — same shape as the other roster workers, plus the
// importer's own active/inactive maintenance (see
// lib/comptrollerTrades.js's runFullImport).
const { getLastImportCompletedAt, runFullImport } = require('./comptrollerTrades');

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

    console.log('[comptrollerTradesWorker] Monthly Comptroller trade refresh starting...');
    const result = await runFullImport({ log: (msg) => console.log('[comptrollerTradesWorker]', msg) });
    console.log('[comptrollerTradesWorker] Done —', result.total, 'businesses.');
  } catch (err) {
    console.error('[comptrollerTradesWorker] tick failed:', err.message);
  } finally {
    running = false;
  }
}

function startComptrollerTradesWorker() {
  if (pollerStarted) return;
  pollerStarted = true;
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}

module.exports = { startComptrollerTradesWorker };
