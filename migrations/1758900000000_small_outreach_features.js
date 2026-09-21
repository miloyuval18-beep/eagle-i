/* Storage for a batch of small outreach features:

   1. Second follow-up step: outreach_followups gains `step` (1 or 2), unique
      per (initial email, step), plus the approved text/delay for the NEXT
      step, so step 2 is scheduled only once step 1 has actually gone out.
   2. outreach_queue: emails scheduled to go out over several business days
      instead of all at once. The exact message (and any follow-up text) was
      approved when the batch was confirmed; the worker only re-checks who is
      still safe to email.
   3. linkedin_tasks: a hand-worked to-do list (open the search, paste the
      note, mark done). Nothing is automated on LinkedIn.
   4. business_profile.lead_alerts_enabled: email the owner when a landing-page
      lead arrives.
   5. review_requests reminder columns: one optional reminder if the customer
      hasn't replied. */
exports.up = (pgm) => {
  pgm.addColumns('outreach_followups', {
    step: { type: 'smallint', notNull: true, default: 1 },
    next_days: { type: 'integer' },
    next_message: { type: 'text' }
  }, { ifNotExists: true });
  pgm.dropConstraint('outreach_followups', 'outreach_followups_outreach_id_key', { ifExists: true });
  pgm.addConstraint('outreach_followups', 'outreach_followups_outreach_step_unique', { unique: ['outreach_id', 'step'] });

  pgm.createTable('outreach_queue', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    to_email: { type: 'text', notNull: true },
    vendor_name: { type: 'text', notNull: true },
    message: { type: 'text', notNull: true },
    due_at: { type: 'timestamptz', notNull: true },
    status: { type: 'varchar(20)', notNull: true, default: 'pending' }, // pending | sending | sent | cancelled | failed
    cancel_reason: { type: 'varchar(20)' },
    follow1_days: { type: 'integer' },
    follow1_message: { type: 'text' },
    follow2_days: { type: 'integer' },
    follow2_message: { type: 'text' },
    base_url: { type: 'text', notNull: true, default: '' },
    sent_outreach_id: { type: 'uuid' },
    error: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('outreach_queue', ['status', 'due_at']);
  // One live queue entry per address per tenant — queueing the same batch twice can't double-send.
  pgm.createIndex('outreach_queue', ['tenant_id', pgm.func('lower(to_email)')], {
    name: 'outreach_queue_live_email_unique', unique: true, where: "status IN ('pending','sending')"
  });

  pgm.createTable('linkedin_tasks', {
    id: { type: 'bigserial', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    source: { type: 'varchar(20)', notNull: true },
    source_id: { type: 'bigint', notNull: true },
    vendor_name: { type: 'text', notNull: true },
    search_url: { type: 'text', notNull: true },
    message: { type: 'text', notNull: true },
    done_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('linkedin_tasks', 'linkedin_tasks_unique', { unique: ['tenant_id', 'source', 'source_id'] });

  pgm.addColumns('business_profile', { lead_alerts_enabled: { type: 'boolean', notNull: true, default: true } }, { ifNotExists: true });

  pgm.addColumns('review_requests', {
    reminder_status: { type: 'varchar(20)' }, // pending | sent | cancelled
    reminder_due_at: { type: 'timestamptz' },
    reminder_sent_at: { type: 'timestamptz' },
    reminder_base_url: { type: 'text' }
  }, { ifNotExists: true });
};
