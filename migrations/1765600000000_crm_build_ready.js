// From priced to ready to build:
//  - Price this project reads a design package apart from the plans (file_roles), and
//    also lays out this job's own schedule (phases by trade, in building order, with
//    inspections) and the permits it needs.
//  - Purchase orders know when to go out: the phase they're for, the supplier's lead
//    time and the order-by date. Eagle I gets them ready and reminds; a person sends.
//  - Permits: what each job needs, where each stands, and its inspections.
exports.up = (pgm) => {
  pgm.addColumns('crm_pricing_runs', {
    file_roles: { type: 'jsonb' },   // { fileId: 'plans' | 'design' }
    schedule: { type: 'jsonb' },     // [{ phase, trade, days }]
    permits: { type: 'jsonb' }       // [{ kind, title, authority, why, beforePhase, inspections: [{ name, afterPhase }] }]
  });
  pgm.addColumns('crm_job_items', { trade: { type: 'text' } });
  pgm.addColumns('crm_purchase_orders', {
    job_item_id: { type: 'uuid', references: 'crm_job_items', onDelete: 'set null' },
    lead_days: { type: 'integer' },
    order_by: { type: 'date' },
    ready_flagged_at: { type: 'timestamptz' },
    due_flagged_at: { type: 'timestamptz' }
  });
  pgm.createTable('crm_permits', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    deal_id: { type: 'uuid', notNull: true, references: 'crm_deals', onDelete: 'cascade' },
    kind: { type: 'varchar(20)', notNull: true, default: 'building' }, // building | demolition | electrical | plumbing | mechanical | roofing | site | hoa | other
    title: { type: 'text', notNull: true },
    authority: { type: 'text' },
    why: { type: 'text' },
    status: { type: 'varchar(12)', notNull: true, default: 'needed' }, // needed | applying | submitted | corrections | approved | closed | not_needed
    permit_no: { type: 'text' },
    before_item_id: { type: 'uuid', references: 'crm_job_items', onDelete: 'set null' }, // must be approved before this phase
    inspections: { type: 'jsonb', notNull: true, default: '[]' }, // [{ i, name, afterItemId, afterPhase, status: todo|due|scheduled|passed|failed, date, note }]
    fee: { type: 'numeric(12,2)' },
    notes: { type: 'text' },
    source: { type: 'varchar(8)', notNull: true, default: 'manual' }, // ai | manual
    submitted_at: { type: 'date' },
    approved_at: { type: 'date' },
    expires_at: { type: 'date' },
    status_changed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_by: { type: 'uuid', references: 'users', onDelete: 'set null' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('crm_permits', ['deal_id']);
  pgm.createIndex('crm_permits', ['tenant_id', 'status']);
};

exports.down = (pgm) => {
  pgm.dropTable('crm_permits');
  pgm.dropColumns('crm_purchase_orders', ['job_item_id', 'lead_days', 'order_by', 'ready_flagged_at', 'due_flagged_at']);
  pgm.dropColumns('crm_job_items', ['trade']);
  pgm.dropColumns('crm_pricing_runs', ['file_roles', 'schedule', 'permits']);
};
