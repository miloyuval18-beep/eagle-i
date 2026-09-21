/* Support for the unified vendor-directory panel (filters, Top-N selection,
   bulk outreach) across every source.

   1. The seven older registry tables never stored WHICH Google listing a
      lookup matched, or its rating — the two newest sources already do.
      Adding the same three columns everywhere lets one panel show the
      matched listing at confirm time and rank by Google rating for every
      category. Rows looked up before this migration have NULL here, which
      the panel treats as "match not verified" rather than guessing.
   2. TREC and TDI escrow have no phone in their source data, so Places'
      phone (already saved for the other Places-bridged sources) needs a
      home.
   3. outreach_suppressions: an email address that has opted out for a
      tenant. Every outreach send (single or bulk) checks it, and the
      unsubscribe link in each email writes to it. Unique per
      (tenant, lowercased address). */
const OLDER_TABLES = [
  'tbae_registrants', 'tdlr_registrants', 'tsbpe_registrants', 'tbpels_registrants',
  'trec_registrants', 'tdi_registrants', 'tda_registrants'
];

exports.up = (pgm) => {
  for (const t of OLDER_TABLES) {
    pgm.addColumns(t, {
      places_matched_name: { type: 'text' },
      google_rating: { type: 'numeric(2,1)' },
      google_review_count: { type: 'integer' }
    }, { ifNotExists: true });
  }
  pgm.addColumns('trec_registrants', { phone: { type: 'varchar(20)' } }, { ifNotExists: true });
  pgm.addColumns('tdi_registrants', { phone: { type: 'varchar(20)' } }, { ifNotExists: true });

  pgm.createTable('outreach_suppressions', {
    id: { type: 'bigserial', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    email: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('outreach_suppressions', ['tenant_id', pgm.func('lower(email)')], {
    unique: true,
    name: 'outreach_suppressions_tenant_email_unique'
  });
};
