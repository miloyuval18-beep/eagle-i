/* Eagle I CRM, step 6: weekly reports. One saved report per company per
   week: the facts it was written from and the written summary (successes,
   challenges, the team, and what to focus on), so it can be read again in
   the app. */
exports.up = (pgm) => {
  pgm.createTable('crm_weekly_reports', {
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    week_start: { type: 'date', notNull: true },
    facts: { type: 'jsonb', notNull: true },
    narrative: { type: 'jsonb', notNull: true },
    written_by: { type: 'varchar(10)', notNull: true, default: 'ai' }, // ai | rules
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('crm_weekly_reports', 'crm_weekly_reports_pk', { primaryKey: ['tenant_id', 'week_start'] });
};

exports.down = (pgm) => {
  pgm.dropTable('crm_weekly_reports');
};
