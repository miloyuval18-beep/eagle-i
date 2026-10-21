/* Eagle I CRM: a page for subs.

   1. Each sub (vendor) gets one private link to every job they're on.
   2. Files can be shared with the subs on a job. Plans and selection sheets
      are shared with them by default (that's what they need to do the work);
      anything else is the team's to share.
   3. What subs ask on their page, and whether it went to the team. */
exports.up = (pgm) => {
  pgm.addColumns('crm_vendors', { portal_token: { type: 'varchar(48)', unique: true } }, { ifNotExists: true });
  pgm.addColumns('crm_files', { sub_shared: { type: 'boolean', notNull: true, default: false } }, { ifNotExists: true });
  pgm.sql(`UPDATE crm_files SET sub_shared = true WHERE folder IN ('plans', 'selections') AND from_homeowner = false`);
  pgm.createTable('crm_sub_questions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    vendor_id: { type: 'uuid', notNull: true, references: 'crm_vendors', onDelete: 'cascade' },
    deal_id: { type: 'uuid', references: 'crm_deals', onDelete: 'set null' },
    question: { type: 'text', notNull: true },
    answer: { type: 'text' },
    forwarded: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.createIndex('crm_sub_questions', ['vendor_id', 'created_at'], { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropTable('crm_sub_questions', { ifExists: true });
  pgm.dropColumns('crm_files', ['sub_shared'], { ifExists: true });
  pgm.dropColumns('crm_vendors', ['portal_token'], { ifExists: true });
};
