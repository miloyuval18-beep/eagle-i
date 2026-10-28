/* Eagle I CRM: the daily check-in as a short chat with Eagle I.
   - crm_checkins: the day's chat (its assistant thread), where it stands, and the
     summary written when it's done (what was done on which project, problems, next).
   - crm_checkin_problems: problems raised in check-ins, until someone handles them.
   - crm_checkin_digests: the owners' and admins' end-of-day summary, once a day.
   - crm_ai_threads.kind: check-in chats stay out of the Ask chat list. */
exports.up = (pgm) => {
  pgm.addColumns('crm_checkins', {
    thread_id: { type: 'uuid', references: 'crm_ai_threads', onDelete: 'SET NULL' },
    status: { type: 'varchar(10)', notNull: true, default: 'sent' }, // sent | started | done
    opener: { type: 'text' },
    started_at: { type: 'timestamptz' },
    completed_at: { type: 'timestamptz' },
    summary: { type: 'jsonb' }
  }, { ifNotExists: true });
  pgm.alterColumn('crm_checkins', 'sent_at', { allowNull: true });
  pgm.addColumns('crm_ai_threads', { kind: { type: 'varchar(16)' } }, { ifNotExists: true });
  pgm.createTable('crm_checkin_problems', {
    id: { type: 'bigserial', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    checkin_id: { type: 'uuid', references: 'crm_checkins', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    deal_id: { type: 'uuid', references: 'crm_deals', onDelete: 'SET NULL' },
    project: { type: 'text' },
    text: { type: 'text', notNull: true },
    urgent: { type: 'boolean', notNull: true, default: false },
    handled_at: { type: 'timestamptz' },
    handled_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.createIndex('crm_checkin_problems', ['tenant_id', 'handled_at', 'created_at'], { ifNotExists: true });
  pgm.createTable('crm_checkin_digests', {
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    day: { type: 'date', notNull: true },
    sent_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.addConstraint('crm_checkin_digests', 'crm_checkin_digests_pk', { primaryKey: ['tenant_id', 'day'] });
};
exports.down = (pgm) => {
  pgm.dropTable('crm_checkin_digests', { ifExists: true });
  pgm.dropTable('crm_checkin_problems', { ifExists: true });
  pgm.dropColumns('crm_ai_threads', ['kind'], { ifExists: true });
  pgm.dropColumns('crm_checkins', ['thread_id', 'status', 'opener', 'started_at', 'completed_at', 'summary'], { ifExists: true });
};
