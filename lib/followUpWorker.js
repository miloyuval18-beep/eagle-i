// Background tick that sends due follow-ups (see lib/followUps.js). Same shape
// as the other workers: a module-level guard so ticks never overlap.
const { processDueFollowUps } = require('./followUps');
const { processDueQueue } = require('./outreachQueue');
const { processDueReminders } = require('./reviewReminders');
const { processMonthlyReports } = require('./monthlyReport');
const { refreshPending } = require('./sendingDomain');
const crm = require('./crm');
const crmPlaybooks = require('./crmPlaybooks');

const TICK_MS = 5 * 60 * 1000;
let started = false;
let running = false;

let tickStartedAt = 0;
async function tick() {
  // Never two at once, but a tick stuck for 20 minutes (a call that never
  // answered) mustn't stop every email and reminder for good.
  if (running && Date.now() - tickStartedAt < 20 * 60 * 1000) return;
  if (running) console.error('[followUpWorker] previous tick stuck for 20+ minutes; starting a new one');
  running = true;
  tickStartedAt = Date.now();
  try {
    // Scheduled first emails go before follow-ups, so a follow-up never beats the email it follows.
    const q = await processDueQueue();
    if (q.claimed) console.log('[outreachQueue]', JSON.stringify(q));
    const s = await processDueFollowUps();
    if (s.claimed) console.log('[followUps]', JSON.stringify(s));
    const rr = await processDueReminders();
    if (rr.claimed) console.log('[reviewReminders]', JSON.stringify(rr));
    const mr = await processMonthlyReports();
    if (mr.checked) console.log('[monthlyReport]', JSON.stringify(mr));
    const sd = await refreshPending();
    if (sd.checked) console.log('[sendingDomain]', JSON.stringify(sd));
    // The pipeline: automatic emails, the "Needs you" check, and Monday's weekly summary.
    const cp = await crmPlaybooks.processDueSends();
    if (cp.claimed) console.log('[crmPlaybooks]', JSON.stringify(cp));
    const ce = await crm.scanExceptions();
    if (ce.waiting || ce.stalled) console.log('[crm] needs-you', JSON.stringify(ce));
    // Monday's weekly report (successes, challenges, the team) for companies on the CRM.
    const ws = await require('./crmReports').processWeeklyReports();
    if (ws.sent) console.log('[crm] weekly reports', JSON.stringify(ws));
    // Subs whose insurance runs out within 30 days.
    const vi = await require('./crmJobs').scanVendorInsurance();
    if (vi.flagged) console.log('[crmJobs] insurance', JSON.stringify(vi));
    // Home-file care reminders and warranty check-ins.
    const hc = await require('./crmLifetime').scanHomeCare();
    if (hc.care || hc.warranty) console.log('[crmLifetime]', JSON.stringify(hc));
    // On the 2nd: a nudge to enter last month's marketing spend.
    const sr = await require('./crmMarketing').scanSpendReminder();
    if (sr.reminded) console.log('[crmMarketing]', JSON.stringify(sr));
    // Fridays: this week's homeowner update drafted for every job underway.
    const wu = await require('./crmAssist').processWeeklyUpdates();
    if (wu.drafted) console.log('[crmAssist] weekly updates', JSON.stringify(wu));
    // Every two weeks during construction: "how is it going?" to the homeowner.
    const hp = await require('./crmPulse').processPulses();
    if (hp.sent) console.log('[crmPulse]', JSON.stringify(hp));
    // Email watch: follow-ups for unanswered emails, reminders for unanswered ones.
    const ew = await require('./crmEmailWatch').processWatch().catch(e => { console.error('[crmEmailWatch] failed:', e.message); return {}; });
    // The recycle bin keeps things 30 days (lib/crmTrash.js).
    await require('./crmTrash').purge().catch(e => console.error('[crmTrash] purge failed:', e.message));
    if (ew.followups || ew.autoSent || ew.reminders || ew.escalated) console.log('[crmEmailWatch]', JSON.stringify(ew));
    // 7am: each person's morning email. Early morning: rain on outdoor work.
    const dg = await require('./crmDaily').processDigests();
    if (dg.sent) console.log('[crmDaily] digests', JSON.stringify(dg));
    const wx = await require('./crmDaily').scanWeather();
    if (wx.flagged) console.log('[crmDaily] weather', JSON.stringify(wx));
    // Subs confirm their dates three days out.
    const sc = await require('./crmSubs').processConfirmations();
    if (sc.asked || sc.flagged) console.log('[crmSubs]', JSON.stringify(sc));
    // 3:30pm on weekdays: the daily check-in email; 6pm: the owners' and admins' summary of the day.
    const ci = await require('./crmCheckins').processCheckins();
    if (ci.sent) console.log('[crmCheckins]', JSON.stringify(ci));
    const cd = await require('./crmCheckins').processTeamDigest();
    if (cd.sent) console.log('[crmCheckins] team summary', JSON.stringify(cd));
    // Price this project: reminders the day prices are due; the estimate built once they're in.
    const pz = await require('./crmPricing').processPricing().catch(e => { console.error('[crmPricing] failed:', e.message); return {}; });
    if (pz.built || pz.reminded || pz.stuck) console.log('[crmPricing]', JSON.stringify(pz));
    // Quiet deals get a suggested next move; overdue invoices get a reminder drafted.
    const coach = require('./crmCoach');
    const sa = await coach.adviseStalled();
    if (sa.advised) console.log('[crmCoach] next moves', JSON.stringify(sa));
    const cn = await coach.scanCollections();
    if (cn.drafted) console.log('[crmCoach] reminders drafted', JSON.stringify(cn));
    // Signed jobs: requests that sound like change orders, cost and schedule outlook, photo checks.
    const cc = await require('./crmChangeCatcher').scanForChanges();
    if (cc.caught) console.log('[crmChangeCatcher]', JSON.stringify(cc));
    const fc = await require('./crmForecast').scanJobs();
    if (fc.flagged) console.log('[crmForecast]', JSON.stringify(fc));
    const ph = await require('./crmPhotoAi').scanPhotos();
    if (ph.checked) console.log('[crmPhotoAi]', JSON.stringify(ph));
    // Customer emails from the company's Google Workspace onto their deals.
    const gs = await require('./crmGoogle').processGoogleSync();
    if (gs.mailboxes) console.log('[crmGoogle]', JSON.stringify(gs));
    // Project files to and from the company's Google Drive.
    const dv = await require('./crmDrive').processDriveSync();
    if (dv.pushed || dv.added || dv.updated || dv.removed || dv.errors) console.log('[crmDrive]', JSON.stringify(dv));
    const gb = await require('./crmGoogle').backfillBodies();
    if (gb.filled) console.log('[crmGoogle] email text', JSON.stringify(gb));
  } catch (err) {
    console.error('[followUps] tick failed:', err.message);
  } finally {
    running = false;
    require('./crmHealth').beat('followUpWorker'); // the self-check watches this (lib/crmHealth.js)
  }
}

function startFollowUpWorker() {
  if (started) return;
  started = true;
  setTimeout(tick, 60 * 1000); // first check a minute after boot, then every 5
  setInterval(tick, TICK_MS);
}

module.exports = { startFollowUpWorker, tick };
