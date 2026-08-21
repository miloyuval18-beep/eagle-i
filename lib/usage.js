// Shared per-tenant monthly generation cap, used by both the live client
// proxy (routes/claude.js) and the server-side onboarding generation pass
// (routes/onboarding.js) so all Claude usage counts against the same limit.
const { query } = require('../db');

function currentMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Returns { allowed, used, cap }. Increments the counter only when allowed.
// capColumn/counterColumn are internal constants (never user input), so
// interpolating them into SQL below is safe.
async function checkAndIncrementCounter(tenantId, { capColumn, counterColumn }) {
  const month = currentMonth();
  const tenantRes = await query(`SELECT ${capColumn} AS cap FROM tenants WHERE id = $1`, [tenantId]);
  const cap = tenantRes.rows[0] ? tenantRes.rows[0].cap : 0;

  const existing = await query(
    `SELECT ${counterColumn} AS used FROM usage_counters WHERE tenant_id = $1 AND month = $2`,
    [tenantId, month]
  );
  const used = existing.rows[0] ? existing.rows[0].used : 0;

  if (used >= cap) return { allowed: false, used, cap };

  await query(
    `INSERT INTO usage_counters (tenant_id, month, ${counterColumn})
     VALUES ($1, $2, 1)
     ON CONFLICT (tenant_id, month)
     DO UPDATE SET ${counterColumn} = usage_counters.${counterColumn} + 1`,
    [tenantId, month]
  );
  return { allowed: true, used: used + 1, cap };
}

const checkAndIncrementUsage = (tenantId) =>
  checkAndIncrementCounter(tenantId, { capColumn: 'monthly_generation_cap', counterColumn: 'generation_count' });

const checkAndIncrementPlacesUsage = (tenantId) =>
  checkAndIncrementCounter(tenantId, { capColumn: 'monthly_places_lookup_cap', counterColumn: 'places_lookup_count' });

module.exports = { checkAndIncrementUsage, checkAndIncrementPlacesUsage, currentMonth };
