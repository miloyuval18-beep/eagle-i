#!/usr/bin/env node
// Manual/periodic import of REAL architects and Registered Interior
// Designers from the Texas Board of Architectural Examiners' own public
// roster download (indreg.tbae.texas.gov/Reports/RegistrantRosters) —
// confirmed live: real, current .xlsx files, described by TBAE itself as
// real-time data, not a scrape of the search-box lookup tool.
//
// Why this is a local script and not a live route: same reasoning as
// scripts/importHcadZipValues.js — TBAE has no per-city API, only a
// full-roster download per profession, and there's no reason to hit that
// on every request when the roster only meaningfully changes as fast as
// the board processes new registrations/renewals. Run this from a
// developer machine against the same DATABASE_URL the app uses, every
// few weeks is plenty.
//
// Usage:
//   node scripts/importTbaeRoster.js               # downloads, imports, writes to DB
//   node scripts/importTbaeRoster.js --dry-run      # downloads + parses, prints summary, writes nothing

const path = require('path');
const { readXlsxFirstSheet } = require('../lib/xlsxReader');

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
const ROSTER_URL = (typeId) => `https://indreg.tbae.texas.gov/Reports/RegistrantRostersDownload?profession_type_id=${typeId}`;

async function downloadRoster(typeId, label) {
  console.log(`Downloading ${label} roster...`);
  const r = await fetch(ROSTER_URL(typeId), {
    headers: { 'User-Agent': 'EagleI (https://myeaglei.com, admin@myeaglei.com)' }
  });
  if (!r.ok) throw new Error(`${label} roster download failed: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  console.log(`  Downloaded ${(buf.length / 1e3).toFixed(0)}KB.`);
  return buf;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not found in env or .env.');
  }

  const { ROSTER_PROFESSION_TYPE_ID, HOUSTON_METRO_CITIES, parseRosterRows, replaceRegistrantsForProfession } =
    require('../lib/tbaeRegistrants');

  const professions = [
    { key: 'architect', label: 'Architects' },
    { key: 'interior_designer', label: 'Registered Interior Designers' }
  ];

  for (const { key, label } of professions) {
    const buf = await downloadRoster(ROSTER_PROFESSION_TYPE_ID[key], label);
    const rawRows = readXlsxFirstSheet(buf);
    const rows = parseRosterRows(rawRows, key);
    const active = rows.filter(r => r.licStatus === 'Active');
    const published = active.filter(r => r.firmName && r.city);
    const houstonMetro = published.filter(r => HOUSTON_METRO_CITIES.includes((r.city || '').toUpperCase()));
    console.log(`  Parsed ${rows.length.toLocaleString()} total, ${active.length.toLocaleString()} active, ${published.length.toLocaleString()} with a published firm+city, ${houstonMetro.length.toLocaleString()} in the Houston metro area.`);

    if (DRY_RUN) {
      console.log(`  --dry-run: not writing ${label} to the database.`);
      continue;
    }
    console.log(`  Writing ${rows.length.toLocaleString()} rows to tbae_registrants (replacing the previous ${label} import)...`);
    await replaceRegistrantsForProfession(key, rows);
  }

  console.log('Done.');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Import failed:', err.message);
    process.exit(1);
  });
