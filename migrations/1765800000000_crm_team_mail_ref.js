// The end-of-day email only has what still matters (lib/crmTeamMail.js): a reminder
// about an email (ref 'mw:<thread id>') is left out if it was answered, closed or
// snoozed before the email went.
exports.up = (pgm) => {
  pgm.addColumns('crm_team_mail', { ref: { type: 'text' } });
};
exports.down = (pgm) => { pgm.dropColumns('crm_team_mail', ['ref'], { ifExists: true }); };
