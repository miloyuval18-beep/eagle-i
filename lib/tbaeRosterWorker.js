// Automatically re-imports the TBAE architect/interior-designer rosters
// once a month, so new registrants get picked up without a developer
// remembering to run scripts/importTbaeRoster.js by hand. This is a
// single GLOBAL job (one roster serves every tenant), not per-tenant
// like lib/competitorRatingWorker.js, so it needs no per-tenant claim —
// just the same running-guard + daily-tick shape as
// lib/scheduledPostsWorker.js, checking once a day whether 30 days have
// passed since the last completed import (lib/tbaeRegistrants.js's
// tbae_import_state log).
//
// Safe to run unattended: the roster download itself is free (a public
// .xlsx file, no per-call API cost), and the upsert-by-reg_no in
// upsertRegistrantsForProfession preserves every registrant's already-
// collected Places contact data — a monthly re-import never forces a
// re-check of firms that were already looked up.
const { getLastImportCompletedAt, runFullImport } = require('./tbaeRegistrants');

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

    console.log('[tbaeRosterWorker] Monthly TBAE roster refresh starting...');
    const counts = await runFullImport({ log: (msg) => console.log('[tbaeRosterWorker]', msg) });
    console.log(`[tbaeRosterWorker] Done — ${counts.architect || 0} architects, ${counts.interior_designer || 0} interior designers parsed.`);
  } catch (err) {
    console.error('[tbaeRosterWorker] tick failed:', err.message);
  } finally {
    running = false;
  }
}

function startTbaeRosterWorker() {
  if (pollerStarted) return;
  pollerStarted = true;
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}

module.exports = { startTbaeRosterWorker };
