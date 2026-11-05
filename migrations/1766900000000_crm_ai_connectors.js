// Claude and ChatGPT connected to Eagle I (lib/crmOAuth.js, lib/crmMcp.js): the apps that
// registered, the one-time sign-in codes, and the tokens each person's app uses (stored
// hashed; a person can disconnect an app from Account).
exports.up = (pgm) => {
  pgm.createTable('crm_oauth_clients', {
    id: { type: 'text', primaryKey: true },
    name: { type: 'text' },
    redirect_uris: { type: 'text[]', notNull: true },
    secret_hash: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.createTable('crm_oauth_codes', {
    code_hash: { type: 'text', primaryKey: true },
    client_id: { type: 'text', notNull: true, references: 'crm_oauth_clients', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    redirect_uri: { type: 'text', notNull: true },
    challenge: { type: 'text', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    used_at: { type: 'timestamptz' }
  }, { ifNotExists: true });
  pgm.createTable('crm_oauth_tokens', {
    id: { type: 'bigserial', primaryKey: true },
    kind: { type: 'varchar(10)', notNull: true }, // access | refresh
    token_hash: { type: 'text', notNull: true, unique: true },
    client_id: { type: 'text', notNull: true, references: 'crm_oauth_clients', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    expires_at: { type: 'timestamptz', notNull: true },
    revoked_at: { type: 'timestamptz' },
    last_used_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.createIndex('crm_oauth_tokens', ['user_id', 'client_id'], { ifNotExists: true });
};
exports.down = (pgm) => {
  pgm.dropTable('crm_oauth_tokens', { ifExists: true });
  pgm.dropTable('crm_oauth_codes', { ifExists: true });
  pgm.dropTable('crm_oauth_clients', { ifExists: true });
};
