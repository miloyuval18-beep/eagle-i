/* The live TBPELS firm roster includes international firms whose "state"
   is a spelled-out province/region ("British Columbia", "Alberta",
   "Île-de-France", "Maharashtra"), not a 2-letter code — confirmed by the
   real import failing with "value too long for type character varying(2)"
   on the first live run. Widened to comfortably fit the longest of these
   rather than guessing a tighter bound. */
exports.up = (pgm) => {
  pgm.alterColumn('tbpels_registrants', 'state', { type: 'varchar(40)' });
};

exports.down = (pgm) => {
  pgm.alterColumn('tbpels_registrants', 'state', { type: 'varchar(2)' });
};
