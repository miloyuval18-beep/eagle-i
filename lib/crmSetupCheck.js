// Setup reminders in Eagle I CRM: each time someone opens the CRM, the important
// things not set up yet, for their company (if they're allowed to set it up) and
// for them, most important first, each with a plain step-by-step guide and a
// button to the right screen (crm.html crSetupRemind). Anything they say their
// company doesn't need ("We don't need this") stops being shown to them.
const { query } = require('../db');
const team = require('./crmTeam');

// key: [who can fix it (a permission, or null for everyone), title, why, steps, where the button goes, its label]
const ITEMS = {
  google: ['settings', 'Connect your company’s email', 'So every email with a customer or sub lands on the right job by itself, and replies stop the follow-ups.',
    ['Open Account → Company details.', 'Find “Google: email & Drive”.', 'Tap “Sign in with Google” and sign in with the company’s Google account (for example admin@ your company).', 'Leave every box ticked when Google asks, and tap Allow.'], 'company-google', 'Open Company details'],
  address: ['settings', 'Add your business address', 'Automatic emails to customers wait until it’s filled in (the law requires it at the bottom of marketing email).',
    ['Open Account → Company details.', 'Type the business address (street, city, state, ZIP).', 'Tap Save.'], 'company-address', 'Open Company details'],
  contact: ['settings', 'Add the company phone and email', 'They go on every estimate, invoice and email Eagle I sends, so customers know how to reach you.',
    ['Open Account → Company details.', 'Fill in the company phone, and the email customer replies should go to.', 'Tap Save.'], 'company-address', 'Open Company details'],
  projects: ['data', 'Add your projects', 'Eagle I can only schedule, price, check in on and report on projects it knows about.',
    ['Open the Pipeline and tap “＋ Add a deal” for each customer or project, or', 'Bring them all in at once: Account → Import & setup, then pick the spreadsheet you exported from Buildertrend, JobTread, QuickBooks or Excel.', 'For a signed job, open it and tap “Open the job” to set its schedule and project manager.'], 'import', 'Bring in my projects'],
  team: ['team', 'Invite your team', 'Each person gets their own daily check-in and sees their own jobs, so the reports cover everyone.',
    ['Open Account → Team.', 'Type each person’s name and email, and pick their role (project managers as “Project manager”).', 'Tap Send. Each gets an email with a link to join.'], 'team', 'Open Team'],
  vendors: ['subs', 'Add your subs and suppliers', 'Eagle I asks them for prices first when it prices a project, and puts them on the schedule.',
    ['Open Jobs → Subs and vendors and tap “＋ Add”, or', 'Bring in a list: Account → Import & setup, then pick the spreadsheet.', 'Give each one their trade (Plumbing, Lumber…) and email, so the right ones are asked for prices.'], 'vendors', 'Open subs and vendors'],
  drive: ['settings', 'Switch on Google Drive', 'Keeps every job’s plans and files in your Google Drive, lets Eagle I find plans already in it, and allows bigger files (50 MB).',
    ['Open Account → Company details and find “Google Drive”.', 'Tap “Sign in and allow Google Drive” and sign in with the Google account that holds your project files. Leave the Drive box ticked.', 'Back in Eagle I, tap “Switch on Google Drive”.'], 'company-drive', 'Open Company details'],
  emails: ['emails', 'Turn on automatic emails', 'Follow-ups, reminders and thank-yous go to customers at the right moment by themselves, so nothing slips.',
    ['Open Account → Automations.', 'Read each email’s wording and change anything you like.', 'Tap “Approve and turn on” on the ones you want.'], 'auto', 'Open Automations'],
  my_gmail: [null, 'Connect your own email', 'So your emails with customers and subs land on the right jobs, and Eagle I can tell you who’s waiting on an answer.',
    ['Tap the button below.', 'Tap “Connect my Gmail” and sign in with your work Google account.', 'Leave every box ticked when Google asks, and tap Allow.'], 'company-google', 'Connect my email'],
  name: [null, 'Add your name', 'It goes on your emails and check-ins, so people know who they’re hearing from.',
    ['Open Account → Guided setup (or tap below).', 'Type your name and phone, and tap Save and continue.'], 'start', 'Add my name']
};
const ORDER = ['google', 'address', 'projects', 'team', 'vendors', 'contact', 'drive', 'emails', 'my_gmail', 'name'];

// What's missing for this person, most important first.
async function check(user) {
  const t = user.tenant_id;
  const one = async (sql, args = [t]) => (await query(sql, args)).rows[0] || {};
  const [bp, conn, counts, mine, me] = await Promise.all([
    one(`SELECT address, phone, email FROM business_profile WHERE tenant_id = $1`),
    one(`SELECT kind, status, drive_on FROM crm_google_connections WHERE tenant_id = $1`),
    one(`SELECT (SELECT COUNT(*) FROM crm_deals WHERE tenant_id = $1)::int AS deals, (SELECT COUNT(*) FROM crm_vendors WHERE tenant_id = $1 AND archived = false)::int AS vendors,
      (SELECT COUNT(*) FROM users WHERE tenant_id = $1 AND disabled_at IS NULL AND app IN ('crm', 'both') AND NOT checkin_excluded)::int AS people,
      (SELECT COUNT(*) FROM crm_invites WHERE tenant_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now())::int AS invites`),
    one(`SELECT COUNT(*)::int AS n FROM crm_mailboxes WHERE tenant_id = $1 AND connected_by = $2 AND refresh_token_enc IS NOT NULL`, [t, user.id]),
    one(`SELECT name, setup_skips FROM users WHERE id = $1`, [user.id])
  ]);
  const connected = conn.status === 'connected';
  const autos = await require('./crmQuickSetup').recommended(t).catch(() => []);
  const missing = {
    google: !connected,
    address: String(bp.address || '').trim().length < 8,
    contact: !bp.phone || !bp.email,
    projects: !counts.deals,
    team: counts.people <= 1 && !counts.invites,
    vendors: !counts.vendors,
    drive: connected && !conn.drive_on,
    emails: autos.length > 0 && !autos.some(a => a.on),
    // Their own Gmail: only where each person signs in (a Workspace connection reads everyone's).
    my_gmail: connected && conn.kind === 'signin' && !mine.n,
    name: !String(me.name || '').trim()
  };
  const skips = new Set(me.setup_skips || []);
  return ORDER.filter(k => missing[k] && !skips.has(k)).filter(k => { const p = ITEMS[k][0]; return !p || team.can(user, p); })
    // The company's Google covers their own email when it's the same step.
    .filter((k, _, all) => !(k === 'my_gmail' && all.includes('google')))
    .map(k => { const [, title, why, steps, go, button] = ITEMS[k]; return { key: k, title, why, steps, go, button }; });
}

async function skip(userId, key) {
  if (!ITEMS[key]) { const e = new Error('Unknown item.'); e.status = 400; throw e; }
  await query(`UPDATE users SET setup_skips = array_append(setup_skips, $2) WHERE id = $1 AND NOT ($2 = ANY(setup_skips))`, [userId, key]);
  return { ok: true };
}
async function unskipAll(userId) { await query(`UPDATE users SET setup_skips = '{}' WHERE id = $1`, [userId]); return { ok: true }; }

module.exports = { ITEMS, ORDER, check, skip, unskipAll };
