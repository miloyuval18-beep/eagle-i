// Lets a tenant ask a customer for before/after photos after a job wraps —
// a unique link per customer, an upload page (reusing the same real
// file-signature-sniffing pattern as the Work With Us page), photos stored
// as bytea like vendor_submission_files. Feeds ads/landing pages/case
// studies manually (download + reuse) — this migration is just capture.
exports.up = (pgm) => {
  pgm.createTable('photo_requests', {
    id: 'id',
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    customer_name: { type: 'text', notNull: true },
    customer_email: { type: 'text' },
    job_label: { type: 'text' },
    token: { type: 'text', notNull: true, unique: true },
    status: { type: 'text', notNull: true, default: 'sent' }, // sent | submitted
    resend_email_id: { type: 'text' },
    send_error: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    submitted_at: { type: 'timestamptz' }
  });
  pgm.createIndex('photo_requests', ['tenant_id']);

  pgm.createTable('photo_submission_files', {
    id: 'id',
    request_id: { type: 'integer', notNull: true, references: 'photo_requests', onDelete: 'cascade' },
    kind: { type: 'text', notNull: true, default: 'other' }, // before | after | other
    filename: { type: 'text', notNull: true },
    content_type: { type: 'text', notNull: true },
    size: { type: 'integer', notNull: true },
    data: { type: 'bytea', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('photo_submission_files', ['request_id']);
};

exports.down = (pgm) => {
  pgm.dropTable('photo_submission_files');
  pgm.dropTable('photo_requests');
};
