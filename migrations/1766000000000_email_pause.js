// Pausing all outgoing email (lib/email.js): one switch for the whole site, and a log
// of every email held back while it's on (who it was for, the subject, when).
exports.up = (pgm) => {
  pgm.createTable('app_flags', {
    key: { type: 'text', primaryKey: true },
    value: { type: 'jsonb', notNull: true, default: '{}' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createTable('email_held', {
    id: { type: 'bigserial', primaryKey: true },
    to_email: { type: 'text' },
    subject: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('email_held', 'created_at');
};
exports.down = (pgm) => { pgm.dropTable('email_held'); pgm.dropTable('app_flags'); };
