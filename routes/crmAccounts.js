// Eagle I CRM accounts (lib/crmAccounts.js): creating one of the four kinds,
// signing in at /crm/login, a homeowner's or sub's own page (/crm/home),
// and, for the owner and admins, letting in people who asked to join.
const express = require('express');
const path = require('path');
const { requireAuth, deviceOf } = require('../auth');
const acc = require('../lib/crmAccounts');
const team = require('../lib/crmTeam');

const router = express.Router();
const baseUrlOf = (req) => `${req.protocol}://${req.get('host')}`;
function fail(res, err, what) {
  if (/invalid input syntax for type uuid/.test(err.message || '')) return res.status(404).json({ error: { message: 'Not found.' } });
  const status = err.status || 500;
  res.status(status).json({ error: { message: status === 500 ? `${what}: ${err.message}` : err.message } });
}
const wrap = (what, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, what); } };

// A fresh session for whoever signed in: a company login, or a homeowner/sub account.
function start(req, who) {
  return new Promise((resolve, reject) => req.session.regenerate((e) => {
    if (e) return reject(e);
    if (who.as === 'staff') { req.session.userId = who.id; req.session.tenantId = who.tenantId; }
    else { req.session.accountId = who.id; req.session.accountKind = who.as; }
    req.session.device = deviceOf(req);
    resolve();
  }));
}
const whereTo = (as) => as === 'staff' ? '/crm' : '/crm/home';

// Signing in (also reached from /api/auth/login with app: 'crm').
async function crmLogin(req, res) {
  const { email, password, as } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: { message: 'Enter your email and password.' } });
  try {
    const r = await acc.signIn({ email, password, as: ['staff', 'homeowner', 'sub'].includes(as) ? as : null });
    if (r.choose) return res.json({ choose: r.choose });
    await start(req, r);
    res.json({ ok: true, go: whereTo(r.as) });
  } catch (err) { fail(res, err, 'Sign-in failed'); }
}
router.post('/api/crm-auth/login', crmLogin);

// { type: 'company' | 'join' | 'homeowner' | 'sub', ... }
router.post('/api/crm-auth/signup', wrap('Couldn’t create the account', async (req, res) => {
  const b = req.body || {};
  if (!b.acceptedTerms) return res.status(400).json({ error: { message: 'Tick the box to agree to the Terms of Service and Privacy Policy.' } });
  const baseUrl = baseUrlOf(req);
  if (b.type === 'company') {
    const r = await acc.createCompany({ companyName: b.companyName, name: b.name, email: b.email, password: b.password, phone: b.phone, baseUrl });
    await start(req, { as: 'staff', id: r.user.id, tenantId: r.user.tenant_id });
    return res.json({ ok: true, go: '/crm' });
  }
  if (b.type === 'join') {
    const r = await acc.requestJoin({ code: b.code, name: b.name, email: b.email, password: b.password, note: b.note, baseUrl });
    if (r.pending) return res.json({ ok: true, pending: true, companyName: r.companyName });
    await start(req, { as: 'staff', id: r.user.id, tenantId: r.user.tenant_id });
    return res.json({ ok: true, go: '/crm', companyName: r.companyName });
  }
  if (acc.KINDS.includes(b.type)) {
    const r = await acc.createAccount({ kind: b.type, name: b.name, email: b.email, password: b.password, phone: b.phone, businessName: b.businessName, trade: b.trade, baseUrl });
    await start(req, { as: b.type, id: r.account.id });
    return res.json({ ok: true, go: '/crm/home', emailed: r.emailed });
  }
  res.status(400).json({ error: { message: 'Pick what kind of account you need.' } });
}));

// "Continue with Google": the same Google sign-in Eagle I already uses for Gmail
// (same return address), so nothing new has to be set up at Google.
const redirectUri = (req) => process.env.GOOGLE_CRM_REDIRECT_URI || `${baseUrlOf(req)}/api/crm/google/oauth/callback`;
router.post('/api/crm-auth/google/start', wrap('Couldn’t start Google sign-in', async (req, res) => {
  const b = req.body || {};
  if (b.type !== 'signin' && !b.acceptedTerms) return res.status(400).json({ error: { message: 'Tick the box to agree to the Terms of Service and Privacy Policy.' } });
  res.json({ url: await acc.googleStart({ type: b.type, companyName: b.companyName, code: b.code, businessName: b.businessName, trade: b.trade, phone: b.phone, redirectUri: redirectUri(req) }) });
}));
// Mounted ahead of the CRM's sign-in check (routes/crm.js): a sign-up has no session yet.
async function googleCallback(req, res, next) {
  try { if (!(await acc.isSignupState(req.query.state))) return next(); } catch (e) { return next(); }
  try {
    const r = await acc.googleFinish({ code: req.query.code, state: req.query.state, error: req.query.error, redirectUri: redirectUri(req), baseUrl: baseUrlOf(req) });
    if (r.pending) return res.redirect('/crm/login?pending=' + encodeURIComponent(r.companyName));
    await start(req, r);
    res.redirect(whereTo(r.as));
  } catch (err) {
    res.redirect('/crm/login?google_error=' + encodeURIComponent(err.message));
  }
}

// "Join Levi Homes?" before they fill everything in.
router.get('/api/crm-auth/company-code', wrap('Couldn’t check the code', async (req, res) => {
  const t = await acc.companyForCode(req.query.code);
  if (!t) return res.status(404).json({ error: { message: 'That code doesn’t match a company. It looks like ABCD-2345; check it with whoever gave it to you.' } });
  res.json({ companyName: t.company_name, code: acc.tidyCode(req.query.code) });
}));

// The link in the "confirm your email" message for homeowners and subs.
router.get('/crm/verify', wrap('Couldn’t confirm', async (req, res) => {
  const a = await acc.verifyAccount(req.query.token);
  res.redirect(a ? '/crm/home?confirmed=1' : '/crm/home?confirmed=0');
}));

// ---------- a homeowner's or sub's own page ----------

function account(req, res, next) {
  if (!req.session || !req.session.accountId) return res.status(401).json({ error: { message: 'Not signed in.' } });
  req.accountId = req.session.accountId;
  next();
}
router.get('/crm/home', (req, res) => {
  if (!req.session || !req.session.accountId) return res.redirect(req.session && req.session.userId ? '/crm' : '/crm/login');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '..', 'public', 'crm-home.html'));
});
router.get('/api/crm-account', account, wrap('Couldn’t load your account', async (req, res) => {
  const h = await acc.home(req.accountId, baseUrlOf(req));
  res.json(h);
}));
router.patch('/api/crm-account', account, wrap('Couldn’t save', async (req, res) => {
  const b = req.body || {};
  res.json({ account: await acc.saveProfile(req.accountId, b, { done: !!b.done }) });
}));
router.post('/api/crm-account/link', account, wrap('Couldn’t add it', async (req, res) => {
  res.json(await acc.linkByUrl(req.accountId, (req.body || {}).url));
}));
router.post('/api/crm-account/resend', account, wrap('Couldn’t send it', async (req, res) => {
  res.json(await acc.sendAccountVerify(req.accountId, baseUrlOf(req)));
}));
router.post('/api/crm-account/password', account, wrap('Couldn’t change it', async (req, res) => {
  await acc.changePassword({ accountId: req.accountId, current: (req.body || {}).current, password: (req.body || {}).password });
  res.json({ ok: true });
}));

// ---------- for the owner and admins: the company code and join requests ----------
// (/api/crm/* sits behind routes/crm.js's sign-in and company check.)

const managersOnly = team.need('team');
router.get('/api/crm/join-code', requireAuth, managersOnly, wrap('Couldn’t load the code', async (req, res) => {
  res.json({ code: await acc.joinCode(req.tenantId), requests: await acc.listJoinRequests(req.tenantId) });
}));
router.post('/api/crm/join-code/new', requireAuth, managersOnly, wrap('Couldn’t make a new code', async (req, res) => {
  res.json({ code: await acc.joinCode(req.tenantId, { fresh: true }) });
}));
router.post('/api/crm/join-requests/:id', requireAuth, managersOnly, wrap('Couldn’t save', async (req, res) => {
  const b = req.body || {};
  res.json(await acc.decideJoin({ tenantId: req.tenantId, actor: req.crmUser, id: req.params.id, approve: !!b.approve, role: b.role || 'member', reportsTo: b.reportsTo || null, baseUrl: baseUrlOf(req) }));
}));

// ---------- the quick way through setup (lib/crmQuickSetup.js) ----------
const quick = require('../lib/crmQuickSetup');
router.get('/api/crm/setup/company-lookup', requireAuth, team.need('settings'), wrap('Couldn’t look it up', async (req, res) => {
  res.json(await quick.lookup({ tenantId: req.tenantId, userId: req.userId }));
}));
router.get('/api/crm/setup/from-email', requireAuth, wrap('Couldn’t read your email', async (req, res) => {
  res.json({ ...(await quick.scan({ tenantId: req.tenantId, userId: req.userId, fresh: req.query.fresh === '1' })), canAddSubs: team.can(req.crmUser, 'subs') });
}));
router.post('/api/crm/setup/from-email', requireAuth, wrap('Couldn’t add them', async (req, res) => {
  const b = req.body || {};
  if ((b.subs || []).length && !team.can(req.crmUser, 'subs')) return res.status(403).json({ error: { message: team.denyText('subs') } });
  res.json(await quick.addFound({ tenantId: req.tenantId, userId: req.userId, customers: b.customers, subs: b.subs }));
}));
// { people: [{ name, email, role }] } or { text: 'one per line' }
router.post('/api/crm/team/invites/bulk', requireAuth, team.need('team'), wrap('Couldn’t send the invitations', async (req, res) => {
  const b = req.body || {};
  const people = Array.isArray(b.people) ? b.people : quick.parseList(b.text).map(p => ({ ...p, role: b.role || 'member' }));
  res.json(await quick.inviteMany({ tenantId: req.tenantId, actor: req.crmUser, people, baseUrl: baseUrlOf(req) }));
}));
router.get('/api/crm/setup/emails', requireAuth, team.need('emails'), wrap('Couldn’t load them', async (req, res) => res.json({ emails: await quick.recommended(req.tenantId) })));
router.post('/api/crm/setup/emails', requireAuth, team.need('emails'), wrap('Couldn’t turn them on', async (req, res) => res.json(await quick.turnOn({ tenantId: req.tenantId, ids: (req.body || {}).ids }))));

module.exports = router;
module.exports.crmLogin = crmLogin;
module.exports.googleCallback = googleCallback;
