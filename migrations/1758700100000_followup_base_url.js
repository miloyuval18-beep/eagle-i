/* A follow-up is sent later by a background worker with no web request to
   read the site's address from, but every email needs a working unsubscribe
   link. Remember the address the batch was sent from. */
exports.up = (pgm) => {
  pgm.addColumns('outreach_followups', { base_url: { type: 'text', notNull: true, default: '' } }, { ifNotExists: true });
};
