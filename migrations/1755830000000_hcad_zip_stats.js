// Real per-zip home-value stats sourced directly from Harris Central
// Appraisal District's own public bulk data export (see
// scripts/importHcadZipValues.js for how this table gets populated — it's
// a manual/periodic local import, not a live per-request lookup, since
// HCAD's export is a ~200MB county-wide file with no per-address API).
// This supplements lib/houstonZipValues.js's curated reference list; it
// doesn't replace it. A zip with no row here just means the import hasn't
// covered it yet, not that it isn't valuable.
exports.up = (pgm) => {
  pgm.createTable('hcad_zip_stats', {
    zip: { type: 'varchar(5)', primaryKey: true },
    avg_market_value: { type: 'numeric', notNull: true },
    median_market_value: { type: 'numeric', notNull: true },
    parcel_count: { type: 'integer', notNull: true },
    tax_year: { type: 'varchar(4)' },
    imported_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
};

exports.down = (pgm) => {
  pgm.dropTable('hcad_zip_stats');
};
