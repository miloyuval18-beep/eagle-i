// When each project's whole Drive folder was last looked through for new, renamed and
// removed files (lib/crmDriveProjects.js rescanDue): folders outside Eagle I's own shared
// drive, and folders inside folders, aren't in Drive's change feed.
exports.up = (pgm) => { pgm.addColumns('crm_deals', { drive_rescanned_at: { type: 'timestamptz' } }); };
exports.down = (pgm) => { pgm.dropColumns('crm_deals', ['drive_rescanned_at'], { ifExists: true }); };
