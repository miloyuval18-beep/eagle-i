/* Eagle I CRM: "Sign in with Google" for companies on personal Gmail (or any
   Google account), as well as Google Workspace's admin-wide connection.

   1. A connection is either 'workspace' (domain-wide delegation, every
      mailbox at once) or 'signin' (each person signs in with their own Google
      account). For a sign-in connection, the domain is empty: the company's
      own addresses are the mailboxes that signed in.
   2. Each signed-in mailbox keeps its Google refresh token, encrypted, and
      which permissions were given (email, Drive).
   3. Which signed-in account holds the company's project files in Drive.
   4. The one-time "state" for each sign-in, tied to the person who started it. */
exports.up = (pgm) => {
  pgm.addColumns('crm_google_connections', {
    kind: { type: 'varchar(10)', notNull: true, default: 'workspace' },
    drive_mailbox_id: { type: 'bigint' }
  }, { ifNotExists: true });
  pgm.addColumns('crm_mailboxes', {
    refresh_token_enc: { type: 'jsonb' },
    scopes: { type: 'text' },
    connected_by: { type: 'uuid', references: 'users', onDelete: 'set null' }
  }, { ifNotExists: true });
  pgm.createTable('crm_google_oauth_states', {
    state: { type: 'varchar(64)', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'cascade' },
    want_drive: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropTable('crm_google_oauth_states', { ifExists: true });
  pgm.dropColumns('crm_mailboxes', ['refresh_token_enc', 'scopes', 'connected_by'], { ifExists: true });
  pgm.dropColumns('crm_google_connections', ['kind', 'drive_mailbox_id'], { ifExists: true });
};
