// Minimal RFC4180-ish CSV parser — every field in TSBPE's real export is
// double-quoted, and some contain embedded commas (addresses, insurance
// company names like "HOOPER & HINES INSURANCE"), so a naive split(',')
// silently misaligns columns on exactly those rows. Handles quoted
// fields, embedded commas, escaped "" (a literal quote inside a quoted
// field), and \r\n or \n line endings. No third-party dependency, same
// hand-rolled posture as lib/xlsxReader.js.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  // Strip a UTF-8 BOM if present — TSBPE's export starts with one.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r') {
      // ignore — the following \n (if any) ends the row
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter(r => r.length > 1 || r[0] !== '');
}

// Rows -> array of objects keyed by the first row's header names.
function parseCsvObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).map(r => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = r[i] !== undefined ? r[i] : ''; });
    return obj;
  });
}

module.exports = { parseCsv, parseCsvObjects };
