// Scenario scripts write and delete real rows, so they only ever run against a
// database on this machine (never the production DATABASE_URL in .env).
const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
  console.error('Scenarios need DATABASE_URL pointing at a local Postgres (localhost). Refusing to run.');
  process.exit(2);
}
if (!process.env.PGSSL) process.env.PGSSL = 'false';
const R = require('path').join(__dirname, '..', '..');
// The end of the day now, for one company: each person's one email with what was held for them (lib/crmTeamMail.js).
// (The tests' made-up .test addresses are allowed while it runs; real made-up addresses never get email.)
const endOfDay = async (tenantId, opts = {}) => {
  const was = process.env.CRM_EMAIL_TEST_ADDRESSES;
  process.env.CRM_EMAIL_TEST_ADDRESSES = opts.realTestFilter ? (was || '') : '1';
  try { return await require(R + '/lib/crmTeamMail').processEndOfDay({ force: true, tenantId, appUrl: 'https://app.test', ...opts }); }
  finally { if (was === undefined) delete process.env.CRM_EMAIL_TEST_ADDRESSES; else process.env.CRM_EMAIL_TEST_ADDRESSES = was; }
};
module.exports = { R, endOfDay };
