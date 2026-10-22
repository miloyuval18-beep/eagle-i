/* Eagle I CRM accounts, separate from Eagle I marketing accounts.

   1. users.app says which product a login is for: 'crm', 'marketing', or
      'both' (an owner who had both on one login before they were separated).
      The same email can have a CRM login and a marketing login.
   2. Homeowners and subs get their own accounts (crm_accounts). They don't
      belong to a company; their projects and builders are found by email
      once they confirm it, or by a private link they paste.
   3. Joining a company: a company code (tenants.join_code) and a request the
      owner or an admin approves (crm_join_requests).
   4. Guided setup: tenants.setup_done_at for the company, users.setup_done_at
      for each person. */
exports.up = (pgm) => {
  pgm.addColumns('users', {
    app: { type: 'varchar(12)', notNull: true, default: 'marketing' },
    setup_done_at: { type: 'timestamptz' },
    phone: { type: 'text' }
  }, { ifNotExists: true });
  pgm.sql(`UPDATE users u SET app = 'crm' FROM tenants t WHERE t.id = u.tenant_id AND 'crm' = ANY(t.products) AND (NOT ('marketing' = ANY(t.products)) OR u.role <> 'owner')`);
  pgm.sql(`UPDATE users u SET app = 'both' FROM tenants t WHERE t.id = u.tenant_id AND 'crm' = ANY(t.products) AND 'marketing' = ANY(t.products) AND u.role = 'owner'`);
  // Everyone already using the CRM has been through it.
  pgm.sql(`UPDATE users SET setup_done_at = now() WHERE app IN ('crm', 'both')`);
  pgm.sql('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key');
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS users_crm_email ON users (lower(email)) WHERE app IN ('crm', 'both')`);
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS users_marketing_email ON users (lower(email)) WHERE app IN ('marketing', 'both')`);

  pgm.addColumns('tenants', {
    join_code: { type: 'varchar(12)', unique: true },
    setup_done_at: { type: 'timestamptz' }
  }, { ifNotExists: true });
  pgm.sql(`UPDATE tenants SET setup_done_at = now() WHERE 'crm' = ANY(products)`);

  pgm.createTable('crm_accounts', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    kind: { type: 'varchar(12)', notNull: true }, // homeowner | sub
    email: { type: 'text', notNull: true },
    password_hash: { type: 'text', notNull: true },
    name: { type: 'text' },
    phone: { type: 'text' },
    business_name: { type: 'text' },
    trade: { type: 'text' },
    license: { type: 'text' },
    insurance_expires: { type: 'date' },
    address: { type: 'text' },
    email_verified: { type: 'boolean', notNull: true, default: false },
    verify_token_hash: { type: 'varchar(64)' },
    verify_sent_at: { type: 'timestamptz' },
    setup_done_at: { type: 'timestamptz' },
    last_login_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.sql('CREATE UNIQUE INDEX IF NOT EXISTS crm_accounts_email_kind ON crm_accounts (lower(email), kind)');
  // Projects or builders linked by a private link the person pasted.
  pgm.createTable('crm_account_links', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    account_id: { type: 'uuid', notNull: true, references: 'crm_accounts', onDelete: 'cascade' },
    deal_id: { type: 'uuid', references: 'crm_deals', onDelete: 'cascade' },
    vendor_id: { type: 'uuid', references: 'crm_vendors', onDelete: 'cascade' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.sql('CREATE UNIQUE INDEX IF NOT EXISTS crm_account_links_one ON crm_account_links (account_id, COALESCE(deal_id, vendor_id))');

  pgm.createTable('crm_join_requests', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    email: { type: 'text', notNull: true },
    name: { type: 'text', notNull: true },
    password_hash: { type: 'text', notNull: true },
    note: { type: 'text' },
    status: { type: 'varchar(10)', notNull: true, default: 'pending' }, // pending | approved | declined
    decided_by: { type: 'uuid', references: 'users', onDelete: 'set null' },
    decided_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS crm_join_requests_open ON crm_join_requests (tenant_id, lower(email)) WHERE status = 'pending'`);

  pgm.alterColumn('password_reset_tokens', 'user_id', { notNull: false });
  pgm.addColumns('password_reset_tokens', { account_id: { type: 'uuid', references: 'crm_accounts', onDelete: 'cascade' } }, { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropColumns('password_reset_tokens', ['account_id'], { ifExists: true });
  pgm.dropTable('crm_join_requests', { ifExists: true });
  pgm.dropTable('crm_account_links', { ifExists: true });
  pgm.dropTable('crm_accounts', { ifExists: true });
  pgm.dropColumns('tenants', ['join_code', 'setup_done_at'], { ifExists: true });
  pgm.sql('DROP INDEX IF EXISTS users_crm_email');
  pgm.sql('DROP INDEX IF EXISTS users_marketing_email');
  pgm.dropColumns('users', ['app', 'setup_done_at', 'phone'], { ifExists: true });
};
