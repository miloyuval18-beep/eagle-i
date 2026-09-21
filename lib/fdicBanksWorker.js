// Automatically re-imports the FDIC bank list
// once a month — same shape as the other roster workers, plus the
// importer's own active/inactive maintenance (see
// lib/fdicBanks.js's runFullImport).
const { getLastImportCompletedAt, runFullImport } = require('./fdicBanks');

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

    console.log('[fdicBanksWorker] Monthly FDIC bank refresh starting...');
    const result = await runFullImport({ log: (msg) => console.log('[fdicBanksWorker]', msg) });
    console.log('[fdicBanksWorker] Done —', result.total, 'institutions.');
  } catch (err) {
    console.error('[fdicBanksWorker] tick failed:', err.message);
  } finally {
    running = false;
  }
}

function startFdicBanksWorker() {
  if (pollerStarted) return;
  pollerStarted = true;
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}

module.exports = { startFdicBanksWorker };
