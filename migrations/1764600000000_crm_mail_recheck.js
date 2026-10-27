/* Eagle I CRM: email conversations waiting on a reply from before the "copied to
   keep an eye on things" rule get looked at once more under it
   (lib/crmEmailWatch.js recheckCopied). This marks the ones already looked at. */
exports.up = (pgm) => {
  pgm.addColumns('crm_mail_threads', { cc_checked_at: { type: 'timestamptz' } }, { ifNotExists: true });
};
exports.down = (pgm) => {
  pgm.dropColumns('crm_mail_threads', ['cc_checked_at'], { ifExists: true });
};
