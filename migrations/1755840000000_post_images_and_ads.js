// Two additions:
//
// 1. post_images — real image hosting so Instagram's Graph API (which needs
//    a publicly reachable image URL, not a file upload) has something to
//    point at. Stored directly in Postgres (bytea) rather than a new
//    external object-storage account — modest volume, no new dependency,
//    no new account to set up. Served publicly at /img/:id (see routes/images.js).
//
// 2. Ad-campaign connections for Meta Ads and Google Ads (see routes/ads.js).
//    Meta Ads reuses the existing social_connections row (same OAuth
//    connection, just needs the tenant's ad account id added once they have
//    one) — a new nullable column, not a new table. Google Ads is a
//    separate OAuth relationship entirely (different provider), so it gets
//    its own table, matching the encrypted-refresh-token shape social
//    already uses for access tokens.
exports.up = (pgm) => {
  pgm.createTable('post_images', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    mime_type: { type: 'text', notNull: true },
    data: { type: 'bytea', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('post_images', 'tenant_id');

  pgm.addColumn('social_connections', {
    meta_ad_account_id: { type: 'text' } // e.g. "act_1234567890" — the tenant's own funded Meta ad account, entered by them
  });

  pgm.createTable('google_ads_connections', {
    tenant_id: { type: 'uuid', primaryKey: true, references: 'tenants', onDelete: 'cascade' },
    customer_id: { type: 'text', notNull: true }, // the tenant's Google Ads account id (10 digits, no dashes)
    refresh_token_encrypted: { type: 'text', notNull: true },
    refresh_token_iv: { type: 'text', notNull: true },
    refresh_token_tag: { type: 'text', notNull: true },
    connected_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.createTable('oauth_states_google_ads', {
    state: { type: 'text', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
};

exports.down = (pgm) => {
  pgm.dropTable('oauth_states_google_ads');
  pgm.dropTable('google_ads_connections');
  pgm.dropColumn('social_connections', 'meta_ad_account_id');
  pgm.dropTable('post_images');
};
