// Why an email is "for your information" (lib/crmEmailWatch.js): null = only copied,
// 'for' = it was for a teammate ("Hi Maria", or the same email to both), 'fyi' = sent
// to them, nothing to answer.
exports.up = (pgm) => {
  pgm.addColumns('crm_mail_loop', { why: { type: 'varchar(10)' } });
};
exports.down = (pgm) => { pgm.dropColumns('crm_mail_loop', ['why'], { ifExists: true }); };
