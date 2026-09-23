// Real Google Search Console connection — its own OAuth relationship,
// separate from GBP/Ads/Places (different scope, different consent
// screen, its own Google Cloud client). See routes/searchConsole.js.
// Free, read-only, no developer-token approval gate unlike Google Ads.
exports.up = (pgm) => {
  pgm.createTable('search_console_connections', {
    tenant_id: { type: 'uuid', primaryKey: true, references: 'tenants', onDelete: 'cascade' },
    site_url: { type: 'text', notNull: true }, // Search Console's own site resource, e.g. "https://example.com/" or "sc-domain:example.com"
    refresh_token_encrypted: { type: 'text', notNull: true },
    refresh_token_iv: { type: 'text', notNull: true },
    refresh_token_tag: { type: 'text', notNull: true },
    connected_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.createTable('oauth_states_sc', {
    state: { type: 'text', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
};

exports.down = (pgm) => {
  pgm.dropTable('oauth_states_sc');
  pgm.dropTable('search_console_connections');
};
