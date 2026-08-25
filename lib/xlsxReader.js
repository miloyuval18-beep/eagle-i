// Minimal .xlsx reader — extracts flat row/column data from a single-sheet
// workbook. Deliberately hand-rolled instead of using the `xlsx` package
// (unfixed high-severity prototype-pollution/ReDoS advisories) or `exceljs`
// (pulls in a vulnerable transitive `uuid`). An .xlsx file is just a ZIP
// archive of XML parts; this reads only the two parts a flat data sheet
// needs (shared strings + the first worksheet) using Node's built-in zlib
// for DEFLATE decompression — no third-party dependency.
const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const CDFH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

// Returns { filename: Buffer } for the requested filenames found in the zip.
function readZipEntries(buf, wantedNames) {
  const wanted = new Set(wantedNames);
  const found = {};

  // Find End Of Central Directory record (search from the end; there's no
  // zip comment in these files, so it's always in the last 22 bytes).
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error('Not a valid zip/xlsx file (no End Of Central Directory record).');

  const cdEntryCount = buf.readUInt16LE(eocdOffset + 10);
  let cdOffset = buf.readUInt32LE(eocdOffset + 16);

  for (let i = 0; i < cdEntryCount && Object.keys(found).length < wanted.size; i++) {
    if (buf.readUInt32LE(cdOffset) !== CDFH_SIG) break;
    const compressionMethod = buf.readUInt16LE(cdOffset + 10);
    const compressedSize = buf.readUInt32LE(cdOffset + 20);
    const fileNameLen = buf.readUInt16LE(cdOffset + 28);
    const extraLen = buf.readUInt16LE(cdOffset + 30);
    const commentLen = buf.readUInt16LE(cdOffset + 32);
    const localHeaderOffset = buf.readUInt32LE(cdOffset + 42);
    const fileName = buf.toString('utf8', cdOffset + 46, cdOffset + 46 + fileNameLen);

    if (wanted.has(fileName)) {
      const lfhOffset = localHeaderOffset;
      if (buf.readUInt32LE(lfhOffset) !== LFH_SIG) throw new Error(`Corrupt local file header for ${fileName}.`);
      const lfhNameLen = buf.readUInt16LE(lfhOffset + 26);
      const lfhExtraLen = buf.readUInt16LE(lfhOffset + 28);
      const dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
      const compressedData = buf.subarray(dataStart, dataStart + compressedSize);
      found[fileName] = compressionMethod === 0 ? compressedData : zlib.inflateRawSync(compressedData);
    }

    cdOffset += 46 + fileNameLen + extraLen + commentLen;
  }

  return found;
}

function decodeXmlEntities(str) {
  return str
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const strings = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const text = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('');
    strings.push(decodeXmlEntities(text));
  }
  return strings;
}

// Returns an array of rows, each row an array of cell values indexed by
// column (A=0, B=1, ...), for a simple flat worksheet (no merged cells,
// no formulas needed).
function parseSheetRows(xml, sharedStrings) {
  const rows = [];
  const rowRe = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(xml))) {
    const rowNum = parseInt(rowMatch[1], 10);
    const cells = [];
    const cellRe = /<c r="([A-Z]+)(\d+)"([^>]*)>(?:([\s\S]*?)<\/c>|)/g;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowMatch[2] + '<c r="ZZ0"></c>'))) {
      if (cellMatch[1] === 'ZZ') break; // sentinel to end the loop cleanly
      const colLetters = cellMatch[1];
      const attrs = cellMatch[3] || '';
      const inner = cellMatch[4] || '';
      const colIndex = colLetters.split('').reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;
      const isSharedString = /t="s"/.test(attrs);
      const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
      let value = vMatch ? vMatch[1] : '';
      if (isSharedString && value !== '') value = sharedStrings[parseInt(value, 10)] || '';
      else value = decodeXmlEntities(value);
      cells[colIndex] = value;
    }
    rows[rowNum] = cells;
  }
  return rows;
}

// Reads the first worksheet of an .xlsx file buffer and returns an array of
// row arrays (1-indexed rows preserved as gaps, matching the sheet's own
// row numbers — callers typically skip header rows by content, not index).
function readXlsxFirstSheet(buf) {
  const entries = readZipEntries(buf, ['xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml']);
  if (!entries['xl/worksheets/sheet1.xml']) throw new Error('No worksheet found in this .xlsx file.');
  const sharedStrings = parseSharedStrings(entries['xl/sharedStrings.xml'] && entries['xl/sharedStrings.xml'].toString('utf8'));
  const rows = parseSheetRows(entries['xl/worksheets/sheet1.xml'].toString('utf8'), sharedStrings);
  return rows.filter(Boolean); // drop sparse-array holes from skipped row numbers
}

module.exports = { readXlsxFirstSheet };
