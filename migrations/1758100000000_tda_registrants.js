/* Real Texas structural pest control (termite/pest) BUSINESSES, sourced
   from the Texas Department of Agriculture's own public CSV export
   (texasagriculture.gov/Portals/0/Reports/PIR/spcs_commercial_business.csv
   — confirmed live: a real, direct download, no scrape). Scoped to the
   "Commercial Business" report specifically — TDA also publishes separate
   files for individual Applicators/Technicians/Apprentices, which are
   employee-level credentials, not businesses to reach out to (same
   "pick the business-level license" reasoning as Electrical Contractor
   over Journeyman Electrician).

   Like TBAE/TREC, TDA's file has no phone number in the source — but
   unlike those, the find-contact lookup here (routes/tdaRegistrants.js)
   saves whatever phone Places returns too, since there's nothing at all
   to fall back on otherwise. insurance_expired_date is a genuine second
   quality signal beyond just holding a license, the same idea as TSBPE's
   plumber data. */
exports.up = (pgm) => {
  pgm.createTable('tda_registrants', {
    id: { type: 'bigserial', primaryKey: true },
    tpcl: { type: 'varchar(20)', notNull: true, unique: true },
    account_type: { type: 'varchar(40)' },
    categories: { type: 'varchar(20)' },
    legal_business_name: { type: 'text' },
    dba: { type: 'text' },
    county: { type: 'text' },
    operator: { type: 'text' },
    insurance_expired_date: { type: 'date' },
    license_expired_date: { type: 'date' },
    license_issued_date: { type: 'date' },
    license_renewed_date: { type: 'date' },
    responsible_applicator: { type: 'text' },
    responsible_applicator_license: { type: 'varchar(20)' },
    phone: { type: 'varchar(20)' },
    website: { type: 'text' },
    contact_email: { type: 'text' },
    places_formatted_address: { type: 'text' },
    contact_checked_at: { type: 'timestamptz' },
    imported_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('tda_registrants', ['county']);

  pgm.createTable('tda_import_state', {
    id: { type: 'bigserial', primaryKey: true },
    completed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    total_count: { type: 'integer' }
  });
};

exports.down = (pgm) => {
  pgm.dropTable('tda_import_state');
  pgm.dropTable('tda_registrants');
};
