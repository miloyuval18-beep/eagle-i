// Scenario scripts write and delete real rows, so they only ever run against a
// database on this machine (never the production DATABASE_URL in .env).
const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
  console.error('Scenarios need DATABASE_URL pointing at a local Postgres (localhost). Refusing to run.');
  process.exit(2);
}
if (!process.env.PGSSL) process.env.PGSSL = 'false';
module.exports = { R: require('path').join(__dirname, '..', '..') };
