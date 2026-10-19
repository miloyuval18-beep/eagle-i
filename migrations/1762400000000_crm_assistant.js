/* Eagle I CRM, step 21: the assistant.

   1. Conversations with "Ask Eagle I": each person's threads, every message
      exactly as the model saw it, and what it showed them.
   2. Actions waiting for a person's OK (anything that emails someone outside
      the company).
   3. Files dropped into a conversation (plans, photos) before they belong to
      a deal.
   4. Bid requests: plans sent to subs, and the prices they send back.
   5. End-of-day check-ins: "what did you get done?" and the reply. */
exports.up = (pgm) => {
  pgm.createTable('crm_ai_threads', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'cascade' },
    title: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.createIndex('crm_ai_threads', ['user_id', 'updated_at'], { ifNotExists: true });

  pgm.createTable('crm_ai_messages', {
    id: { type: 'bigserial', primaryKey: true },
    thread_id: { type: 'uuid', notNull: true, references: 'crm_ai_threads', onDelete: 'cascade' },
    role: { type: 'varchar(10)', notNull: true }, // user | assistant
    content: { type: 'jsonb', notNull: true }, // the API content blocks
    display: { type: 'jsonb' }, // { text, steps, actions, files } for the screen; null = not shown
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.createIndex('crm_ai_messages', ['thread_id', 'id'], { ifNotExists: true });

  pgm.createTable('crm_ai_actions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'cascade' },
    thread_id: { type: 'uuid', references: 'crm_ai_threads', onDelete: 'cascade' },
    kind: { type: 'varchar(32)', notNull: true },
    payload: { type: 'jsonb', notNull: true },
    summary: { type: 'jsonb', notNull: true }, // what the confirmation card shows
    status: { type: 'varchar(10)', notNull: true, default: 'pending' }, // pending | done | cancelled | failed
    result: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    decided_at: { type: 'timestamptz' }
  }, { ifNotExists: true });

  pgm.createTable('crm_ai_files', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    user_id: { type: 'uuid', references: 'users', onDelete: 'set null' },
    filename: { type: 'text', notNull: true },
    content_type: { type: 'text', notNull: true },
    size: { type: 'integer', notNull: true },
    data: { type: 'bytea', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });

  pgm.createTable('crm_bid_requests', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    deal_id: { type: 'uuid', notNull: true, references: 'crm_deals', onDelete: 'cascade' },
    vendor_id: { type: 'uuid', notNull: true, references: 'crm_vendors', onDelete: 'cascade' },
    token: { type: 'varchar(48)', notNull: true, unique: true },
    scope: { type: 'text' },
    message: { type: 'text' },
    file_ids: { type: 'uuid[]', notNull: true, default: '{}' },
    due_date: { type: 'date' },
    status: { type: 'varchar(10)', notNull: true, default: 'sent' }, // sent | viewed | submitted | declined | awarded
    amount: { type: 'numeric(14,2)' },
    bid_note: { type: 'text' },
    sent_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    viewed_at: { type: 'timestamptz' },
    submitted_at: { type: 'timestamptz' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'set null' }
  }, { ifNotExists: true });
  pgm.createIndex('crm_bid_requests', ['deal_id'], { ifNotExists: true });

  pgm.createTable('crm_checkins', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'cascade' },
    day: { type: 'date', notNull: true },
    sent_at: { type: 'timestamptz' },
    reply_text: { type: 'text' },
    replied_at: { type: 'timestamptz' },
    filed: { type: 'jsonb' }
  }, { ifNotExists: true });
  pgm.addConstraint('crm_checkins', 'crm_checkins_once', { unique: ['user_id', 'day'] });

  pgm.addColumns('users', { crm_checkin_off: { type: 'boolean', notNull: true, default: false } }, { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropColumns('users', ['crm_checkin_off'], { ifExists: true });
  for (const t of ['crm_checkins', 'crm_bid_requests', 'crm_ai_files', 'crm_ai_actions', 'crm_ai_messages', 'crm_ai_threads']) pgm.dropTable(t, { ifExists: true });
};
