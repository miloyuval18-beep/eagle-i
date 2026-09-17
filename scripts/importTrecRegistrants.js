#!/usr/bin/env node
// Manual, on-demand run of the same full TREC broker import
// lib/trecRosterWorker.js runs automatically once a month. See
// lib/trecRegistrants.js's runFullImport.
//
// Usage:
//   node scripts/importTrecRegistrants.js               # fetches, imports, writes to DB
//   node scripts/importTrecRegistrants.js --dry-run      # fetches + parses, prints summary, writes nothing

const path = require('path');
const ROOT = path.join(__dirname, '..');

function loadDotEnvValue(key) {
  const fs = require('fs');
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const line = text.split('\n').find(l => l.startsWith(key + '='));
    return line ? line.slice(key.length + 1).trim() : undefined;
  } catch {
    return undefined;
  }
}
if (!process.env.DATABASE_URL) {
  const v = loadDotEnvValue('DATABASE_URL');
  if (v) process.env.DATABASE_URL = v;
}

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not found in env or .env.');
  const { runFullImport } = require('../lib/trecRegistrants');
  const counts = await runFullImport({ dryRun: DRY_RUN, log: console.log });
  console.log('\nCounts:', counts);
  console.log('Done.');
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('Import failed:', err.message); process.exit(1); });
