/* Platform-admin flag — lets a designated account see all tenants
   (read-only) regardless of their own tenant's data. */

exports.up = (pgm) => {
  pgm.addColumns('users', {
    is_admin: { type: 'boolean', notNull: true, default: false }
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('users', ['is_admin']);
};
