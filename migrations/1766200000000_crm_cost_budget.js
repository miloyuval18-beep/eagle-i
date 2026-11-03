// A job's expected total cost when it has no accepted estimate (a job brought in from
// before Eagle I): the budget the cost forecast and projected margin use (lib/crmForecast.js).
exports.up = (pgm) => { pgm.addColumns('crm_deals', { cost_budget: { type: 'numeric(14,2)' } }); };
exports.down = (pgm) => { pgm.dropColumns('crm_deals', ['cost_budget'], { ifExists: true }); };
