/* Storage for the customer-facing features:

   1. Lead email sequence: an optional automatic reply and follow-ups to people
      who fill out a landing-page form (settings live on business_profile;
      lead_sequence_sends holds what is waiting to go out).
   2. Landing-page conversion tracking and two-version tests: a daily visitor
      and submission count per version, and the second version's wording.
   3. Past customers: an imported list the company can email, with a record of
      each email sent.
   4. A public "work with us" page where vendors send a portfolio, licence and
      insurance, stored with the submission. */
exports.up = (pgm) => {
  // ---- 1. lead sequence ----
  pgm.addColumns('business_profile', {
    lead_sequence: { type: 'jsonb' }, // { enabled, steps: [{ days, subject, message }] }
    work_page_enabled: { type: 'boolean', notNull: true, default: false },
    work_page_slug: { type: 'text' },
    work_page_intro: { type: 'text' }
  }, { ifNotExists: true });
  pgm.createIndex('business_profile', 'work_page_slug', { name: 'business_profile_work_page_slug_unique', unique: true, where: 'work_page_slug IS NOT NULL', ifNotExists: true });

  pgm.addColumns('leads', {
    landing_page_id: { type: 'uuid' },
    landing_variant: { type: 'varchar(1)' }
  }, { ifNotExists: true });

  pgm.createTable('lead_sequence_sends', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    lead_id: { type: 'uuid', notNull: true, references: 'leads', onDelete: 'cascade' },
    step: { type: 'smallint', notNull: true },
    due_at: { type: 'timestamptz', notNull: true },
    status: { type: 'varchar(20)', notNull: true, default: 'pending' }, // pending | sending | sent | cancelled | failed
    cancel_reason: { type: 'varchar(30)' },
    base_url: { type: 'text', notNull: true, default: '' },
    error: { type: 'text' },
    sent_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('lead_sequence_sends', 'lead_sequence_sends_lead_step_unique', { unique: ['lead_id', 'step'] });
  pgm.createIndex('lead_sequence_sends', ['status', 'due_at']);

  // ---- 2. landing page conversion + tests ----
  pgm.addColumns('landing_pages', {
    ab_enabled: { type: 'boolean', notNull: true, default: false },
    ab_started_at: { type: 'timestamptz' },
    headline_b: { type: 'text' },
    subheadline_b: { type: 'text' },
    cta_primary_b: { type: 'text' }
  }, { ifNotExists: true });
  pgm.createTable('landing_page_stats', {
    page_id: { type: 'uuid', notNull: true, references: 'landing_pages', onDelete: 'cascade' },
    variant: { type: 'varchar(1)', notNull: true, default: 'A' },
    day: { type: 'date', notNull: true },
    views: { type: 'integer', notNull: true, default: 0 },
    submissions: { type: 'integer', notNull: true, default: 0 }
  });
  pgm.addConstraint('landing_page_stats', 'landing_page_stats_pk', { primaryKey: ['page_id', 'variant', 'day'] });

  // ---- 3. past customers ----
  pgm.createTable('customers', {
    id: { type: 'bigserial', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    name: { type: 'text', notNull: true },
    email: { type: 'text', notNull: true },
    phone: { type: 'text' },
    source: { type: 'varchar(20)', notNull: true, default: 'import' }, // import | lead
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('customers', ['tenant_id', pgm.func('lower(email)')], { name: 'customers_tenant_email_unique', unique: true });
  pgm.createTable('customer_imports', {
    id: { type: 'bigserial', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    added: { type: 'integer', notNull: true },
    attestation: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createTable('customer_emails', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    customer_id: { type: 'bigint' },
    to_email: { type: 'text', notNull: true },
    name: { type: 'text' },
    subject: { type: 'text', notNull: true },
    message: { type: 'text', notNull: true },
    campaign_id: { type: 'uuid' },
    status: { type: 'text', notNull: true }, // sent | failed
    error: { type: 'text' },
    resend_email_id: { type: 'text' },
    delivery_status: { type: 'varchar(20)' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('customer_emails', ['tenant_id', 'created_at']);
  pgm.createIndex('customer_emails', 'resend_email_id', { name: 'customer_emails_resend_idx' });

  // ---- 4. work with us ----
  pgm.createTable('vendor_submissions', {
    id: { type: 'bigserial', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    company_name: { type: 'text', notNull: true },
    contact_name: { type: 'text' },
    email: { type: 'text', notNull: true },
    phone: { type: 'text' },
    trade: { type: 'text' },
    website: { type: 'text' },
    message: { type: 'text' },
    via: { type: 'varchar(10)', notNull: true, default: 'link' }, // link | qr (came from a mailed letter's QR code)
    status: { type: 'varchar(12)', notNull: true, default: 'new' }, // new | reviewed | declined
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('vendor_submissions', ['tenant_id', 'created_at']);
  pgm.createTable('vendor_submission_files', {
    id: { type: 'bigserial', primaryKey: true },
    submission_id: { type: 'bigint', notNull: true, references: 'vendor_submissions', onDelete: 'cascade' },
    kind: { type: 'varchar(12)', notNull: true }, // portfolio | license | insurance
    filename: { type: 'text', notNull: true },
    content_type: { type: 'text', notNull: true },
    size: { type: 'integer', notNull: true },
    data: { type: 'bytea', notNull: true }
  });
  pgm.createIndex('vendor_submission_files', 'submission_id');
};

exports.down = (pgm) => {
  pgm.dropTable('vendor_submission_files');
  pgm.dropTable('vendor_submissions');
  pgm.dropTable('customer_emails');
  pgm.dropTable('customer_imports');
  pgm.dropTable('customers');
  pgm.dropTable('landing_page_stats');
  pgm.dropColumns('landing_pages', ['ab_enabled', 'ab_started_at', 'headline_b', 'subheadline_b', 'cta_primary_b']);
  pgm.dropTable('lead_sequence_sends');
  pgm.dropColumns('leads', ['landing_page_id', 'landing_variant']);
  pgm.dropColumns('business_profile', ['lead_sequence', 'work_page_enabled', 'work_page_slug', 'work_page_intro']);
};
