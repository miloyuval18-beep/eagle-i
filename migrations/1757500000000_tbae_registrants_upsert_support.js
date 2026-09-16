/* Two changes needed to make the TBAE roster refresh safe to automate on a
   monthly cadence without losing already-collected work:

   1. A stable per-registrant identity (TBAE's own reg_no, unique within a
      profession) to upsert against, instead of the DELETE+INSERT full
      replace the initial import used — that full replace would wipe every
      registrant's website/phone/contact_email/contact_checked_at (found
      via a real, billed Places lookup — see routes/tbaeRegistrants.js's
      find-contact endpoint) on every re-import, forcing that paid lookup
      to be redone for every firm every month just to pick up new
      registrants. See lib/tbaeRegistrants.js's upsertRegistrantsForProfession.

   2. tbae_import_state — a tiny append-only log of full-roster-import
      completions, so lib/tbaeRosterWorker.js can ask "when did we last
      import" and only re-run monthly, without inferring that from
      per-row imported_at timestamps (ambiguous after an upsert, since
      unrelated rows can have different imported_at values within the
      same logical import run). */
exports.up = (pgm) => {
  pgm.addConstraint('tbae_registrants', 'tbae_registrants_profession_reg_no_unique', {
    unique: ['profession', 'reg_no']
  });

  pgm.createTable('tbae_import_state', {
    id: { type: 'bigserial', primaryKey: true },
    completed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    architect_count: { type: 'integer' },
    interior_designer_count: { type: 'integer' }
  });
};

exports.down = (pgm) => {
  pgm.dropTable('tbae_import_state');
  pgm.dropConstraint('tbae_registrants', 'tbae_registrants_profession_reg_no_unique');
};
