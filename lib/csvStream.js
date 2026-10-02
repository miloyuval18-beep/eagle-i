// Streaming CSV reader for the big statewide files (CSLB is ~77MB, DRE ~72MB
// uncompressed). lib/csvReader.js builds every row as an object in memory, which
// is fine for the Texas files but would blow past a small server's memory on
// these -- and only a few percent of their rows are in a market we serve. This
// feeds text in as it arrives and hands each row to a callback as an array, so
// the caller can keep or drop it immediately.
//
// Same dialect as csvReader.js: quoted fields, embedded commas/newlines, "" as
// an escaped quote, \r\n or \n line ends, optional BOM.

// `chunks` is any sync or async iterable of strings. `onRow(fields, rowNumber)`
// is called for every row including the header (rowNumber 0).
async function parseCsvStream(chunks, onRow) {
  let row = [];
  let field = '';
  let inQuotes = false;
  let pendingQuote = false; // a '"' seen inside quotes, waiting to learn if it is "" or the end
  let rowNumber = 0;
  let first = true;

  const endRow = () => {
    row.push(field);
    field = '';
    if (row.length > 1 || row[0] !== '') onRow(row, rowNumber++);
    row = [];
  };

  for await (let text of chunks) {
    if (first) { if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); first = false; }
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (pendingQuote) {
        pendingQuote = false;
        if (c === '"') { field += '"'; continue; }
        inQuotes = false; // the quote closed the field; fall through and handle c normally
      }
      if (inQuotes) {
        if (c === '"') pendingQuote = true;
        else field += c;
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field);
        field = '';
      } else if (c === '\n') {
        endRow();
      } else if (c !== '\r') {
        field += c;
      }
    }
  }
  if (pendingQuote) inQuotes = false;
  if (field !== '' || row.length) endRow();
  return rowNumber;
}

// Decodes a Buffer (or a fetch Response body) into text chunks of a given
// encoding without ever holding the whole decoded string.
function* bufferTextChunks(buf, encoding = 'utf-8', chunkBytes = 1 << 20) {
  const dec = new TextDecoder(encoding);
  for (let i = 0; i < buf.length; i += chunkBytes) {
    yield dec.decode(buf.subarray(i, Math.min(buf.length, i + chunkBytes)), { stream: true });
  }
  const tail = dec.decode();
  if (tail) yield tail;
}

async function* responseTextChunks(body, encoding = 'utf-8') {
  const dec = new TextDecoder(encoding);
  for await (const part of body) yield dec.decode(part, { stream: true });
  const tail = dec.decode();
  if (tail) yield tail;
}

module.exports = { parseCsvStream, bufferTextChunks, responseTextChunks };
