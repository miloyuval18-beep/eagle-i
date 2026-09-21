/* Sales-tax-permit businesses are stored once per (taxpayer, industry code).
   With more than one metro imported, a chain with outlets in Houston and Dallas
   must appear in each, so the key gains a market. Rows are assigned to a market
   by county code (the Comptroller's own numbering); Houston's nine counties
   stay 'houston', so Houston results are unchanged. */
const CODES = {
  dallas: ['057', '220', '043', '061', '199'],
  austin: ['227', '246', '105', '011'],
  san_antonio: ['015', '046', '094', '130']
};

exports.up = (pgm) => {
  pgm.addColumns('comptroller_trades', { market: { type: 'varchar(20)', notNull: true, default: 'houston' } }, { ifNotExists: true });
  for (const [market, codes] of Object.entries(CODES)) {
    pgm.sql(`UPDATE comptroller_trades SET market = '${market}' WHERE outlet_county_code IN (${codes.map(c => `'${c}'`).join(',')})`);
  }
  pgm.dropConstraint('comptroller_trades', 'comptroller_trades_taxpayer_naics_unique', { ifExists: true });
  pgm.addConstraint('comptroller_trades', 'comptroller_trades_taxpayer_naics_market_unique', { unique: ['taxpayer_number', 'naics_code', 'market'] });
  pgm.createIndex('comptroller_trades', ['market', 'naics_code', 'active'], { name: 'comptroller_trades_market_naics_idx' });
};

exports.down = (pgm) => {
  pgm.dropIndex('comptroller_trades', ['market', 'naics_code', 'active'], { name: 'comptroller_trades_market_naics_idx', ifExists: true });
  pgm.dropConstraint('comptroller_trades', 'comptroller_trades_taxpayer_naics_market_unique', { ifExists: true });
  pgm.sql("DELETE FROM comptroller_trades WHERE market <> 'houston'");
  pgm.addConstraint('comptroller_trades', 'comptroller_trades_taxpayer_naics_unique', { unique: ['taxpayer_number', 'naics_code'] });
  pgm.dropColumns('comptroller_trades', ['market']);
};
