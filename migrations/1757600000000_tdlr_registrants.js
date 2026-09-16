/* Real electricians and HVAC (A/C) contractors, sourced from TDLR's own
   public "All Licenses" dataset on Texas's Open Data Portal
   (data.texas.gov, dataset 7358-krk7 — confirmed live: a real, free,
   daily-updated Socrata dataset covering every TDLR-regulated license,
   filtered server-side to just Electrical Contractor / A/C Contractor
   and the Houston-metro counties on import). Unlike the TBAE roster,
   TDLR's own data already includes a real business phone number and
   street address directly from the state — no Places API call needed
   just to get a phone number; Places is only used (on-demand, same
   find-contact pattern as tbae_registrants) to locate a website worth
   checking for a published email.

   business_name can be null — some license rows are registered to an
   individual with no separate business name on file; those are excluded
   at query time (see lib/tdlrRegistrants.js's getHoustonAreaRegistrants)
   the same way a TBAE registrant with no published firm_name is, since
   there's nothing to search on.

   No status column exists in TDLR's data — "currently licensed" is
   derived from license_expiration_date being in the future, computed at
   query time rather than stored as a separate flag, since the date
   itself is what's actually true and doesn't need duplicating. */
exports.up = (pgm) => {
  pgm.createTable('tdlr_registrants', {
    id: { type: 'bigserial', primaryKey: true },
    license_type: { type: 'varchar(60)', notNull: true }, // 'Electrical Contractor' | 'A/C Contractor'
    license_number: { type: 'varchar(20)', notNull: true },
    business_name: { type: 'text' },
    owner_name: { type: 'text' },
    business_address_line1: { type: 'text' },
    business_city: { type: 'text' },
    business_state: { type: 'varchar(2)' },
    business_zip: { type: 'varchar(10)' },
    business_county: { type: 'text' },
    business_phone: { type: 'varchar(20)' },
    license_expiration_date: { type: 'date' },
    website: { type: 'text' },
    contact_email: { type: 'text' },
    places_formatted_address: { type: 'text' },
    contact_checked_at: { type: 'timestamptz' },
    imported_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('tdlr_registrants', 'tdlr_registrants_type_license_no_unique', {
    unique: ['license_type', 'license_number']
  });
  pgm.createIndex('tdlr_registrants', ['license_type', 'business_county']);

  pgm.createTable('tdlr_import_state', {
    id: { type: 'bigserial', primaryKey: true },
    completed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    counts_by_type: { type: 'jsonb' }
  });
};

exports.down = (pgm) => {
  pgm.dropTable('tdlr_import_state');
  pgm.dropTable('tdlr_registrants');
};
