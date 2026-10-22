/* Eagle I CRM: the team's safety net and a few extras.
   - crm_audit: who changed what (roles, permissions, people let in or turned
     off, deletes, settings), for the owner's activity log.
   - users.disabled_at: a person turned off without deleting them.
   - Two-step sign-in for owners and admins: a code by email
     (crm_login_codes), and devices they chose to trust (crm_trusted_devices).
   - crm_account_files: a sub's insurance certificate, from their own account.
   - crm_account_notices: emails sent to homeowner and sub accounts (no repeats).
   - crm_help_requests: "Help me set up" requests.
   - crm_errors: errors real people hit, for the alert emails. */
exports.up = (pgm) => {
  pgm.createTable('crm_audit', {
    id: { type: 'bigserial', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    actor_id: { type: 'uuid', references: 'users', onDelete: 'set null' },
    actor_name: { type: 'text' },
    action: { type: 'varchar(40)', notNull: true },
    target_id: { type: 'text' },
    target_name: { type: 'text' },
    detail: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.createIndex('crm_audit', ['tenant_id', 'created_at'], { ifNotExists: true });
  pgm.addColumns('users', { disabled_at: { type: 'timestamptz' } }, { ifNotExists: true });
  pgm.createTable('crm_login_codes', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'cascade' },
    code_hash: { type: 'varchar(64)', notNull: true },
    tries: { type: 'integer', notNull: true, default: 0 },
    expires_at: { type: 'timestamptz', notNull: true },
    used_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.createTable('crm_trusted_devices', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'cascade' },
    token_hash: { type: 'varchar(64)', notNull: true, unique: true },
    name: { type: 'text' },
    expires_at: { type: 'timestamptz', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.createTable('crm_account_files', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    account_id: { type: 'uuid', notNull: true, references: 'crm_accounts', onDelete: 'cascade' },
    kind: { type: 'varchar(20)', notNull: true, default: 'insurance' },
    filename: { type: 'text', notNull: true },
    content_type: { type: 'text', notNull: true },
    data: { type: 'bytea', notNull: true },
    expires: { type: 'date' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.createTable('crm_account_notices', {
    id: { type: 'bigserial', primaryKey: true },
    account_id: { type: 'uuid', notNull: true, references: 'crm_accounts', onDelete: 'cascade' },
    tenant_id: { type: 'uuid', references: 'tenants', onDelete: 'cascade' },
    key: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.createIndex('crm_account_notices', ['account_id', 'key'], { ifNotExists: true });
  pgm.createTable('crm_help_requests', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', references: 'tenants', onDelete: 'cascade' },
    user_id: { type: 'uuid', references: 'users', onDelete: 'set null' },
    phone: { type: 'text' },
    best_time: { type: 'text' },
    need: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.createTable('crm_errors', {
    id: { type: 'bigserial', primaryKey: true },
    source: { type: 'varchar(10)', notNull: true }, // server | browser
    fingerprint: { type: 'varchar(64)', notNull: true },
    message: { type: 'text', notNull: true },
    detail: { type: 'text' },
    path: { type: 'text' },
    tenant_id: { type: 'uuid' },
    user_id: { type: 'uuid' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.createIndex('crm_errors', ['fingerprint', 'created_at'], { ifNotExists: true });
};
exports.down = (pgm) => {
  for (const t of ['crm_errors', 'crm_help_requests', 'crm_account_notices', 'crm_account_files', 'crm_trusted_devices', 'crm_login_codes', 'crm_audit']) pgm.dropTable(t, { ifExists: true });
  pgm.dropColumns('users', ['disabled_at'], { ifExists: true });
};
