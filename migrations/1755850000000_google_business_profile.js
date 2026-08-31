// Real Google Business Profile connection (separate OAuth relationship
// from Google Ads and Google Places — different scope, different consent
// screen, its own developer approval gate). See routes/gbp.js.
exports.up = (pgm) => {
  pgm.createTable('google_business_connections', {
    tenant_id: { type: 'uuid', primaryKey: true, references: 'tenants', onDelete: 'cascade' },
    account_id: { type: 'text', notNull: true }, // e.g. "accounts/1234567890"
    location_id: { type: 'text', notNull: true }, // e.g. "locations/9876543210"
    location_name: { type: 'text' }, // display title, for UI only
    refresh_token_encrypted: { type: 'text', notNull: true },
    refresh_token_iv: { type: 'text', notNull: true },
    refresh_token_tag: { type: 'text', notNull: true },
    connected_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.createTable('oauth_states_gbp', {
    state: { type: 'text', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
};

exports.down = (pgm) => {
  pgm.dropTable('oauth_states_gbp');
  pgm.dropTable('google_business_connections');
};
