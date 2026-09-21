/* Real Texas insurance AGENCIES (businesses), sourced from TDI's public
   "Insurance agencies and businesses approved to manage insurance-related
   products" dataset on data.texas.gov (dataset 3yqc-fcdt — a real,
   official, daily-updated Socrata dataset).

   This is the business-level companion to lib/tdiRegistrants.js's
   individual escrow officers: an agency has a real org_name, which makes
   the Places lookup far more reliable than searching a bare person name.
   Scoped to the property/casualty-relevant agency types (general lines,
   personal lines P&C, specialty, surplus lines, managing general agencies)
   plus public insurance adjuster firms (a natural referral source for
   restoration work) — not life, pre-need, reinsurance, or title agencies.

   The source repeats an agency once per qualification line (5,042 rows
   collapse to ~3,670 distinct agencies for the Houston metro, confirmed
   live), so the importer dedupes on (license_type, agency_license_number).
   No phone and no county in the source — contact info comes from the same
   Places-lookup bridge as TBAE/TREC. */
exports.up = (pgm) => {
  pgm.createTable('tdi_agencies', {
    id: { type: 'bigserial', primaryKey: true },
    license_type: { type: 'varchar(60)', notNull: true },
    agency_license_number: { type: 'varchar(20)', notNull: true },
    org_name: { type: 'text' },
    agency_type: { type: 'varchar(40)' },
    city: { type: 'text' },
    state: { type: 'varchar(2)' },
    postal_code: { type: 'varchar(10)' },
    expiration_date: { type: 'date' },
    phone: { type: 'varchar(20)' },
    website: { type: 'text' },
    contact_email: { type: 'text' },
    places_formatted_address: { type: 'text' },
    places_matched_name: { type: 'text' },
    google_rating: { type: 'numeric(2,1)' },
    google_review_count: { type: 'integer' },
    contact_checked_at: { type: 'timestamptz' },
    imported_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('tdi_agencies', 'tdi_agencies_type_license_no_unique', {
    unique: ['license_type', 'agency_license_number']
  });
  pgm.createIndex('tdi_agencies', ['license_type', 'city']);

  pgm.createTable('tdi_agencies_import_state', {
    id: { type: 'bigserial', primaryKey: true },
    completed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    total_count: { type: 'integer' }
  });
};

exports.down = (pgm) => {
  pgm.dropTable('tdi_agencies_import_state');
  pgm.dropTable('tdi_agencies');
};
