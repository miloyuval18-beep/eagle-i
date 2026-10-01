// A per-tenant list of firms to never cold-email, by domain or by a
// name substring — the fix for "the TBAE architect list includes every
// licensed architect regardless of firm size," which let a 266-email batch
// go out to firms like AECOM and HOK alongside actual boutique firms. See
// lib/vendorOutreach.js's screenRecipients() for where this is enforced.
exports.up = (pgm) => {
  pgm.createTable('vendor_outreach_exclusions', {
    id: 'id',
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'cascade' },
    pattern_type: { type: 'text', notNull: true }, // domain | name_contains
    pattern: { type: 'text', notNull: true }, // stored lowercase
    reason: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('vendor_outreach_exclusions', 'voe_type_check', "CHECK (pattern_type IN ('domain', 'name_contains'))");
  pgm.addConstraint('vendor_outreach_exclusions', 'voe_tenant_pattern_unique', 'UNIQUE (tenant_id, pattern_type, pattern)');
  pgm.createIndex('vendor_outreach_exclusions', ['tenant_id']);
};

exports.down = (pgm) => {
  pgm.dropTable('vendor_outreach_exclusions');
};
