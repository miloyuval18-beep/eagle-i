/* Eagle I CRM, step 5: the company's Google Workspace email.

   1. A company's Workspace connection (domain-wide delegation: the company's
      Google admin grants Eagle I read access once, for every mailbox).
   2. The mailboxes found in that Workspace, which ones are included, and how
      far each has been read.
   3. The emails that matter: only messages to or from someone in the CRM are
      kept (headers and a short preview, never attachments), once per message
      even when several employees have a copy. */
exports.up = (pgm) => {
  pgm.createTable('crm_google_connections', {
    tenant_id: { type: 'uuid', primaryKey: true, references: 'tenants', onDelete: 'cascade' },
    domain: { type: 'text', notNull: true },
    admin_email: { type: 'text', notNull: true },
    status: { type: 'varchar(12)', notNull: true, default: 'connected' }, // connected | error | paused
    last_error: { type: 'text' },
    connected_by: { type: 'uuid', references: 'users', onDelete: 'set null' },
    connected_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_synced_at: { type: 'timestamptz' }
  });

  pgm.createTable('crm_mailboxes', {
    id: { type: 'bigserial', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    email: { type: 'text', notNull: true },
    name: { type: 'text' },
    included: { type: 'boolean', notNull: true, default: true },
    last_internal_date: { type: 'bigint' }, // newest message read so far (Gmail internalDate, ms)
    last_synced_at: { type: 'timestamptz' },
    status: { type: 'varchar(12)', notNull: true, default: 'ok' }, // ok | error
    last_error: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('crm_mailboxes', ['tenant_id', pgm.func('lower(email)')], { name: 'crm_mailboxes_tenant_email_unique', unique: true });

  pgm.createTable('crm_emails', {
    id: { type: 'bigserial', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    message_key: { type: 'text', notNull: true }, // the email's own Message-ID, so copies in several mailboxes count once
    mailbox_email: { type: 'text', notNull: true },
    direction: { type: 'varchar(3)', notNull: true }, // in | out
    from_email: { type: 'text' },
    to_emails: { type: 'text[]' },
    subject: { type: 'text' },
    snippet: { type: 'text' },
    sent_at: { type: 'timestamptz', notNull: true },
    contact_id: { type: 'uuid', references: 'crm_contacts', onDelete: 'cascade' },
    deal_id: { type: 'uuid', references: 'crm_deals', onDelete: 'set null' },
    user_id: { type: 'uuid', references: 'users', onDelete: 'set null' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('crm_emails', 'crm_emails_tenant_message_unique', { unique: ['tenant_id', 'message_key'] });
  pgm.createIndex('crm_emails', ['tenant_id', 'sent_at']);
  pgm.createIndex('crm_emails', 'deal_id');
};

exports.down = (pgm) => {
  pgm.dropTable('crm_emails');
  pgm.dropTable('crm_mailboxes');
  pgm.dropTable('crm_google_connections');
};
