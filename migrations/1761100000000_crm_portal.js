/* Eagle I CRM, step 8: files, photos and the homeowner portal.

   1. Files on a deal (photos, PDFs), each marked whether the homeowner can
      see it in their portal. Photos the homeowner uploads are shared by
      default.
   2. Each deal can have a private portal link (/p/<token>) for the homeowner.
   3. Updates the team posts to the portal (with optional photos), which can
      also be emailed to the homeowner. */
exports.up = (pgm) => {
  pgm.createTable('crm_files', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    deal_id: { type: 'uuid', notNull: true, references: 'crm_deals', onDelete: 'cascade' },
    filename: { type: 'text', notNull: true },
    content_type: { type: 'text', notNull: true },
    size: { type: 'integer', notNull: true },
    data: { type: 'bytea', notNull: true },
    caption: { type: 'text' },
    shared: { type: 'boolean', notNull: true, default: false },
    uploaded_by: { type: 'uuid', references: 'users', onDelete: 'set null' },
    from_homeowner: { type: 'boolean', notNull: true, default: false },
    update_id: { type: 'uuid' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('crm_files', ['deal_id', 'created_at']);

  pgm.addColumns('crm_deals', {
    portal_token: { type: 'varchar(48)', unique: true }
  }, { ifNotExists: true });

  pgm.createTable('crm_portal_updates', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    deal_id: { type: 'uuid', notNull: true, references: 'crm_deals', onDelete: 'cascade' },
    body: { type: 'text', notNull: true },
    created_by: { type: 'uuid', references: 'users', onDelete: 'set null' },
    emailed_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('crm_portal_updates', ['deal_id', 'created_at']);
};

exports.down = (pgm) => {
  pgm.dropTable('crm_portal_updates');
  pgm.dropColumns('crm_deals', ['portal_token'], { ifExists: true });
  pgm.dropTable('crm_files');
};
