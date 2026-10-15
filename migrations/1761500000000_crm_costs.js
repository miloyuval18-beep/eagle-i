/* Eagle I CRM, step 12: job costing. What each job actually cost: bills,
   receipts (read by AI from a photo), purchase orders once received, labor
   and anything else, by category, so it can be compared with the budget. */
exports.up = (pgm) => {
  pgm.createTable('crm_costs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    deal_id: { type: 'uuid', notNull: true, references: 'crm_deals', onDelete: 'cascade' },
    vendor_id: { type: 'uuid', references: 'crm_vendors', onDelete: 'set null' },
    vendor_name: { type: 'text' },
    category: { type: 'varchar(20)', notNull: true, default: 'materials' }, // labor | materials | subcontract | equipment | permits | other
    description: { type: 'text' },
    amount: { type: 'numeric(14,2)', notNull: true },
    cost_date: { type: 'date', notNull: true },
    hours: { type: 'numeric(8,2)' },
    rate: { type: 'numeric(10,2)' },
    source: { type: 'varchar(10)', notNull: true, default: 'manual' }, // manual | receipt | po | labor
    po_id: { type: 'uuid', references: 'crm_purchase_orders', onDelete: 'set null' },
    file_id: { type: 'uuid', references: 'crm_files', onDelete: 'set null' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'set null' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('crm_costs', ['deal_id', 'cost_date']);
  pgm.createIndex('crm_costs', 'po_id', { name: 'crm_costs_po_once', unique: true, where: 'po_id IS NOT NULL' });
};

exports.down = (pgm) => {
  pgm.dropTable('crm_costs');
};
