/* "Jobs" — deliberately NOT a CRM. Just enough to say "we're doing/did
   work at address X" so a geofenced ad can target the immediate area
   around a real job site (see routes/jobs.js, lib/googlePlaces.js's
   geocodeAddress(), and routes/ads.js's radius-targeting extension). No
   status enum, no assignee, no line items — a tenant adds a job site to
   geocode it once, then picks it when creating a radius ad in the Ad
   Generator. */

exports.up = (pgm) => {
  pgm.createTable('jobs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: {
      type: 'uuid',
      notNull: true,
      references: 'tenants',
      onDelete: 'cascade'
    },
    label: { type: 'text' }, // optional, e.g. "Smith roof replacement" — for the tenant's own reference only
    raw_address: { type: 'text', notNull: true }, // what the tenant typed
    formatted_address: { type: 'text' }, // Places' resolved version, shown back for confirmation
    zip: { type: 'varchar(5)' },
    latitude: { type: 'numeric(9,6)' },
    longitude: { type: 'numeric(9,6)' },
    started_at: { type: 'date' },
    completed_at: { type: 'date' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('jobs', 'tenant_id');

  // Geocoding a job site is one Places Text Search call — cheap and
  // low-volume for a single business logging its own jobs, but still a
  // real, capped cost like every other external-API action in this app.
  pgm.addColumns('tenants', {
    monthly_job_geocode_cap: { type: 'integer', notNull: true, default: 20 }
  });
  pgm.addColumns('usage_counters', {
    job_geocode_count: { type: 'integer', notNull: true, default: 0 }
  });
};

exports.down = (pgm) => {
  pgm.dropTable('jobs');
  pgm.dropColumns('tenants', ['monthly_job_geocode_cap']);
  pgm.dropColumns('usage_counters', ['job_geocode_count']);
};
