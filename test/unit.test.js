// Pure-logic unit tests — no DB, no network, no external service. These run
// in well under a second and should never be skipped/flaky.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseClaudeJson } = require('../lib/anthropic');
const { getHighValueZipInfo, HOUSTON_HIGH_VALUE_ZIPS } = require('../lib/houstonZipValues');
const { escapeHtml } = require('../lib/landingPageTemplate');
const { readXlsxFirstSheet } = require('../lib/xlsxReader');

describe('parseClaudeJson (lib/anthropic.js)', () => {
  test('parses well-formed JSON embedded in surrounding text', () => {
    const raw = 'Here is the result:\n{"a": 1, "b": "two"}\nHope that helps!';
    assert.deepEqual(parseClaudeJson(raw), { a: 1, b: 'two' });
  });

  test('repairs a single-quoted property name without touching string values', () => {
    // Reproduces the exact bug found in production: a single-quoted key
    // right after a string value containing an apostrophe.
    const raw = `{"headline":"You're Constantly...", 'p':"Clutter and mess"}`;
    const parsed = parseClaudeJson(raw);
    assert.equal(parsed.headline, "You're Constantly...");
    assert.equal(parsed.p, 'Clutter and mess');
  });

  test('does not mangle an apostrophe inside a string value', () => {
    const raw = `{"quote":"that's a strong signal","title":"Your Home's Layout No Longer Fits Your Life"}`;
    const parsed = parseClaudeJson(raw);
    assert.equal(parsed.quote, "that's a strong signal");
    assert.equal(parsed.title, "Your Home's Layout No Longer Fits Your Life");
  });

  test('throws a clear error when no JSON object is present', () => {
    assert.throws(() => parseClaudeJson('no json here at all'), /No JSON in Claude response/);
  });
});

describe('getHighValueZipInfo (lib/houstonZipValues.js)', () => {
  test('returns neighborhood info for a known high-value zip', () => {
    const known = HOUSTON_HIGH_VALUE_ZIPS[0];
    const info = getHighValueZipInfo(known.zip);
    assert.equal(info.neighborhood, known.neighborhood);
    assert.equal(info.approxMedianValue, known.approxMedianValue);
  });

  test('returns null for a zip not in the curated list', () => {
    assert.equal(getHighValueZipInfo('00000'), null);
  });
});

describe('escapeHtml (lib/landingPageTemplate.js)', () => {
  test('escapes all five HTML-significant characters', () => {
    assert.equal(escapeHtml(`<script>&"'`), '&lt;script&gt;&amp;&quot;&#39;');
  });

  test('leaves a plain string untouched', () => {
    assert.equal(escapeHtml('Acme Roofing Co.'), 'Acme Roofing Co.');
  });

  test('handles null/undefined without throwing', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });
});

describe('readXlsxFirstSheet (lib/xlsxReader.js)', () => {
  test('throws a clear error on a buffer that is not a zip at all', () => {
    assert.throws(() => readXlsxFirstSheet(Buffer.from('not a zip file')));
  });
});
