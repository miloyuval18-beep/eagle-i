/* Public-facing landing page hosting + real lead capture. */

exports.up = (pgm) => {
  pgm.createTable('landing_pages', {
    tenant_id: {
      type: 'uuid',
      primaryKey: true,
      references: 'tenants',
      onDelete: 'cascade'
    },
    slug: { type: 'text', notNull: true, unique: true },
    status: { type: 'text', notNull: true, default: 'draft' }, // 'draft' | 'published'
    headline: { type: 'text' },
    subheadline: { type: 'text' },
    offer: { type: 'text' },
    about_para: { type: 'text' },
    service_para: { type: 'text' },
    trust_para: { type: 'text' },
    cta_primary: { type: 'text' },
    cta_secondary: { type: 'text' },
    meta_title: { type: 'text' },
    meta_desc: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.createTable('leads', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: {
      type: 'uuid',
      notNull: true,
      references: 'tenants',
      onDelete: 'cascade'
    },
    name: { type: 'text', notNull: true },
    phone: { type: 'text' },
    email: { type: 'text' },
    message: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'new' }, // new | contacted | won | lost
    source: { type: 'text', notNull: true, default: 'landing_page' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('leads', ['tenant_id', 'status']);
};

exports.down = (pgm) => {
  pgm.dropTable('leads');
  pgm.dropTable('landing_pages');
};
