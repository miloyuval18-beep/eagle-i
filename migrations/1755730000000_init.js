/* Initial schema for multi-tenant Eagle I. */

exports.up = (pgm) => {
  pgm.createExtension('pgcrypto', { ifNotExists: true }); // for gen_random_uuid()

  pgm.createTable('tenants', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    company_name: { type: 'text', notNull: true },
    industry: { type: 'text', notNull: true }, // e.g. 'home_services', 'real_estate', 'professional_services', 'other'
    plan_tier: { type: 'text', notNull: true, default: 'trial' }, // 'trial' | 'starter' | 'pro'
    monthly_generation_cap: { type: 'integer', notNull: true, default: 50 },
    stripe_customer_id: { type: 'text' },
    stripe_subscription_id: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.createTable('users', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: {
      type: 'uuid',
      notNull: true,
      references: 'tenants',
      onDelete: 'cascade'
    },
    email: { type: 'text', notNull: true, unique: true },
    password_hash: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.createTable('business_profile', {
    tenant_id: {
      type: 'uuid',
      primaryKey: true,
      references: 'tenants',
      onDelete: 'cascade'
    },
    founder_name: { type: 'text' },
    phone: { type: 'text' },
    email: { type: 'text' },
    address: { type: 'text' },
    site: { type: 'text' },
    service_area: { type: 'text' },
    services: { type: 'text' },
    differentiators: { type: 'text' },
    voice: { type: 'text' },
    logo_url: { type: 'text' },
    industry_details: { type: 'jsonb', notNull: true, default: '{}' },
    generated_content: { type: 'jsonb', notNull: true, default: '{}' }, // cached AI-generated tab content
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.createTable('usage_counters', {
    tenant_id: {
      type: 'uuid',
      notNull: true,
      references: 'tenants',
      onDelete: 'cascade'
    },
    month: { type: 'text', notNull: true }, // 'YYYY-MM'
    generation_count: { type: 'integer', notNull: true, default: 0 }
  });
  pgm.addConstraint('usage_counters', 'usage_counters_tenant_month_unique', {
    unique: ['tenant_id', 'month']
  });

  // express-session + connect-pg-simple expects a "session" table; let the
  // library create it at runtime (createTableIfMissing: true) instead of
  // duplicating its schema here.
};

exports.down = (pgm) => {
  pgm.dropTable('usage_counters');
  pgm.dropTable('business_profile');
  pgm.dropTable('users');
  pgm.dropTable('tenants');
};
