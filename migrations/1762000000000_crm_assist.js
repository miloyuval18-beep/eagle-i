/* Eagle I CRM, step 17: getting set up and the AI helpers.

   1. Imports from old tools: each import is recorded, and the deals it made
      point back to it, so an import can be undone in one step.
   2. The weekly homeowner update Eagle I drafts for each job, waiting for the
      team to read over and post. */
exports.up = (pgm) => {
  pgm.createTable('crm_imports', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    filename: { type: 'text' },
    rows: { type: 'integer', notNull: true, default: 0 },
    deals_created: { type: 'integer', notNull: true, default: 0 },
    skipped: { type: 'integer', notNull: true, default: 0 },
    mapping: { type: 'jsonb' },
    user_id: { type: 'uuid', references: 'users', onDelete: 'set null' },
    undone_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.addColumns('crm_deals', {
    import_id: { type: 'uuid', references: 'crm_imports', onDelete: 'set null' },
    update_draft: { type: 'text' },
    update_draft_at: { type: 'timestamptz' }
  }, { ifNotExists: true });
  pgm.createIndex('crm_deals', 'import_id', { where: 'import_id IS NOT NULL', ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropColumns('crm_deals', ['import_id', 'update_draft', 'update_draft_at'], { ifExists: true });
  pgm.dropTable('crm_imports', { ifExists: true });
};
