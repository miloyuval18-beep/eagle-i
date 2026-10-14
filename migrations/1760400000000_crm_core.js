/* The CRM core (Phase 1 of the construction CRM, a separate Eagle I product):

   0. Which products a company has (marketing, crm, or both).
   1. Records: contacts (people), properties (the house) and deals (one job
      being sold, with a pipeline stage), plus a timeline of everything that
      happened on a deal.
   2. Playbooks: approve-once automatic emails tied to a pipeline stage, and
      the individual sends they schedule.
   3. "Needs you": the exceptions inbox — only what a person has to look at.
   4. CRM settings on the company profile, and a record of which weekly
      summaries went out (so one is never sent twice). */
exports.up = (pgm) => {
  // Which Eagle I products a company uses. The CRM is its own product with its
  // own app (/crm); existing companies keep the marketing product only.
  pgm.addColumns('tenants', {
    products: { type: 'text[]', notNull: true, default: pgm.func("'{marketing}'::text[]") }
  }, { ifNotExists: true });

  pgm.createTable('crm_contacts', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    name: { type: 'text', notNull: true },
    email: { type: 'text' },
    phone: { type: 'text' },
    phone_digits: { type: 'varchar(15)' }, // digits only, last 10 — used to match a returning person
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('crm_contacts', ['tenant_id', pgm.func('lower(email)')], { name: 'crm_contacts_tenant_email_idx' });
  pgm.createIndex('crm_contacts', ['tenant_id', 'phone_digits']);

  pgm.createTable('crm_properties', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    contact_id: { type: 'uuid', references: 'crm_contacts', onDelete: 'set null' },
    address: { type: 'text' },
    zip: { type: 'varchar(5)' },
    zip_median_value: { type: 'numeric' }, // county median for the ZIP when the property was saved (Houston only)
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('crm_properties', 'tenant_id');

  pgm.createTable('crm_deals', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    contact_id: { type: 'uuid', notNull: true, references: 'crm_contacts', onDelete: 'cascade' },
    property_id: { type: 'uuid', references: 'crm_properties', onDelete: 'set null' },
    lead_id: { type: 'uuid', references: 'leads', onDelete: 'set null' },
    title: { type: 'text', notNull: true },
    stage: { type: 'varchar(20)', notNull: true, default: 'new' },
    value: { type: 'numeric' },
    source: { type: 'varchar(30)', notNull: true, default: 'manual' },
    lost_reason: { type: 'text' },
    stage_entered_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    first_response_at: { type: 'timestamptz' }, // first time the owner did anything with it
    last_activity_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('crm_deals', ['tenant_id', 'stage']);
  pgm.createIndex('crm_deals', 'lead_id', { name: 'crm_deals_lead_unique', unique: true, where: 'lead_id IS NOT NULL' });

  pgm.createTable('crm_activities', {
    id: { type: 'bigserial', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    deal_id: { type: 'uuid', notNull: true, references: 'crm_deals', onDelete: 'cascade' },
    kind: { type: 'varchar(20)', notNull: true }, // lead_in | note | stage | email | reply | system
    actor: { type: 'varchar(10)', notNull: true, default: 'owner' }, // owner | eagle_i | contact
    body: { type: 'text' },
    meta: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('crm_activities', ['deal_id', 'created_at']);
  pgm.createIndex('crm_activities', ['tenant_id', 'created_at']);

  pgm.createTable('crm_playbooks', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    key: { type: 'varchar(40)', notNull: true },
    name: { type: 'text', notNull: true },
    stage: { type: 'varchar(20)', notNull: true }, // runs when a deal enters this stage
    steps: { type: 'jsonb', notNull: true }, // [{ days, subject, message }]
    enabled: { type: 'boolean', notNull: true, default: false },
    approved_hash: { type: 'varchar(64)' }, // hash of the exact wording the owner approved
    approved_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('crm_playbooks', 'crm_playbooks_tenant_key_unique', { unique: ['tenant_id', 'key'] });

  pgm.createTable('crm_playbook_sends', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    playbook_id: { type: 'uuid', notNull: true, references: 'crm_playbooks', onDelete: 'cascade' },
    deal_id: { type: 'uuid', notNull: true, references: 'crm_deals', onDelete: 'cascade' },
    step: { type: 'smallint', notNull: true },
    entry_key: { type: 'varchar(30)', notNull: true }, // which visit to the stage this belongs to
    due_at: { type: 'timestamptz', notNull: true },
    status: { type: 'varchar(20)', notNull: true, default: 'pending' }, // pending | sending | sent | cancelled | failed
    cancel_reason: { type: 'varchar(30)' },
    to_email: { type: 'text' },
    subject: { type: 'text' },
    base_url: { type: 'text', notNull: true, default: '' },
    error: { type: 'text' },
    resend_email_id: { type: 'text' },
    delivery_status: { type: 'varchar(20)' },
    sent_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('crm_playbook_sends', 'crm_playbook_sends_once', { unique: ['playbook_id', 'deal_id', 'step', 'entry_key'] });
  pgm.createIndex('crm_playbook_sends', ['status', 'due_at']);
  pgm.createIndex('crm_playbook_sends', 'deal_id');
  pgm.createIndex('crm_playbook_sends', 'resend_email_id', { name: 'crm_playbook_sends_resend_idx' });

  pgm.createTable('crm_inbox', {
    id: { type: 'bigserial', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    deal_id: { type: 'uuid', references: 'crm_deals', onDelete: 'cascade' },
    kind: { type: 'varchar(20)', notNull: true }, // waiting_lead | stalled | reply | negative_reply | send_failed
    title: { type: 'text', notNull: true },
    detail: { type: 'text' },
    dedupe_key: { type: 'text', notNull: true },
    status: { type: 'varchar(10)', notNull: true, default: 'open' }, // open | done
    snooze_until: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    resolved_at: { type: 'timestamptz' }
  });
  pgm.addConstraint('crm_inbox', 'crm_inbox_dedupe', { unique: ['tenant_id', 'dedupe_key'] });
  pgm.createIndex('crm_inbox', ['tenant_id', 'status']);

  pgm.addColumns('business_profile', {
    crm_settings: { type: 'jsonb' } // { paused, weeklySummary, waitingMinutes, backfilledAt }
  }, { ifNotExists: true });

  pgm.createTable('crm_weekly_summaries', {
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    week_start: { type: 'date', notNull: true },
    sent_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('crm_weekly_summaries', 'crm_weekly_summaries_pk', { primaryKey: ['tenant_id', 'week_start'] });
};

exports.down = (pgm) => {
  pgm.dropTable('crm_weekly_summaries');
  pgm.dropColumns('business_profile', ['crm_settings']);
  pgm.dropColumns('tenants', ['products'], { ifExists: true });
  pgm.dropTable('crm_inbox');
  pgm.dropTable('crm_playbook_sends');
  pgm.dropTable('crm_playbooks');
  pgm.dropTable('crm_activities');
  pgm.dropTable('crm_deals');
  pgm.dropTable('crm_properties');
  pgm.dropTable('crm_contacts');
};
