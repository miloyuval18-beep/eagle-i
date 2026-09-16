#!/usr/bin/env node
// Manual, on-demand run of the same full TBAE roster import
// lib/tbaeRosterWorker.js runs automatically once a month in production —
// useful for an immediate refresh, or for testing, without waiting for
// the worker's monthly tick. See lib/tbaeRegistrants.js's runFullImport
// for what this actually does (download, parse, upsert-by-reg_no so
// already-collected Places contact data survives the re-import).
//
// Usage:
//   node scripts/importTbaeRoster.js               # downloads, imports, writes to DB
//   node scripts/importTbaeRoster.js --dry-run      # downloads + parses, prints summary, writes nothing

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
  const fromDotEnv = loadDotEnvValue('DATABASE_URL');
  if (fromDotEnv) process.env.DATABASE_URL = fromDotEnv;
}

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not found in env or .env.');
  }
  const { runFullImport } = require('../lib/tbaeRegistrants');
  await runFullImport({ dryRun: DRY_RUN, log: console.log });
  console.log('Done.');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Import failed:', err.message);
    process.exit(1);
  });
