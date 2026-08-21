/* Real scheduled social posts, fired by lib/scheduledPostsWorker.js. */

exports.up = (pgm) => {
  pgm.createTable('scheduled_posts', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: {
      type: 'uuid',
      notNull: true,
      references: 'tenants',
      onDelete: 'cascade'
    },
    message: { type: 'text', notNull: true },
    image_url: { type: 'text' },
    targets: { type: 'jsonb', notNull: true, default: '[]' }, // e.g. ["facebook","instagram"]
    scheduled_at: { type: 'timestamptz', notNull: true },
    status: { type: 'text', notNull: true, default: 'pending' }, // pending|sending|sent|failed|canceled
    result: { type: 'jsonb' },
    error: { type: 'text' },
    attempts: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    sent_at: { type: 'timestamptz' }
  });
  pgm.createIndex('scheduled_posts', ['status', 'scheduled_at']);
};

exports.down = (pgm) => {
  pgm.dropTable('scheduled_posts');
};
