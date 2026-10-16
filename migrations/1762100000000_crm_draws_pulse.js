/* Eagle I CRM, step 18: getting paid on schedule, and hearing early when a
   homeowner is unhappy.

   1. Draws: a job's payment milestones, each a share of the contract (or "the
      rest"), tied to a phase of the schedule or to the job being complete.
      Finishing that phase makes the invoice.
   2. Pulses: the short "how is it going?" check-in homeowners get during
      construction, with their 1-5 answer and comment. */
exports.up = (pgm) => {
  pgm.createTable('crm_draws', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    deal_id: { type: 'uuid', notNull: true, references: 'crm_deals', onDelete: 'cascade' },
    title: { type: 'text', notNull: true },
    pct: { type: 'numeric(5,2)' }, // share of the contract; null = whatever is left
    trigger_item_id: { type: 'uuid', references: 'crm_job_items', onDelete: 'set null' },
    on_complete: { type: 'boolean', notNull: true, default: false },
    position: { type: 'integer', notNull: true, default: 0 },
    invoice_id: { type: 'uuid', references: 'crm_invoices', onDelete: 'set null' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.createIndex('crm_draws', ['deal_id', 'position'], { ifNotExists: true });

  pgm.createTable('crm_pulses', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    deal_id: { type: 'uuid', notNull: true, references: 'crm_deals', onDelete: 'cascade' },
    token: { type: 'varchar(48)', notNull: true, unique: true },
    sent_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    score: { type: 'smallint' },
    comment: { type: 'text' },
    answered_at: { type: 'timestamptz' }
  }, { ifNotExists: true });
  pgm.createIndex('crm_pulses', ['deal_id', 'sent_at'], { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropTable('crm_pulses', { ifExists: true });
  pgm.dropTable('crm_draws', { ifExists: true });
};
