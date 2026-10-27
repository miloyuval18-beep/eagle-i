/* Eagle I CRM: people who are copied on email to keep an eye on projects.
   - users.oversight: email they're only copied on keeps them in the loop
     (no reminders, nothing on their calendar) unless it's sent to their
     address or uses their name. NULL means their role's default (on for the
     owner and admins).
   - crm_mail_loop: those copied conversations, one row per person per
     conversation, for the project page and the morning email. Headers and
     Gmail's short preview only.
   - crm_mail_threads.addressed_to: the email was to a teammate who hasn't
     connected their Gmail; the reminder is theirs, not the person on copy's. */
exports.up = (pgm) => {
  pgm.addColumns('users', {
    oversight: { type: 'boolean' },
    crm_loop_digest_at: { type: 'timestamptz' }
  }, { ifNotExists: true });
  pgm.addColumns('crm_mail_threads', { addressed_to: { type: 'text' } }, { ifNotExists: true });
  pgm.createTable('crm_mail_loop', {
    id: { type: 'bigserial', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    mailbox_email: { type: 'text', notNull: true },
    thread_id: { type: 'text', notNull: true },
    deal_id: { type: 'uuid', references: 'crm_deals', onDelete: 'SET NULL' },
    from_email: { type: 'text' },
    from_name: { type: 'text' },
    to_names: { type: 'text' },
    subject: { type: 'text' },
    snippet: { type: 'text' },
    messages: { type: 'integer', notNull: true, default: 1 },
    last_message_key: { type: 'text' },
    last_at: { type: 'timestamptz', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.addConstraint('crm_mail_loop', 'crm_mail_loop_one', { unique: ['tenant_id', 'user_id', 'mailbox_email', 'thread_id'] });
  pgm.createIndex('crm_mail_loop', ['user_id', 'last_at'], { ifNotExists: true });
  pgm.createIndex('crm_mail_loop', ['deal_id', 'last_at'], { ifNotExists: true });
};
exports.down = (pgm) => {
  pgm.dropTable('crm_mail_loop', { ifExists: true });
  pgm.dropColumns('crm_mail_threads', ['addressed_to'], { ifExists: true });
  pgm.dropColumns('users', ['oversight', 'crm_loop_digest_at'], { ifExists: true });
};
