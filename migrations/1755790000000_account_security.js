/* Password reset, email verification, ToS acceptance — account-security
   basics a self-serve product needs before real strangers can sign up. */

exports.up = (pgm) => {
  pgm.addColumns('users', {
    email_verified: { type: 'boolean', notNull: true, default: false },
    email_verification_token_hash: { type: 'text' },
    email_verification_sent_at: { type: 'timestamptz' },
    terms_accepted_at: { type: 'timestamptz' }
  });

  pgm.createTable('password_reset_tokens', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users',
      onDelete: 'cascade'
    },
    token_hash: { type: 'text', notNull: true, unique: true },
    expires_at: { type: 'timestamptz', notNull: true },
    used_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
};

exports.down = (pgm) => {
  pgm.dropTable('password_reset_tokens');
  pgm.dropColumns('users', ['email_verified', 'email_verification_token_hash', 'email_verification_sent_at', 'terms_accepted_at']);
};
