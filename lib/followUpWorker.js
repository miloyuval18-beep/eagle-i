// Background tick that sends due follow-ups (see lib/followUps.js). Same shape
// as the other workers: a module-level guard so ticks never overlap.
const { processDueFollowUps } = require('./followUps');
const { processDueQueue } = require('./outreachQueue');
const { processDueReminders } = require('./reviewReminders');

const TICK_MS = 5 * 60 * 1000;
let started = false;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    // Scheduled first emails go before follow-ups, so a follow-up never beats the email it follows.
    const q = await processDueQueue();
    if (q.claimed) console.log('[outreachQueue]', JSON.stringify(q));
    const s = await processDueFollowUps();
    if (s.claimed) console.log('[followUps]', JSON.stringify(s));
    const rr = await processDueReminders();
    if (rr.claimed) console.log('[reviewReminders]', JSON.stringify(rr));
  } catch (err) {
    console.error('[followUps] tick failed:', err.message);
  } finally {
    running = false;
  }
}

function startFollowUpWorker() {
  if (started) return;
  started = true;
  setTimeout(tick, 60 * 1000); // first check a minute after boot, then every 5
  setInterval(tick, TICK_MS);
}

module.exports = { startFollowUpWorker, tick };
