/* Eagle I CRM: the team calendar (lib/crmCalendar.js).

   Most of what's on the calendar is read from records that already have a
   date (site visits, phases, tasks, deliveries, invoices, selections, bids,
   scheduled emails, warranties...). This table holds the rest: meetings,
   inspections and other appointments someone adds, or that Eagle I finds in
   the team's email ("the inspector will be out Thursday at 10").

   And a person can choose to see their own Google Calendar on it, which needs
   the sign-in to remember they asked for that. */
exports.up = (pgm) => {
  pgm.createTable('crm_events', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    deal_id: { type: 'uuid', references: 'crm_deals', onDelete: 'cascade' },
    user_id: { type: 'uuid', references: 'users', onDelete: 'set null' }, // whose it is; null = the whole company
    kind: { type: 'varchar(12)', notNull: true, default: 'meeting' }, // meeting | inspection | delivery | walkthrough | other
    title: { type: 'text', notNull: true },
    starts_at: { type: 'timestamptz', notNull: true },
    ends_at: { type: 'timestamptz', notNull: true },
    all_day: { type: 'boolean', notNull: true, default: false },
    location: { type: 'text' },
    notes: { type: 'text' },
    source: { type: 'varchar(10)', notNull: true, default: 'manual' }, // manual | email | assistant
    source_key: { type: 'text' }, // for found ones: never add the same one twice
    mail_thread_id: { type: 'bigint', references: 'crm_mail_threads', onDelete: 'set null' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'set null' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.createIndex('crm_events', ['tenant_id', 'starts_at'], { ifNotExists: true });
  pgm.createIndex('crm_events', ['tenant_id', 'source_key'], { name: 'crm_events_source_key', unique: true, where: 'source_key IS NOT NULL', ifNotExists: true });
  pgm.addColumns('crm_google_oauth_states', { want_calendar: { type: 'boolean', notNull: true, default: false } }, { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropColumns('crm_google_oauth_states', ['want_calendar'], { ifExists: true });
  pgm.dropTable('crm_events', { ifExists: true });
};
