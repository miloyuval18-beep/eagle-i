/* Joining with a company code: the person confirms their email before the
   owner sees the request (or before an invitation for that email lets them
   in), so nobody can ask to join as someone else. */
exports.up = (pgm) => {
  pgm.addColumns('crm_join_requests', {
    confirmed: { type: 'boolean', notNull: true, default: false },
    confirm_token_hash: { type: 'varchar(64)' },
    confirm_sent_at: { type: 'timestamptz' }
  }, { ifNotExists: true });
  pgm.sql('UPDATE crm_join_requests SET confirmed = true');
};
exports.down = (pgm) => { pgm.dropColumns('crm_join_requests', ['confirmed', 'confirm_token_hash', 'confirm_sent_at'], { ifExists: true }); };
