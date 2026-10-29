// "Price this project" (lib/crmPricing.js): from the plans on a deal to a priced
// estimate. A run holds what Eagle I read from the plans (scope of work, material
// takeoff, a rough budget), the packages it splits the work into (a trade for a sub,
// or a list of materials for a supplier) with the vendors picked for each, and,
// once the prices are in, the best price per package and the estimate it built.
// Each price request is an ordinary bid request (crm_bid_requests) that also knows
// its run, its package and the lines it asks to be priced.
exports.up = (pgm) => {
  pgm.createTable('crm_pricing_runs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    deal_id: { type: 'uuid', notNull: true, references: 'crm_deals', onDelete: 'cascade' },
    status: { type: 'varchar(10)', notNull: true, default: 'reading' }, // reading | review | waiting | priced | failed
    file_ids: { type: 'uuid[]', notNull: true, default: '{}' },
    notes: { type: 'text' },
    scope: { type: 'jsonb' },      // { summary, sections: [{ trade, work: [..] }], exclusions, assumptions, questions }
    materials: { type: 'jsonb' },  // [{ i, name, spec, quantity, unit, trade, how, confidence, rough }]
    packages: { type: 'jsonb' },   // [{ key, kind: sub|supplier, trade, label, search, items, scope, rough, vendors: [...] }]
    rough_total: { type: 'numeric(14,2)' },
    due_date: { type: 'date' },
    result: { type: 'jsonb' },     // the best price per package, once priced
    estimate_id: { type: 'uuid', references: 'crm_estimates', onDelete: 'set null' },
    error: { type: 'text' },
    handed_off_at: { type: 'timestamptz' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'set null' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    read_at: { type: 'timestamptz' },
    sent_at: { type: 'timestamptz' },
    priced_at: { type: 'timestamptz' }
  });
  pgm.createIndex('crm_pricing_runs', ['deal_id', 'created_at']);
  pgm.createIndex('crm_pricing_runs', ['status']);

  pgm.addColumns('crm_bid_requests', {
    run_id: { type: 'uuid', references: 'crm_pricing_runs', onDelete: 'set null' },
    package_key: { type: 'text' },
    lines: { type: 'jsonb' },        // what they're asked to price: [{ i, name, spec, quantity, unit }]
    line_prices: { type: 'jsonb' },  // their answer: [{ i, unit_price, total, note }]
    quote_source: { type: 'varchar(8)' }, // page | email
    lead_time: { type: 'text' },
    reminded_at: { type: 'timestamptz' }
  });
  pgm.createIndex('crm_bid_requests', ['run_id']);

  pgm.addColumns('crm_vendors', {
    website: { type: 'text' },
    found_via: { type: 'varchar(12)' } // google: found by Eagle I nearby
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('crm_vendors', ['website', 'found_via']);
  pgm.dropColumns('crm_bid_requests', ['run_id', 'package_key', 'lines', 'line_prices', 'quote_source', 'lead_time', 'reminded_at']);
  pgm.dropTable('crm_pricing_runs');
};
