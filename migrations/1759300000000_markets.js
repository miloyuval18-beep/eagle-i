/* Metro markets for the vendor directories. A company picks its area in the
   Company Profile (Houston by default). Bank rows are per institution PER
   MARKET (a bank with branches in Houston and Dallas appears in each), so the
   FDIC table gains a market column and its uniqueness becomes (cert, market). */
exports.up = (pgm) => {
  pgm.addColumns('business_profile', { market: { type: 'varchar(20)', notNull: true, default: 'houston' } }, { ifNotExists: true });
  pgm.addColumns('fdic_banks', { market: { type: 'varchar(20)', notNull: true, default: 'houston' } }, { ifNotExists: true });
  pgm.dropConstraint('fdic_banks', 'fdic_banks_cert_key', { ifExists: true });
  pgm.addConstraint('fdic_banks', 'fdic_banks_cert_market_unique', { unique: ['cert', 'market'] });
};

exports.down = (pgm) => {
  pgm.dropConstraint('fdic_banks', 'fdic_banks_cert_market_unique', { ifExists: true });
  pgm.sql("DELETE FROM fdic_banks WHERE market <> 'houston'");
  pgm.addConstraint('fdic_banks', 'fdic_banks_cert_key', { unique: ['cert'] });
  pgm.dropColumns('fdic_banks', ['market']);
  pgm.dropColumns('business_profile', ['market']);
};
