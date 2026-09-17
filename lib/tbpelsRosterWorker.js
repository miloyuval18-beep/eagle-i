// Automatically re-imports the TBPELS engineering/surveying firm roster
// once a month — same shape as lib/tbaeRosterWorker.js / lib/tdlrRosterWorker.js.
const { getLastImportCompletedAt, runFullImport } = require('./tbpelsRegistrants');

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

    console.log('[tbpelsRosterWorker] Monthly TBPELS refresh starting...');
    const result = await runFullImport({ log: (msg) => console.log('[tbpelsRosterWorker]', msg) });
    console.log('[tbpelsRosterWorker] Done —', result.total, 'total firms.');
  } catch (err) {
    console.error('[tbpelsRosterWorker] tick failed:', err.message);
  } finally {
    running = false;
  }
}

function startTbpelsRosterWorker() {
  if (pollerStarted) return;
  pollerStarted = true;
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}

module.exports = { startTbpelsRosterWorker };
