/* Per-parcel owner name + site address, sourced from the same HCAD
   Real_acct_owner.zip export scripts/importHcadZipValues.js already
   downloads (see that script and lib/hcadOwnerNames.js). Used ONLY to put
   a real name on a permit mailer letter (routes/permits.js,
   lib/permitMailer.js), and ONLY on an exact, unambiguous
   (zip, normalized address) match with exactly one distinct owner name on
   record — see lib/hcadZipValues.js's findConfidentOwners(). Business
   entities, trusts, government owners, and HCAD's own "CURRENT OWNER"
   placeholder are filtered out at import time (lib/hcadOwnerNames.js), so
   this table only ever holds names that parsed as one real, individual
   owner. A zip/address with no row here just falls back to the generic
   "Property Owner" salutation, same as before this table existed. */
exports.up = (pgm) => {
  pgm.createTable('hcad_owner_parcels', {
    id: { type: 'bigserial', primaryKey: true },
    zip: { type: 'varchar(5)', notNull: true },
    normalized_address: { type: 'text', notNull: true },
    owner_first_name: { type: 'text', notNull: true },
    owner_last_name: { type: 'text', notNull: true },
    raw_site_address: { type: 'text', notNull: true },
    tax_year: { type: 'varchar(4)' },
    imported_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('hcad_owner_parcels', ['zip', 'normalized_address']);
};

exports.down = (pgm) => {
  pgm.dropTable('hcad_owner_parcels');
};
