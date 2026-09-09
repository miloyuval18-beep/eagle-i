/* Per-parcel year-built, sourced from the same HCAD real_acct.txt export
   already parsed for hcad_zip_stats/hcad_owner_parcels (see
   scripts/importHcadZipValues.js and lib/hcadZipValues.js) — confirmed
   live via that script's --header-only check: yr_impr is a real,
   plausible year-built column.

   Deliberately a SEPARATE table from hcad_owner_parcels, not an added
   column on it — hcad_owner_parcels only ever holds rows where the
   owner-of-record parses as a confident individual (businesses, trusts,
   LLCs, and ambiguous names are filtered out by lib/hcadOwnerNames.js).
   Property age has nothing to do with owner-name confidence, and reusing
   that table would silently exclude every trust/LLC-owned property from
   aging-system targeting (routes/permits.js's
   GET /api/permits/aging-systems) — exactly the kind of scope-narrowing
   that table's existing invariant isn't meant to cause here. */
exports.up = (pgm) => {
  pgm.createTable('hcad_parcel_ages', {
    id: { type: 'bigserial', primaryKey: true },
    zip: { type: 'varchar(5)', notNull: true },
    normalized_address: { type: 'text', notNull: true },
    raw_site_address: { type: 'text', notNull: true },
    year_built: { type: 'integer' },
    tax_year: { type: 'varchar(4)' },
    imported_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('hcad_parcel_ages', ['zip', 'normalized_address']);
};

exports.down = (pgm) => {
  pgm.dropTable('hcad_parcel_ages');
};
