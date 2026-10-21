// A real calendar day written YYYY-MM-DD. The shape alone isn't enough:
// JavaScript turns "2026-02-30" into March 2 while Postgres rejects it, so
// the day must come back unchanged from a round trip through a Date.
// Used as DAY.test(value), like the regex it replaces.
const SHAPE = /^\d{4}-\d{2}-\d{2}$/;
function test(v) {
  const s = String(v == null ? '' : v);
  if (!SHAPE.test(s)) return false;
  const d = new Date(s + 'T12:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
module.exports = { test };
