// Reads the first worksheet of an old-style Excel file (.xls, Excel 97-2003),
// the kind older estimating tools and accounting exports still produce. No
// third-party dependency, like lib/xlsxReader.js. Returns rows as arrays of
// strings (numbers as plain digits; dates stay Excel serial numbers, which the
// importer understands).
//
// The file is a "compound file" (a little FAT file system); inside it the
// "Workbook" stream is a list of BIFF8 records. Text cells point into one
// shared string table that can be split across CONTINUE records mid-string.

function err(message) { const e = new Error(message); e.status = 400; return e; }

// ---------- the compound file ----------
function readCompound(buf) {
  if (buf.length < 512 || buf.readUInt32LE(0) !== 0xE011CFD0 || buf.readUInt32LE(4) !== 0xE11AB1A1) throw err('That isn’t an Excel .xls file.');
  const secSize = 1 << buf.readUInt16LE(0x1E);
  const miniSize = 1 << buf.readUInt16LE(0x20);
  const nFat = buf.readUInt32LE(0x2C);
  const dirStart = buf.readInt32LE(0x30);
  const miniCutoff = buf.readUInt32LE(0x38);
  const miniFatStart = buf.readInt32LE(0x3C);
  let difatSector = buf.readInt32LE(0x44);
  const sector = (n) => { const off = (n + 1) * secSize; if (n < 0 || off + secSize > buf.length + secSize) throw err('This .xls file looks damaged.'); return buf.subarray(off, Math.min(off + secSize, buf.length)); };
  // The FAT's own sectors: 109 listed in the header, the rest in a chain of DIFAT sectors.
  const fatSectors = [];
  for (let i = 0; i < 109 && fatSectors.length < nFat; i++) { const s = buf.readInt32LE(0x4C + i * 4); if (s >= 0) fatSectors.push(s); }
  for (let guard = 0; fatSectors.length < nFat && difatSector >= 0 && guard < 10000; guard++) {
    const d = sector(difatSector);
    for (let i = 0; i < secSize / 4 - 1 && fatSectors.length < nFat; i++) { const s = d.readInt32LE(i * 4); if (s >= 0) fatSectors.push(s); }
    difatSector = d.readInt32LE(secSize - 4);
  }
  const fat = [];
  for (const s of fatSectors) { const d = sector(s); for (let i = 0; i < d.length / 4; i++) fat.push(d.readInt32LE(i * 4)); }
  const chain = (start, table) => { const out = []; let n = start; const seen = new Set(); while (n >= 0 && n < table.length && !seen.has(n)) { seen.add(n); out.push(n); n = table[n]; } return out; };
  const readChain = (start) => Buffer.concat(chain(start, fat).map(sector));
  // Directory: 128-byte entries.
  const dir = readChain(dirStart);
  const entries = [];
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nameLen = dir.readUInt16LE(off + 64);
    entries.push({ name: dir.toString('utf16le', off, off + Math.max(0, nameLen - 2)), type: dir[off + 66], start: dir.readInt32LE(off + 116), size: dir.readUInt32LE(off + 120) });
  }
  const root = entries.find(e => e.type === 5);
  const stream = (name) => {
    const e = entries.find(x => x.type === 2 && x.name.toLowerCase() === name.toLowerCase());
    if (!e) return null;
    if (e.size >= miniCutoff) return readChain(e.start).subarray(0, e.size);
    // Small streams live in the "mini stream", in 64-byte pieces with their own FAT.
    const miniFat = [];
    if (miniFatStart >= 0) { const m = readChain(miniFatStart); for (let i = 0; i < m.length / 4; i++) miniFat.push(m.readInt32LE(i * 4)); }
    const ministream = readChain(root.start);
    return Buffer.concat(chain(e.start, miniFat).map(n => ministream.subarray(n * miniSize, (n + 1) * miniSize))).subarray(0, e.size);
  };
  return { stream };
}

// ---------- BIFF8 ----------
function records(wb) {
  const out = [];
  for (let off = 0; off + 4 <= wb.length;) {
    const type = wb.readUInt16LE(off), len = wb.readUInt16LE(off + 2);
    out.push({ type, off, data: wb.subarray(off + 4, off + 4 + len) });
    off += 4 + len;
  }
  return out;
}

// A cursor over the SST record and its CONTINUE records: characters that run
// into the next record start again with a fresh "high byte" flag.
function readSst(parts) {
  let p = 0, pos = 0;
  const strings = [];
  const left = () => parts[p].length - pos;
  const next = () => { p++; pos = 0; };
  const u8 = () => { if (left() < 1) next(); return parts[p][pos++]; };
  const u16 = () => { if (left() < 2) next(); const v = parts[p].readUInt16LE(pos); pos += 2; return v; };
  const u32 = () => { if (left() < 4) next(); const v = parts[p].readUInt32LE(pos); pos += 4; return v; };
  const skip = (n) => { while (n > 0) { if (left() === 0) next(); const k = Math.min(n, left()); pos += k; n -= k; } };
  if (!parts.length) return strings;
  u32(); const unique = u32();
  for (let i = 0; i < unique && p < parts.length; i++) {
    if (left() === 0) { if (p + 1 >= parts.length) break; next(); }
    let cch = u16(); const flags = u8();
    let high = flags & 1;
    const runs = flags & 8 ? u16() : 0;
    const ext = flags & 4 ? u32() : 0;
    let s = '';
    while (cch > 0) {
      if (left() === 0) { next(); high = parts[p][pos++] & 1; }
      const per = high ? 2 : 1;
      const n = Math.min(cch, Math.floor(left() / per));
      s += high ? parts[p].toString('utf16le', pos, pos + n * 2) : parts[p].toString('latin1', pos, pos + n);
      pos += n * per; cch -= n;
    }
    skip(runs * 4 + ext);
    strings.push(s);
  }
  return strings;
}

function rk(v) {
  let n;
  if (v & 2) n = v >> 2;
  else { const b = Buffer.alloc(8); b.writeUInt32LE(0, 0); b.writeUInt32LE((v & 0xFFFFFFFC) >>> 0, 4); n = b.readDoubleLE(0); }
  return v & 1 ? n / 100 : n;
}
const num = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1e9) / 1e9));
function xlString(d, off) {
  const cch = d.readUInt16LE(off), high = d[off + 2] & 1;
  return high ? d.toString('utf16le', off + 3, off + 3 + cch * 2) : d.toString('latin1', off + 3, off + 3 + cch);
}

function readXlsFirstSheet(buf) {
  const cf = readCompound(buf);
  const wb = cf.stream('Workbook') || cf.stream('Book');
  if (!wb) throw err('No worksheet found in this .xls file.');
  const recs = records(wb);
  if (!recs.length || recs[0].type !== 0x0809 || recs[0].data.readUInt16LE(0) !== 0x0600) throw err('This .xls is from Excel 95 or older. Save it as .xlsx or .csv first.');
  // The shared strings, and where the first worksheet starts.
  let sst = [];
  let firstSheet = null;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (r.type === 0x0085 && firstSheet == null && r.data[5] === 0) firstSheet = r.data.readUInt32LE(0); // BOUNDSHEET, a worksheet
    if (r.type === 0x00FC) { const parts = [r.data]; for (let j = i + 1; j < recs.length && recs[j].type === 0x003C; j++) parts.push(recs[j].data); sst = readSst(parts); }
  }
  if (firstSheet == null) throw err('No worksheet found in this .xls file.');
  const rows = [];
  const put = (r, c, v) => { (rows[r] = rows[r] || [])[c] = v; };
  let pendingFormula = null;
  for (const r of recs) {
    if (r.off < firstSheet) continue;
    if (r.type === 0x000A) break; // the sheet's EOF
    const d = r.data;
    switch (r.type) {
      case 0x00FD: put(d.readUInt16LE(0), d.readUInt16LE(2), sst[d.readUInt32LE(6)] ?? ''); break; // LABELSST
      case 0x0204: put(d.readUInt16LE(0), d.readUInt16LE(2), xlString(d, 6)); break; // LABEL
      case 0x0203: put(d.readUInt16LE(0), d.readUInt16LE(2), num(d.readDoubleLE(6))); break; // NUMBER
      case 0x027E: put(d.readUInt16LE(0), d.readUInt16LE(2), num(rk(d.readUInt32LE(6)))); break; // RK
      case 0x00BD: { // MULRK
        const row = d.readUInt16LE(0), first = d.readUInt16LE(2);
        const count = (d.length - 6) / 6;
        for (let k = 0; k < count; k++) put(row, first + k, num(rk(d.readUInt32LE(4 + k * 6 + 2))));
        break;
      }
      case 0x0205: put(d.readUInt16LE(0), d.readUInt16LE(2), d[7] ? '' : d[6] ? 'TRUE' : 'FALSE'); break; // BOOLERR
      case 0x0006: { // FORMULA: keep its last calculated value
        const row = d.readUInt16LE(0), col = d.readUInt16LE(2);
        if (d.readUInt16LE(12) === 0xFFFF) { if (d[6] === 0) pendingFormula = { row, col }; else if (d[6] === 1) put(row, col, d[8] ? 'TRUE' : 'FALSE'); }
        else put(row, col, num(d.readDoubleLE(6)));
        break;
      }
      case 0x0207: if (pendingFormula) { put(pendingFormula.row, pendingFormula.col, xlString(d, 0)); pendingFormula = null; } break; // STRING (a formula's text result)
      default: break;
    }
  }
  return rows.filter(Boolean).map(r => Array.from(r, v => (v == null ? '' : v)));
}

module.exports = { readXlsFirstSheet, readCompound, readSst, rk };
