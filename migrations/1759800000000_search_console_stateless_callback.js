// The OAuth callback previously relied on requireAuth (an active login
// session) to know which tenant was connecting — but some browsers don't
// reliably carry the session cookie through the full redirect round-trip
// (our /connect -> Google consent/account-picker -> our /callback),
// producing a bogus "Not logged in" right after picking a Google account.
// The `state` value already ties the flow to a tenant and is unforgeable
// (random, single-use, generated server-side) — using it as the sole
// identity source removes the session dependency instead of layering a
// workaround on top of it.
exports.up = (pgm) => {
  pgm.addColumns('oauth_states_sc', {
    pending_sites: { type: 'jsonb' },
    refresh_token_encrypted: { type: 'text' },
    refresh_token_iv: { type: 'text' },
    refresh_token_tag: { type: 'text' }
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('oauth_states_sc', ['pending_sites', 'refresh_token_encrypted', 'refresh_token_iv', 'refresh_token_tag']);
};
