/* Eagle I CRM: the recycle bin (lib/crmTrash.js).

   Before anything is deleted, a full copy of it and everything that hangs off
   it (a deal's tasks, notes, files, estimates, invoices...) is kept here for
   30 days so it can be put back exactly as it was. Archived subs, products,
   partners and catalog items are listed here too, and "restore" un-archives. */
exports.up = (pgm) => {
  pgm.createTable('crm_trash', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    kind: { type: 'varchar(20)', notNull: true }, // deal | phase | cost | estimate | chat | event | ... (what it was)
    label: { type: 'text', notNull: true }, // what people see in the bin
    mode: { type: 'varchar(8)', notNull: true, default: 'deleted' }, // deleted | archived
    root_table: { type: 'text', notNull: true },
    root_id: { type: 'text', notNull: true },
    rows: { type: 'jsonb' }, // [{ t: table, r: row }], parents first
    relinks: { type: 'jsonb' }, // [{ t, col, id, val }]: links that were cleared and come back on restore
    deleted_by: { type: 'uuid', references: 'users', onDelete: 'set null' },
    deleted_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.createIndex('crm_trash', ['tenant_id', 'deleted_at'], { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropTable('crm_trash', { ifExists: true });
};
