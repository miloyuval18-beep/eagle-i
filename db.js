// Single shared Postgres pool, used by every route module.
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('WARNING: DATABASE_URL is not set — database-backed routes will fail.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render's managed Postgres requires SSL; local Postgres usually doesn't
  // present a cert, so only require it when NOT explicitly running local.
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false }
});

// pg.Pool emits 'error' for problems on already-idle clients (e.g. the DB
// restarting) outside any in-flight query. Without a handler here, Node
// treats that as an uncaught exception and kills the whole process.
pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client:', err.message);
});

module.exports = { pool, query: (text, params) => pool.query(text, params) };
