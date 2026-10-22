/* Eagle I CRM: bringing in more than customers (lib/crmImport.js).

   Exports from Buildertrend, JobTread, CoConstruct, Houzz Pro, QuickBooks or
   any spreadsheet: subs and vendors, job schedules, tasks, catalog items,
   past invoices and site logs. Every row an import adds is marked with it,
   so the whole import can be undone in one tap. */
exports.up = (pgm) => {
  pgm.addColumns('crm_imports', {
    kind: { type: 'varchar(20)', notNull: true, default: 'customers' },
    platform: { type: 'text' },
    updated: { type: 'integer', notNull: true, default: 0 }
  }, { ifNotExists: true });
  for (const t of ['crm_vendors', 'crm_job_items', 'crm_tasks', 'crm_catalog_items', 'crm_invoices', 'crm_daily_logs']) {
    pgm.addColumns(t, { import_id: { type: 'uuid', references: 'crm_imports', onDelete: 'set null' } }, { ifNotExists: true });
  }
};

exports.down = (pgm) => {
  for (const t of ['crm_vendors', 'crm_job_items', 'crm_tasks', 'crm_catalog_items', 'crm_invoices', 'crm_daily_logs']) pgm.dropColumns(t, ['import_id'], { ifExists: true });
  pgm.dropColumns('crm_imports', ['kind', 'platform', 'updated'], { ifExists: true });
};
