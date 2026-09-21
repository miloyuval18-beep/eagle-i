/* A company's own verified sending domain. Mail then goes out from
   hello@theirdomain.com instead of the shared Eagle I address: it looks like
   them, lands in inboxes more reliably, and one company's mistakes cannot
   damage another company's reputation. The DNS records come from Resend (the
   email provider); the company adds them at its domain host, and the domain
   is used only once Resend reports it verified. */
exports.up = (pgm) => {
  pgm.createTable('sending_domains', {
    tenant_id: { type: 'uuid', primaryKey: true, references: 'tenants', onDelete: 'cascade' },
    domain: { type: 'text', notNull: true, unique: true },
    resend_domain_id: { type: 'text', notNull: true },
    status: { type: 'varchar(24)', notNull: true, default: 'pending' }, // not_started | pending | verified | failed | temporary_failure
    records: { type: 'jsonb', notNull: true, default: '[]' },
    from_local: { type: 'varchar(40)', notNull: true, default: 'hello' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_checked_at: { type: 'timestamptz' },
    verified_at: { type: 'timestamptz' }
  });
};
exports.down = (pgm) => { pgm.dropTable('sending_domains'); };
