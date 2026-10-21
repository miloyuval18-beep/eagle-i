/* Eagle I CRM: email watch (lib/crmEmailWatch.js).

   One row per email conversation (a Gmail thread in one team member's
   mailbox) with someone outside the company, kept only while it matters:
   who has the next move (us or them), how important it is, and what Eagle I
   has already done about it (reminders, a follow-up drafted or sent).
   Only the headers and Gmail's short preview are kept, never the full text
   or attachments; newsletters, notifications and no-reply senders are
   skipped before anything is written. */
exports.up = (pgm) => {
  pgm.createTable('crm_mail_threads', {
    id: { type: 'bigserial', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    mailbox_email: { type: 'text', notNull: true },
    user_id: { type: 'uuid', references: 'users', onDelete: 'set null' },
    thread_id: { type: 'text', notNull: true },
    counterpart_email: { type: 'text' },
    counterpart_name: { type: 'text' },
    subject: { type: 'text' },
    contact_id: { type: 'uuid', references: 'crm_contacts', onDelete: 'set null' },
    vendor_id: { type: 'uuid', references: 'crm_vendors', onDelete: 'set null' },
    deal_id: { type: 'uuid', references: 'crm_deals', onDelete: 'set null' },
    last_dir: { type: 'varchar(3)', notNull: true }, // in | out
    last_at: { type: 'timestamptz', notNull: true },
    last_message_key: { type: 'text' },
    last_gmail_id: { type: 'text' },
    last_snippet: { type: 'text' },
    state: { type: 'varchar(10)', notNull: true }, // waiting (on them) | to_reply (us) | closed
    expects: { type: 'boolean' }, // the last email expects an answer or action
    importance: { type: 'varchar(8)' }, // urgent | high | normal | low
    reason: { type: 'text' },
    deadline: { type: 'date' },
    classified_at: { type: 'timestamptz' },
    status: { type: 'varchar(10)', notNull: true, default: 'open' }, // open | done | dismissed
    snooze_until: { type: 'timestamptz' },
    nudged_at: { type: 'timestamptz' },
    escalated_at: { type: 'timestamptz' },
    followup_draft: { type: 'jsonb' },
    followups_sent: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
  pgm.createIndex('crm_mail_threads', ['tenant_id', 'mailbox_email', 'thread_id'], { name: 'crm_mail_threads_unique', unique: true, ifNotExists: true });
  pgm.createIndex('crm_mail_threads', ['tenant_id', 'state', 'status'], { ifNotExists: true });
  pgm.createIndex('crm_mail_threads', ['tenant_id', pgm.func('lower(counterpart_email)')], { name: 'crm_mail_threads_counterpart', ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropTable('crm_mail_threads', { ifExists: true });
};
