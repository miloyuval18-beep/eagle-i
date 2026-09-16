/* The live TBAE roster uses "n/a" (not a 2-letter code) in the State
   column for registrants who opted out of publishing their city/firm —
   confirmed by the real import failing with "value too long for type
   character varying(2)" on the first live run. Widened rather than kept
   at 2 chars to tolerate whatever else the board's free-text export does. */
exports.up = (pgm) => {
  pgm.alterColumn('tbae_registrants', 'state', { type: 'varchar(10)' });
};

exports.down = (pgm) => {
  pgm.alterColumn('tbae_registrants', 'state', { type: 'varchar(2)' });
};
