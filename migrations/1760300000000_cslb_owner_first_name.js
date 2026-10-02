/* A sole-owner contractor's license is in the owner's own name ("RANDALL MARK
   DOCKERY"), so the greeting should be "Hi Randall", not "Hi Randall Mark
   Dockery team". first_name holds the owner's first name for those licenses
   only, and stays empty for companies. */
exports.up = (pgm) => {
  pgm.addColumn('cslb_contractors', { first_name: { type: 'text' } });
};
exports.down = (pgm) => {
  pgm.dropColumn('cslb_contractors', 'first_name');
};
