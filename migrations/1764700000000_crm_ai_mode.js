/* Eagle I CRM: how each person likes to use the assistant, asked the first time
   they open it: 'talk' (a spoken conversation) or 'text' (typing). NULL: not asked yet. */
exports.up = (pgm) => {
  pgm.addColumns('users', { ai_mode: { type: 'varchar(8)' } }, { ifNotExists: true });
};
exports.down = (pgm) => {
  pgm.dropColumns('users', ['ai_mode'], { ifExists: true });
};
