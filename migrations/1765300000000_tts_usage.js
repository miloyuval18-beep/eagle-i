/* Eagle I's natural voice (Google Cloud Text-to-Speech, lib/tts.js): characters sent
   to Google each month, so it stops well before the free allowance runs out and the
   browser's own voice takes over until the next month. */
exports.up = (pgm) => {
  pgm.createTable('tts_usage', {
    month: { type: 'text', primaryKey: true }, // e.g. 2026-10, in Google's billing time (Pacific)
    chars: { type: 'bigint', notNull: true, default: 0 },
    capped_at: { type: 'timestamptz' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, { ifNotExists: true });
};
exports.down = (pgm) => { pgm.dropTable('tts_usage', { ifExists: true }); };
