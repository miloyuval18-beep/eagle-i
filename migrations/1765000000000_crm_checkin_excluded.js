/* Eagle I CRM: logins left out of the daily check-in altogether (no 3:30 email, not
   on the Team list, no 6pm summary or urgent-problem emails), such as the Eagle I
   owner's own it@levihomes.com login at Levi Construction Group, which also stops
   getting "kept in the loop" updates for emails it's copied on. */
exports.up = (pgm) => {
  pgm.addColumns('users', { checkin_excluded: { type: 'boolean', notNull: true, default: false } }, { ifNotExists: true });
  pgm.sql(`UPDATE users SET checkin_excluded = true, oversight = false WHERE LOWER(email) = 'it@levihomes.com'`);
};
exports.down = (pgm) => {
  pgm.dropColumns('users', ['checkin_excluded'], { ifExists: true });
};
