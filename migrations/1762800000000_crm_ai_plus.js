/* Eagle I CRM: the rest of the AI features.

 1. Estimates: a written proposal (cover letter, scope in words, what's
    included and not, timeline) and the last "check this estimate" review.
 2. Change-order catcher: things a homeowner asked for in an email, a portal
    message or a site log that sound like a change, waiting to be priced.
 3. Photos: what phase each job photo shows, and things worth a second look.
 4. Punch lists from a walkthrough (video frames or photos).
 5. Takeoffs read from plans, checked by the estimator line by line.
 6. A product catalog (photos and prices) for selections.
 7. Bills matched to purchase orders.
 8. Cost forecasts and schedule risk per job, kept so a flag is raised once.
 9. Per-person coaching notes.
10. Design visuals (an edited room photo) and portal questions, for limits
    and a record of what was said.
11. Which emails, messages and logs have already been read for changes. */
exports.up = (pgm) => {
  pgm.addColumns('crm_estimates', {
    proposal: { type: 'jsonb' },
    proposal_at: { type: 'timestamptz' },
    review: { type: 'jsonb' },
    review_at: { type: 'timestamptz' }
  }, { ifNotExists: true });

  pgm.createTable('crm_ai_scanned', {
    kind: { type: 'varchar(24)', notNull: true },
    ref: { type: 'text', notNull: true },
    at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.addConstraint('crm_ai_scanned', 'crm_ai_scanned_pk', { primaryKey: ['kind', 'ref'] });

  pgm.createTable('crm_co_suggestions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    deal_id: { type: 'uuid', notNull: true, references: 'crm_deals', onDelete: 'cascade' },
    source: { type: 'varchar(10)', notNull: true }, // email | portal | log
    source_ref: { type: 'text', notNull: true },
    quote: { type: 'text' },
    title: { type: 'text', notNull: true },
    description: { type: 'text' },
    amount: { type: 'numeric(14,2)' },
    cost: { type: 'numeric(14,2)' },
    days_added: { type: 'integer', notNull: true, default: 0 },
    priced_from: { type: 'text' },
    status: { type: 'varchar(10)', notNull: true, default: 'open' }, // open | drafted | dismissed
    change_order_id: { type: 'uuid', references: 'crm_change_orders', onDelete: 'set null' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.createIndex('crm_co_suggestions', ['deal_id', 'status'], { ifNotExists: true });

  pgm.addColumns('crm_files', {
    ai_tags: { type: 'jsonb' }, // { phase, notes: [...], checks: [...] }
    ai_at: { type: 'timestamptz' }
  }, { ifNotExists: true });

  pgm.createTable('crm_punch_items', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    deal_id: { type: 'uuid', notNull: true, references: 'crm_deals', onDelete: 'cascade' },
    location: { type: 'text' },
    issue: { type: 'text', notNull: true },
    trade: { type: 'text' },
    status: { type: 'varchar(8)', notNull: true, default: 'open' }, // open | done
    shared: { type: 'boolean', notNull: true, default: true },
    file_id: { type: 'uuid', references: 'crm_files', onDelete: 'set null' },
    position: { type: 'integer', notNull: true, default: 0 },
    created_by: { type: 'uuid', references: 'users', onDelete: 'set null' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    done_at: { type: 'timestamptz' }
  }, { ifNotExists: true });
  pgm.createIndex('crm_punch_items', ['deal_id', 'position'], { ifNotExists: true });

  pgm.createTable('crm_takeoffs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    deal_id: { type: 'uuid', notNull: true, references: 'crm_deals', onDelete: 'cascade' },
    file_id: { type: 'uuid', references: 'crm_files', onDelete: 'set null' },
    status: { type: 'varchar(8)', notNull: true, default: 'draft' }, // draft | added
    scale: { type: 'text' },
    notes: { type: 'text' },
    items: { type: 'jsonb', notNull: true, default: '[]' },
    estimate_id: { type: 'uuid', references: 'crm_estimates', onDelete: 'set null' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'set null' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.createIndex('crm_takeoffs', 'deal_id', { ifNotExists: true });

  pgm.createTable('crm_products', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    name: { type: 'text', notNull: true },
    category: { type: 'text', notNull: true },
    brand: { type: 'text' },
    price: { type: 'numeric(12,2)', notNull: true, default: 0 },
    unit: { type: 'varchar(12)', notNull: true, default: 'ea' },
    style: { type: 'text' },
    link: { type: 'text' },
    photo: { type: 'bytea' },
    photo_type: { type: 'text' },
    archived: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.createIndex('crm_products', ['tenant_id', 'archived'], { ifNotExists: true });

  pgm.addColumns('crm_costs', {
    matched_po_id: { type: 'uuid', references: 'crm_purchase_orders', onDelete: 'set null' },
    match_note: { type: 'text' }
  }, { ifNotExists: true });

  pgm.createTable('crm_forecasts', {
    deal_id: { type: 'uuid', primaryKey: true, references: 'crm_deals', onDelete: 'cascade' },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    cost: { type: 'jsonb' },
    risk: { type: 'jsonb' },
    at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });

  pgm.createTable('crm_coaching', {
    user_id: { type: 'uuid', primaryKey: true, references: 'users', onDelete: 'cascade' },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    data: { type: 'jsonb', notNull: true },
    at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });

  pgm.createTable('crm_visuals', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    deal_id: { type: 'uuid', notNull: true, references: 'crm_deals', onDelete: 'cascade' },
    source_file_id: { type: 'uuid', references: 'crm_files', onDelete: 'set null' },
    result_file_id: { type: 'uuid', references: 'crm_files', onDelete: 'set null' },
    prompt: { type: 'text', notNull: true },
    created_by: { type: 'uuid', references: 'users', onDelete: 'set null' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.createIndex('crm_visuals', ['tenant_id', 'created_at'], { ifNotExists: true });

  pgm.createTable('crm_portal_questions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    deal_id: { type: 'uuid', notNull: true, references: 'crm_deals', onDelete: 'cascade' },
    question: { type: 'text', notNull: true },
    answer: { type: 'text' },
    forwarded: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.createIndex('crm_portal_questions', ['deal_id', 'created_at'], { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropTable('crm_portal_questions', { ifExists: true });
  pgm.dropTable('crm_visuals', { ifExists: true });
  pgm.dropTable('crm_coaching', { ifExists: true });
  pgm.dropTable('crm_forecasts', { ifExists: true });
  pgm.dropColumns('crm_costs', ['matched_po_id', 'match_note'], { ifExists: true });
  pgm.dropTable('crm_products', { ifExists: true });
  pgm.dropTable('crm_takeoffs', { ifExists: true });
  pgm.dropTable('crm_punch_items', { ifExists: true });
  pgm.dropColumns('crm_files', ['ai_tags', 'ai_at'], { ifExists: true });
  pgm.dropTable('crm_co_suggestions', { ifExists: true });
  pgm.dropTable('crm_ai_scanned', { ifExists: true });
  pgm.dropColumns('crm_estimates', ['proposal', 'proposal_at', 'review', 'review_at'], { ifExists: true });
};
