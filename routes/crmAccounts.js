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

module.exports = router;
module.exports.crmLogin = crmLogin;
