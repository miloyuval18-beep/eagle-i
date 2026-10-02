/* California license sources, for the San Diego market.

   cslb_contractors: the Contractors State License Board's public "Master List
   of California Licensed Contractors" (cslb.ca.gov/onlineservices/dataportal) --
   free, official, one row per license, with the business's real phone number,
   license classifications, issue/expiry dates and workers' comp status. It has
   NO email addresses (state law), so email comes from the same Google lookup as
   every other source. Unlike Texas, California licenses general contractors,
   roofers, painters, landscapers and so on, so this one source covers every
   trade. The statewide file is ~240,000 licenses; only counties of markets we
   serve are stored (see lib/markets.js countiesInState).

   dre_registrants: the Department of Real Estate's public licensee list
   (secure.dre.ca.gov/datafile/CurrList.zip) -- brokers and brokerage
   corporations only (salespeople work under a broker). Like Texas's TREC list it
   has no phone and no email; the address is stored for locating the business in
   the Google lookup, but is not offered for letters, because a broker's address
   of record is sometimes a home address.

   Both keep the same contact columns as every other directory table. Licenses
   that stop appearing are flagged inactive, never deleted, so contact data we
   already paid for is kept. */
const contactColumns = {
  phone: { type: 'varchar(20)' },
  website: { type: 'text' },
  contact_email: { type: 'text' },
  email_check_status: { type: 'varchar(20)' },
  email_check_reason: { type: 'text' },
  email_checked_at: { type: 'timestamptz' },
  places_formatted_address: { type: 'text' },
  places_matched_name: { type: 'text' },
  google_rating: { type: 'numeric(2,1)' },
  google_review_count: { type: 'integer' },
  contact_checked_at: { type: 'timestamptz' }
};

exports.up = (pgm) => {
  const cols = { ...contactColumns, imported_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') } };

  pgm.createTable('cslb_contractors', {
    id: { type: 'bigserial', primaryKey: true },
    license_no: { type: 'varchar(12)', notNull: true, unique: true },
    display_name: { type: 'text' },      // trade name if there is one, else the owner's name in reading order
    legal_name: { type: 'text' },        // the registered legal name when it differs from the trade name
    mailing_address: { type: 'text' },
    city: { type: 'text' },
    county: { type: 'text' },
    zip: { type: 'varchar(10)' },
    business_type: { type: 'varchar(30)' },
    issue_date: { type: 'date' },
    expiration_date: { type: 'date' },
    primary_status: { type: 'varchar(40)' },   // CLEAR = in good standing
    classifications: { type: 'text[]', notNull: true, default: '{}' }, // normalized, e.g. B, C10, C36
    wc_coverage_type: { type: 'text' },
    wc_expiration_date: { type: 'date' },
    active: { type: 'boolean', notNull: true, default: true },
    ...cols
  });
  pgm.createIndex('cslb_contractors', ['county', 'active']);
  pgm.createIndex('cslb_contractors', ['classifications'], { method: 'gin' });
  pgm.createTable('cslb_import_state', {
    id: { type: 'bigserial', primaryKey: true },
    completed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    total_count: { type: 'integer' }
  });

  pgm.createTable('dre_registrants', {
    id: { type: 'bigserial', primaryKey: true },
    lic_number: { type: 'varchar(12)', notNull: true, unique: true },
    license_type: { type: 'varchar(20)', notNull: true },   // Broker (an individual) or Corporation (a brokerage)
    name: { type: 'text' },                                  // display name, in reading order
    first_name: { type: 'text' },
    officer_name: { type: 'text' },                          // a brokerage's designated officer
    status: { type: 'varchar(20)' },
    restricted: { type: 'boolean', notNull: true, default: false },
    original_date: { type: 'date' },
    expiration_date: { type: 'date' },
    city: { type: 'text' },
    county: { type: 'text' },
    zip: { type: 'varchar(10)' },
    active: { type: 'boolean', notNull: true, default: true },
    ...cols
  });
  pgm.createIndex('dre_registrants', ['county', 'license_type', 'active']);
  pgm.createTable('dre_import_state', {
    id: { type: 'bigserial', primaryKey: true },
    completed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    total_count: { type: 'integer' }
  });
};

exports.down = (pgm) => {
  pgm.dropTable('dre_import_state');
  pgm.dropTable('dre_registrants');
  pgm.dropTable('cslb_import_state');
  pgm.dropTable('cslb_contractors');
};
