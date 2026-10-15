/* Eagle I CRM, step 11: running the job.

   1. Schedule: the job's phases with start/end dates and who's on them,
      some shown to the homeowner.
   2. Daily logs from the site (shared ones also appear in the portal).
   3. Subs and vendors, with license and insurance expiry.
   4. Purchase orders to vendors.
   5. Change orders the homeowner approves in the portal.
   6. Selections with allowances the homeowner picks in the portal. */
exports.up = (pgm) => {
  pgm.createTable('crm_job_items', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    deal_id: { type: 'uuid', notNull: true, references: 'crm_deals', onDelete: 'cascade' },
    title: { type: 'text', notNull: true },
    start_date: { type: 'date' },
    end_date: { type: 'date' },
    status: { type: 'varchar(8)', notNull: true, default: 'todo' }, // todo | doing | done
    assignee_user_id: { type: 'uuid', references: 'users', onDelete: 'set null' },
    vendor_id: { type: 'uuid' },
    show_homeowner: { type: 'boolean', notNull: true, default: true },
    position: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('crm_job_items', ['deal_id', 'position']);

  pgm.createTable('crm_daily_logs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    deal_id: { type: 'uuid', notNull: true, references: 'crm_deals', onDelete: 'cascade' },
    log_date: { type: 'date', notNull: true },
    body: { type: 'text', notNull: true },
    crew: { type: 'text' },
    shared: { type: 'boolean', notNull: true, default: false },
    user_id: { type: 'uuid', references: 'users', onDelete: 'set null' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('crm_daily_logs', ['deal_id', 'log_date']);

  pgm.createTable('crm_vendors', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    name: { type: 'text', notNull: true },
    trade: { type: 'text' },
    contact_name: { type: 'text' },
    email: { type: 'text' },
    phone: { type: 'text' },
    license_no: { type: 'text' },
    insurance_expires: { type: 'date' },
    notes: { type: 'text' },
    archived: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('crm_vendors', ['tenant_id', 'archived']);

  pgm.createTable('crm_purchase_orders', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    deal_id: { type: 'uuid', notNull: true, references: 'crm_deals', onDelete: 'cascade' },
    vendor_id: { type: 'uuid', references: 'crm_vendors', onDelete: 'set null' },
    number: { type: 'integer', notNull: true },
    title: { type: 'text', notNull: true },
    lines: { type: 'jsonb', notNull: true, default: '[]' }, // [{ description, quantity, unit_cost }]
    total: { type: 'numeric(14,2)', notNull: true, default: 0 },
    category: { type: 'varchar(20)', notNull: true, default: 'materials' }, // for job costing
    status: { type: 'varchar(10)', notNull: true, default: 'draft' }, // draft | sent | received | void
    needed_by: { type: 'date' },
    note: { type: 'text' },
    sent_at: { type: 'timestamptz' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'set null' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('crm_purchase_orders', 'crm_purchase_orders_tenant_number', { unique: ['tenant_id', 'number'] });
  pgm.createIndex('crm_purchase_orders', 'deal_id');

  pgm.createTable('crm_change_orders', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    deal_id: { type: 'uuid', notNull: true, references: 'crm_deals', onDelete: 'cascade' },
    number: { type: 'integer', notNull: true },
    title: { type: 'text', notNull: true },
    description: { type: 'text' },
    amount: { type: 'numeric(14,2)', notNull: true, default: 0 }, // change to the contract price (can be negative)
    cost: { type: 'numeric(14,2)', notNull: true, default: 0 }, // what it costs the company (job costing)
    days_added: { type: 'integer', notNull: true, default: 0 },
    status: { type: 'varchar(10)', notNull: true, default: 'draft' }, // draft | sent | approved | declined | void
    selection_id: { type: 'uuid' },
    sent_at: { type: 'timestamptz' },
    approved_at: { type: 'timestamptz' },
    approved_name: { type: 'text' },
    approved_ip: { type: 'text' },
    declined_at: { type: 'timestamptz' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'set null' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('crm_change_orders', 'crm_change_orders_tenant_number', { unique: ['tenant_id', 'number'] });
  pgm.createIndex('crm_change_orders', 'deal_id');

  pgm.createTable('crm_selections', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    deal_id: { type: 'uuid', notNull: true, references: 'crm_deals', onDelete: 'cascade' },
    category: { type: 'text', notNull: true },
    allowance: { type: 'numeric(14,2)', notNull: true, default: 0 },
    due_date: { type: 'date' },
    options: { type: 'jsonb', notNull: true, default: '[]' }, // [{ name, price, note }]
    chosen_index: { type: 'integer' },
    chosen_at: { type: 'timestamptz' },
    note: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('crm_selections', 'deal_id');
};

exports.down = (pgm) => {
  pgm.dropTable('crm_selections');
  pgm.dropTable('crm_change_orders');
  pgm.dropTable('crm_purchase_orders');
  pgm.dropTable('crm_vendors');
  pgm.dropTable('crm_daily_logs');
  pgm.dropTable('crm_job_items');
};
