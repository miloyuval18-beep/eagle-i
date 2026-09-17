/* Real Texas engineering and surveying FIRMS (businesses), sourced from
   TBPELS's own public roster download (pels.texas.gov/roster/eng_rosters.html
   -> a direct S3 zip, confirmed live: real, current, updated daily).

   Deliberately the FIRM roster, not the individual PE/EIT roster — as of
   September 1, 2023, TBPELS stopped publishing individual licensees'
   phone/address/email under a Public Information Act exemption (same
   category of change as TBAE's "Not Published" opt-out), but the FIRM
   roster is untouched and still carries a real street address and phone
   number directly, confirmed live — richer contact data than TBAE, no
   Places lookup needed for the phone. firm_type is 'NS' (engineering-only)
   or 'SP' (also/only surveying practice) — both are shown together here
   rather than split into separate categories, since the source itself
   already treats them as one roster and both are genuine referral-partner
   business types (engineers and land surveyors). */
exports.up = (pgm) => {
  pgm.createTable('tbpels_registrants', {
    id: { type: 'bigserial', primaryKey: true },
    firm_number: { type: 'varchar(20)', notNull: true, unique: true },
    firm_name: { type: 'text' },
    address_line1: { type: 'text' },
    address_line2: { type: 'text' },
    city: { type: 'text' },
    state: { type: 'varchar(2)' },
    zip: { type: 'varchar(10)' },
    phone: { type: 'varchar(20)' },
    firm_type: { type: 'varchar(10)' },
    expire_date: { type: 'date' },
    create_date: { type: 'date' },
    website: { type: 'text' },
    contact_email: { type: 'text' },
    places_formatted_address: { type: 'text' },
    contact_checked_at: { type: 'timestamptz' },
    imported_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('tbpels_registrants', ['city']);

  pgm.createTable('tbpels_import_state', {
    id: { type: 'bigserial', primaryKey: true },
    completed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    total_count: { type: 'integer' }
  });
};

exports.down = (pgm) => {
  pgm.dropTable('tbpels_import_state');
  pgm.dropTable('tbpels_registrants');
};
