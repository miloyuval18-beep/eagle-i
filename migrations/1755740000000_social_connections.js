/* Per-tenant social platform connections (real Meta/Facebook+Instagram OAuth). */

exports.up = (pgm) => {
  pgm.createTable('social_connections', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: {
      type: 'uuid',
      notNull: true,
      references: 'tenants',
      onDelete: 'cascade'
    },
    platform: { type: 'text', notNull: true }, // 'meta' (covers both Facebook Page + linked Instagram Business account)
    page_id: { type: 'text' },
    page_name: { type: 'text' },
    ig_business_id: { type: 'text' },
    ig_username: { type: 'text' },
    access_token_encrypted: { type: 'text', notNull: true }, // AES-256-GCM ciphertext, base64
    access_token_iv: { type: 'text', notNull: true },
    access_token_tag: { type: 'text', notNull: true },
    token_expires_at: { type: 'timestamptz' },
    connected_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('social_connections', 'social_connections_tenant_platform_unique', {
    unique: ['tenant_id', 'platform']
  });

  // Short-lived state token binding an in-progress OAuth handshake to the
  // tenant that started it (defense against CSRF / state-swap attacks).
  pgm.createTable('oauth_states', {
    state: { type: 'text', primaryKey: true },
    tenant_id: {
      type: 'uuid',
      notNull: true,
      references: 'tenants',
      onDelete: 'cascade'
    },
    platform: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
};

exports.down = (pgm) => {
  pgm.dropTable('oauth_states');
  pgm.dropTable('social_connections');
};
