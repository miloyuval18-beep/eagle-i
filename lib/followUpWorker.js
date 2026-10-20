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
    // 7am: each person's morning email. Early morning: rain on outdoor work.
    const dg = await require('./crmDaily').processDigests();
    if (dg.sent) console.log('[crmDaily] digests', JSON.stringify(dg));
    const wx = await require('./crmDaily').scanWeather();
    if (wx.flagged) console.log('[crmDaily] weather', JSON.stringify(wx));
    // Subs confirm their dates three days out.
    const sc = await require('./crmSubs').processConfirmations();
    if (sc.asked || sc.flagged) console.log('[crmSubs]', JSON.stringify(sc));
    // 5pm on weekdays: "what did you get done today?"
    const ci = await require('./crmCheckins').processCheckins();
    if (ci.sent) console.log('[crmCheckins]', JSON.stringify(ci));
    // Quiet deals get a suggested next move; overdue invoices get a reminder drafted.
    const coach = require('./crmCoach');
    const sa = await coach.adviseStalled();
    if (sa.advised) console.log('[crmCoach] next moves', JSON.stringify(sa));
    const cn = await coach.scanCollections();
    if (cn.drafted) console.log('[crmCoach] reminders drafted', JSON.stringify(cn));
    // Customer emails from the company's Google Workspace onto their deals.
    const gs = await require('./crmGoogle').processGoogleSync();
    if (gs.mailboxes) console.log('[crmGoogle]', JSON.stringify(gs));
    const gb = await require('./crmGoogle').backfillBodies();
    if (gb.filled) console.log('[crmGoogle] email text', JSON.stringify(gb));
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
