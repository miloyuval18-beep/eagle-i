/* Eagle I CRM, step 13: qualifying and booking.

   On each deal: a fit score (0-100, grade A/B/C) with its reasons, the
   homeowner's questionnaire answers, and the pre-visit brief written for
   whoever goes out to the house. */
exports.up = (pgm) => {
  pgm.addColumns('crm_deals', {
    score: { type: 'smallint' },
    grade: { type: 'varchar(1)' },
    score_reasons: { type: 'jsonb' },
    qualify: { type: 'jsonb' }, // { types, budget, timeline, decision, notes, answered_at }
    brief: { type: 'text' },
    brief_at: { type: 'timestamptz' },
    site_visit_user_id: { type: 'uuid', references: 'users', onDelete: 'set null' }
  }, { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropColumns('crm_deals', ['score', 'grade', 'score_reasons', 'qualify', 'brief', 'brief_at', 'site_visit_user_id'], { ifExists: true });
};
