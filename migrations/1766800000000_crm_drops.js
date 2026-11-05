// The drop box on Home (lib/crmDrop.js): each file dropped there, what Eagle I decided it
// is, where it put it and what it filled in, so it can be undone or moved. The file's
// bytes are kept a week (to move it), then cleared.
exports.up = (pgm) => {
  pgm.createTable('crm_drops', {
    id: { type: 'bigserial', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    filename: { type: 'text', notNull: true },
    content_type: { type: 'text' },
    size: { type: 'integer' },
    data: { type: 'bytea' },
    kind: { type: 'varchar(30)' },
    deal_id: { type: 'uuid', references: 'crm_deals', onDelete: 'SET NULL' },
    status: { type: 'varchar(20)', notNull: true, default: 'done' }, // done | needs_project | import | undone | failed
    summary: { type: 'text' },
    read: { type: 'jsonb' }, // what the AI read
    refs: { type: 'jsonb' }, // what was made: { fileIds, costId, permitId, permitBefore, vendorNames, vendorBefore }
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    undone_at: { type: 'timestamptz' }
  }, { ifNotExists: true });
  pgm.createIndex('crm_drops', ['tenant_id', 'user_id', 'created_at'], { ifNotExists: true });
};
exports.down = (pgm) => { pgm.dropTable('crm_drops', { ifExists: true }); };
