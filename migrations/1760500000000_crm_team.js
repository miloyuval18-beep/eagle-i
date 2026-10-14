/* Eagle I CRM, step 2: a company's team.

   1. Each login has a name and a role. The person who signed the company up
      is its owner; people they invite are admins or members.
   2. Invitations: a one-time link (only its hash is stored) that lets someone
      set a password and join the company.
   3. Each deal can have an owner on the team, and each timeline entry records
      which team member did it. */
exports.up = (pgm) => {
  pgm.addColumns('users', {
    name: { type: 'text' },
    role: { type: 'varchar(10)', notNull: true, default: 'owner' } // owner | admin | member
  }, { ifNotExists: true });

  pgm.createTable('crm_invites', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    email: { type: 'text', notNull: true },
    name: { type: 'text' },
    role: { type: 'varchar(10)', notNull: true, default: 'member' },
    token_hash: { type: 'varchar(64)', notNull: true, unique: true },
    invited_by: { type: 'uuid', references: 'users', onDelete: 'set null' },
    expires_at: { type: 'timestamptz', notNull: true },
    accepted_at: { type: 'timestamptz' },
    revoked_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('crm_invites', 'tenant_id');

  pgm.addColumns('crm_deals', {
    owner_user_id: { type: 'uuid', references: 'users', onDelete: 'set null' }
  }, { ifNotExists: true });
  pgm.addColumns('crm_activities', {
    user_id: { type: 'uuid', references: 'users', onDelete: 'set null' }
  }, { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropColumns('crm_activities', ['user_id'], { ifExists: true });
  pgm.dropColumns('crm_deals', ['owner_user_id'], { ifExists: true });
  pgm.dropTable('crm_invites');
  pgm.dropColumns('users', ['name', 'role'], { ifExists: true });
};
