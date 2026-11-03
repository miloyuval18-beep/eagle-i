// When a person's phone calendar last fetched their Eagle I calendar (lib/crmDaily.js
// calendarFor), so the setup reminder knows whether it's on their phone yet.
exports.up = (pgm) => { pgm.addColumns('users', { crm_calendar_seen_at: { type: 'timestamptz' } }); };
exports.down = (pgm) => { pgm.dropColumns('users', ['crm_calendar_seen_at'], { ifExists: true }); };
