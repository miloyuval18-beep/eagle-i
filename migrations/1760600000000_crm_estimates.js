/* Eagle I CRM, step 3: estimates.

   1. A cost catalog: the company's own items (labor, materials,
      subcontractors) with a unit cost and markup, reused across estimates.
   2. Estimates on a deal: line items with cost and markup (the homeowner only
      ever sees prices), a total, optional deposit, terms and an expiry date.
      Each has an unguessable link the homeowner opens to view, download and
      accept or decline it online.
   An accepted design agreement moves the deal to "In design"; an accepted
   construction estimate moves it to "Contract signed". */
exports.up = (pgm) => {
  pgm.createTable('crm_catalog_items', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    name: { type: 'text', notNull: true },
    description: { type: 'text' },
    category: { type: 'varchar(20)', notNull: true, default: 'materials' }, // labor | materials | subcontract | allowance | other
    unit: { type: 'varchar(12)', notNull: true, default: 'ea' },
    unit_cost: { type: 'numeric(12,2)', notNull: true, default: 0 },
    markup_pct: { type: 'numeric(6,2)' }, // null = the estimate's default markup
    archived: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('crm_catalog_items', ['tenant_id', 'archived']);

  pgm.createTable('crm_estimates', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    deal_id: { type: 'uuid', notNull: true, references: 'crm_deals', onDelete: 'cascade' },
    number: { type: 'integer', notNull: true },
    kind: { type: 'varchar(20)', notNull: true, default: 'construction' }, // design_agreement | construction
    title: { type: 'text', notNull: true },
    intro: { type: 'text' },
    terms: { type: 'text' },
    status: { type: 'varchar(12)', notNull: true, default: 'draft' }, // draft | sent | accepted | declined
    default_markup_pct: { type: 'numeric(6,2)', notNull: true, default: 20 },
    tax_pct: { type: 'numeric(6,3)', notNull: true, default: 0 },
    deposit_pct: { type: 'numeric(6,2)', notNull: true, default: 0 },
    show_line_prices: { type: 'boolean', notNull: true, default: true },
    valid_until: { type: 'date' },
    cost_total: { type: 'numeric(14,2)', notNull: true, default: 0 },
    subtotal: { type: 'numeric(14,2)', notNull: true, default: 0 },
    tax: { type: 'numeric(14,2)', notNull: true, default: 0 },
    total: { type: 'numeric(14,2)', notNull: true, default: 0 },
    public_token: { type: 'varchar(64)', notNull: true, unique: true },
    sent_at: { type: 'timestamptz' },
    sent_to: { type: 'text' },
    first_viewed_at: { type: 'timestamptz' },
    view_count: { type: 'integer', notNull: true, default: 0 },
    accepted_at: { type: 'timestamptz' },
    accepted_name: { type: 'text' },
    accepted_ip: { type: 'text' },
    declined_at: { type: 'timestamptz' },
    decline_reason: { type: 'text' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'set null' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('crm_estimates', 'crm_estimates_tenant_number_unique', { unique: ['tenant_id', 'number'] });
  pgm.createIndex('crm_estimates', 'deal_id');

  pgm.createTable('crm_estimate_lines', {
    id: { type: 'bigserial', primaryKey: true },
    estimate_id: { type: 'uuid', notNull: true, references: 'crm_estimates', onDelete: 'cascade' },
    position: { type: 'integer', notNull: true },
    section: { type: 'text' },
    description: { type: 'text', notNull: true },
    quantity: { type: 'numeric(12,3)', notNull: true, default: 1 },
    unit: { type: 'varchar(12)', notNull: true, default: 'ea' },
    unit_cost: { type: 'numeric(12,2)', notNull: true, default: 0 },
    markup_pct: { type: 'numeric(6,2)', notNull: true, default: 0 },
    price: { type: 'numeric(14,2)', notNull: true, default: 0 },
    catalog_item_id: { type: 'uuid', references: 'crm_catalog_items', onDelete: 'set null' }
  });
  pgm.createIndex('crm_estimate_lines', ['estimate_id', 'position']);
};

exports.down = (pgm) => {
  pgm.dropTable('crm_estimate_lines');
  pgm.dropTable('crm_estimates');
  pgm.dropTable('crm_catalog_items');
};
