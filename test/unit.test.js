// Pure-logic unit tests — no DB, no network, no external service. These run
// in well under a second and should never be skipped/flaky.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseClaudeJson } = require('../lib/anthropic');
const { getHighValueZipInfo, HOUSTON_HIGH_VALUE_ZIPS } = require('../lib/houstonZipValues');
const { escapeHtml } = require('../lib/landingPageTemplate');
const { readXlsxFirstSheet } = require('../lib/xlsxReader');
const { detectPermitSpikes } = require('../lib/houstonPermits');
const { buildRealAcctHeaderIndex, parseRealAcctLine, parseRealAcctOwnerLine, aggregateZipValues } = require('../lib/hcadZipValues');
const { looksLikeBusinessOrPlaceholder, parseOwnerPersonName, normalizeAddress } = require('../lib/hcadOwnerNames');
const { budgetError } = require('../routes/ads');
const { parseImageDataUrl } = require('../routes/images');
const { isPrivateOrReservedIp, extractEmails, findContactPageUrl } = require('../lib/vendorContactFinder');
const { buildReplyToAddress } = require('../lib/email');
const { REPLY_ADDRESS_RE } = require('../routes/inboundEmail');
const { detectsHighValueFocus, topHighValueNeighborhoods, addressInHighValueZip } = require('../lib/vendorTargeting');
const { getZipRegion, HOUSTON_ZIP_REGIONS } = require('../lib/houstonZipRegions');
const { describeWorkType, humanizeComments, buildPermitLetter } = require('../lib/permitMailer');
const { qualifiesForPermits } = require('../lib/realEstateAccess');

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

describe('HCAD real_acct.txt parsing (lib/hcadZipValues.js)', () => {
  test('buildRealAcctHeaderIndex maps column names to positions', () => {
    const idx = buildRealAcctHeaderIndex('acct\tyr\tsite_addr_3\ttot_mkt_val');
    assert.equal(idx.acct, 0);
    assert.equal(idx.site_addr_3, 2);
    assert.equal(idx.tot_mkt_val, 3);
  });

  test('parseRealAcctLine extracts zip + market value from a real-shaped row', () => {
    const idx = { site_addr_3: 2, tot_mkt_val: 3 };
    const row = parseRealAcctLine(idx, 'X\tY\t77019\t450000');
    assert.deepEqual(row, { zip: '77019', marketValue: 450000 });
  });

  test('parseRealAcctLine trims a zip+4 down to 5 digits', () => {
    const idx = { site_addr_3: 0, tot_mkt_val: 1 };
    const row = parseRealAcctLine(idx, '77019-1234\t450000');
    assert.equal(row.zip, '77019');
  });

  test('parseRealAcctLine returns null for a blank/malformed row rather than throwing', () => {
    const idx = { site_addr_3: 0, tot_mkt_val: 1 };
    assert.equal(parseRealAcctLine(idx, ''), null);
    assert.equal(parseRealAcctLine(idx, '\t'), null);
    assert.equal(parseRealAcctLine(idx, 'notazip\t450000'), null);
    assert.equal(parseRealAcctLine(idx, '77019\t0'), null);
  });

  test('aggregateZipValues computes avg/median/count per zip', () => {
    const rows = [
      { zip: '77019', marketValue: 100 },
      { zip: '77019', marketValue: 200 },
      { zip: '77019', marketValue: 300 },
      { zip: '77002', marketValue: 50 }
    ];
    const stats = aggregateZipValues(rows);
    const z19 = stats.find(s => s.zip === '77019');
    assert.equal(z19.avgMarketValue, 200);
    assert.equal(z19.medianMarketValue, 200);
    assert.equal(z19.parcelCount, 3);
    const z02 = stats.find(s => s.zip === '77002');
    assert.equal(z02.avgMarketValue, 50);
    assert.equal(z02.parcelCount, 1);
  });

  test('aggregateZipValues sorts by parcel count descending', () => {
    const rows = [
      { zip: 'A', marketValue: 1 },
      { zip: 'B', marketValue: 1 }, { zip: 'B', marketValue: 1 }, { zip: 'B', marketValue: 1 }
    ];
    const stats = aggregateZipValues(rows);
    assert.equal(stats[0].zip, 'B');
    assert.equal(stats[1].zip, 'A');
  });
});

describe('budgetError (routes/ads.js)', () => {
  test('rejects non-positive or non-numeric budgets', () => {
    assert.match(budgetError(0), /positive number/);
    assert.match(budgetError(-500), /positive number/);
    assert.match(budgetError(NaN), /positive number/);
    assert.match(budgetError(undefined), /positive number/);
  });

  test('rejects a budget below the $1/day floor', () => {
    assert.match(budgetError(50), /at least \$1/);
  });

  test('rejects a budget above the $1,000/day safety ceiling', () => {
    assert.match(budgetError(100001), /safety ceiling/);
  });

  test('accepts a budget within range', () => {
    assert.equal(budgetError(5000), null);
    assert.equal(budgetError(100), null); // exactly at the $1/day floor
    assert.equal(budgetError(100000), null); // exactly at the $1,000/day ceiling
  });
});

describe('parseImageDataUrl (routes/images.js)', () => {
  const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

  test('accepts a well-formed PNG data URL', () => {
    const result = parseImageDataUrl(`data:image/png;base64,${TINY_PNG_BASE64}`);
    assert.equal(result.ok, true);
    assert.equal(result.mimeType, 'image/png');
    assert.ok(Buffer.isBuffer(result.buf));
    assert.ok(result.buf.length > 0);
  });

  test('normalizes image/jpg to image/jpeg', () => {
    const result = parseImageDataUrl(`data:image/jpg;base64,${TINY_PNG_BASE64}`);
    assert.equal(result.ok, true);
    assert.equal(result.mimeType, 'image/jpeg');
  });

  test('rejects a non-data-URL string', () => {
    const result = parseImageDataUrl('https://example.com/image.png');
    assert.equal(result.ok, false);
  });

  test('rejects an unsupported image type', () => {
    const result = parseImageDataUrl(`data:image/gif;base64,${TINY_PNG_BASE64}`);
    assert.equal(result.ok, false);
  });

  test('rejects an oversized image', () => {
    const bigBase64 = Buffer.alloc(9 * 1024 * 1024).toString('base64'); // 9MB raw > 8MB cap
    const result = parseImageDataUrl(`data:image/png;base64,${bigBase64}`);
    assert.equal(result.ok, false);
    assert.match(result.error, /too large/);
  });
});

describe('detectPermitSpikes (lib/houstonPermits.js)', () => {
  test('flags a zip whose most recent week is 40%+ above its prior weekly average', () => {
    const records = [
      ...['2026-08-03', '2026-08-04'].map(d => ({ zip: '77001', permitDate: d })),
      ...['2026-08-10', '2026-08-11'].map(d => ({ zip: '77001', permitDate: d })),
      ...['2026-08-17', '2026-08-18'].map(d => ({ zip: '77001', permitDate: d })),
      ...['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29'].map(d => ({ zip: '77001', permitDate: d }))
    ];
    const spikes = detectPermitSpikes(records);
    assert.equal(spikes.length, 1);
    assert.equal(spikes[0].zip, '77001');
    assert.equal(spikes[0].recentCount, 6);
    assert.equal(spikes[0].priorAvgCount, 2);
  });

  test('does not flag a flat, non-spiking zip', () => {
    const records = ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24'].map(d => ({ zip: '77002', permitDate: d }));
    assert.deepEqual(detectPermitSpikes(records), []);
  });

  test('ignores a zip with only one week of data (nothing to compare against)', () => {
    const records = [{ zip: '77003', permitDate: '2026-08-24' }, { zip: '77003', permitDate: '2026-08-25' }];
    assert.deepEqual(detectPermitSpikes(records), []);
  });

  test('ignores tiny-volume "spikes" below the minimum-count floor', () => {
    // Prior week: 1 permit. Recent week: 2 permits — a 100% increase by
    // ratio (well above the 40% threshold), but recentCount (2) is still
    // below the default floor of 3, so this should NOT register as a spike.
    const records = [
      { zip: '77004', permitDate: '2026-08-03' }, // week 1: 1 permit
      { zip: '77004', permitDate: '2026-08-10' }, // week 2 (recent): 2 permits
      { zip: '77004', permitDate: '2026-08-11' }
    ];
    assert.deepEqual(detectPermitSpikes(records, { minRecentCount: 3 }), []);
  });
});

describe('isPrivateOrReservedIp (lib/vendorContactFinder.js — SSRF guard)', () => {
  test('blocks loopback, private ranges, link-local/cloud-metadata, and CGNAT', () => {
    assert.equal(isPrivateOrReservedIp('127.0.0.1'), true);
    assert.equal(isPrivateOrReservedIp('10.0.0.5'), true);
    assert.equal(isPrivateOrReservedIp('172.16.0.1'), true);
    assert.equal(isPrivateOrReservedIp('172.31.255.255'), true);
    assert.equal(isPrivateOrReservedIp('192.168.1.1'), true);
    assert.equal(isPrivateOrReservedIp('169.254.169.254'), true); // cloud metadata endpoint
    assert.equal(isPrivateOrReservedIp('100.64.0.1'), true); // CGNAT
    assert.equal(isPrivateOrReservedIp('0.0.0.0'), true);
  });

  test('allows ordinary public IPv4 addresses', () => {
    assert.equal(isPrivateOrReservedIp('8.8.8.8'), false);
    assert.equal(isPrivateOrReservedIp('93.184.216.34'), false);
    // A 172.x address just outside the 172.16.0.0/12 private block.
    assert.equal(isPrivateOrReservedIp('172.32.0.1'), false);
  });

  test('blocks IPv6 loopback, link-local, unique-local, and mapped-IPv4-private', () => {
    assert.equal(isPrivateOrReservedIp('::1'), true);
    assert.equal(isPrivateOrReservedIp('fe80::1'), true);
    assert.equal(isPrivateOrReservedIp('fd00::1'), true);
    assert.equal(isPrivateOrReservedIp('::ffff:127.0.0.1'), true);
  });

  test('fails closed on a non-IP string', () => {
    assert.equal(isPrivateOrReservedIp('not-an-ip'), true);
  });
});

describe('extractEmails (lib/vendorContactFinder.js)', () => {
  test('prefers a mailto: link over plain-text email matches', () => {
    const html = '<a href="mailto:info@example-vendor.com">Email us</a><p>fallback@other.com</p>';
    assert.deepEqual(extractEmails(html), ['info@example-vendor.com']);
  });

  test('falls back to a plain-text email when no mailto: link exists', () => {
    const html = '<p>Reach us at contact@example-vendor.com any time.</p>';
    assert.deepEqual(extractEmails(html), ['contact@example-vendor.com']);
  });

  test('filters out image-filename false positives and known junk/tracking domains', () => {
    const html = `
      <img src="team@2x.png">
      <script>ga('set', 'x', 'abc@wixpress.com')</script>
      <a href="mailto:noreply@example-vendor.com">no-reply</a>
      <p>real-contact@example-vendor.com</p>`;
    assert.deepEqual(extractEmails(html), ['real-contact@example-vendor.com']);
  });

  test('returns an empty array when nothing looks like a real email', () => {
    assert.deepEqual(extractEmails('<p>No contact info here.</p>'), []);
  });
});

describe('findContactPageUrl (lib/vendorContactFinder.js)', () => {
  test('finds a link whose text says "Contact" and resolves it against the base URL', () => {
    const html = '<nav><a href="/about">About</a><a href="/contact-us">Contact Us</a></nav>';
    assert.equal(findContactPageUrl(html, 'https://example-vendor.com/'), 'https://example-vendor.com/contact-us');
  });

  test('returns null when no contact-ish link exists', () => {
    const html = '<nav><a href="/about">About</a><a href="/services">Services</a></nav>';
    assert.equal(findContactPageUrl(html, 'https://example-vendor.com/'), null);
  });
});

describe('buildReplyToAddress (lib/email.js)', () => {
  test('returns null when RESEND_INBOUND_DOMAIN is not set', () => {
    const saved = process.env.RESEND_INBOUND_DOMAIN;
    delete process.env.RESEND_INBOUND_DOMAIN;
    try {
      assert.equal(buildReplyToAddress('vendor', 'abc-123'), null);
    } finally {
      if (saved !== undefined) process.env.RESEND_INBOUND_DOMAIN = saved;
    }
  });

  test('builds a reply+<kind>-<id>@<domain> address when configured', () => {
    const saved = process.env.RESEND_INBOUND_DOMAIN;
    process.env.RESEND_INBOUND_DOMAIN = 'xyz.resend.app';
    try {
      const id = '11111111-1111-1111-1111-111111111111';
      assert.equal(buildReplyToAddress('vendor', id), `reply+vendor-${id}@xyz.resend.app`);
      assert.equal(buildReplyToAddress('review', id), `reply+review-${id}@xyz.resend.app`);
    } finally {
      if (saved === undefined) delete process.env.RESEND_INBOUND_DOMAIN;
      else process.env.RESEND_INBOUND_DOMAIN = saved;
    }
  });

  test('rejects an unknown kind rather than silently building a bad address', () => {
    process.env.RESEND_INBOUND_DOMAIN = 'xyz.resend.app';
    try {
      assert.throws(() => buildReplyToAddress('bogus', 'abc-123'));
    } finally {
      delete process.env.RESEND_INBOUND_DOMAIN;
    }
  });
});

describe('REPLY_ADDRESS_RE (routes/inboundEmail.js)', () => {
  test('matches a well-formed reply+<kind>-<uuid>@ address and captures kind + id', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    const m = REPLY_ADDRESS_RE.exec(`reply+vendor-${id}@abc123.resend.app`);
    assert.ok(m);
    assert.equal(m[1], 'vendor');
    assert.equal(m[2], id);
  });

  test('rejects addresses that are not our reply+ token shape', () => {
    assert.equal(REPLY_ADDRESS_RE.exec('someone@example.com'), null);
    assert.equal(REPLY_ADDRESS_RE.exec('reply+unknown-550e8400-e29b-41d4-a716-446655440000@abc.resend.app'), null);
    assert.equal(REPLY_ADDRESS_RE.exec('reply+vendor-not-a-uuid@abc.resend.app'), null);
  });
});

describe('detectsHighValueFocus (lib/vendorTargeting.js)', () => {
  test('detects an explicit luxury-market bio, matching the Levi Homes example', () => {
    assert.equal(detectsHighValueFocus('We build luxury custom homes for discerning clients.', ''), true);
  });

  test('detects across multiple text fields (services + differentiators) combined', () => {
    assert.equal(detectsHighValueFocus('General contracting', 'We specialize in high-end estate renovations'), true);
  });

  test('is case-insensitive', () => {
    assert.equal(detectsHighValueFocus('LUXURY home builder', ''), true);
  });

  test('returns false for an ordinary bio with no high-value language', () => {
    assert.equal(detectsHighValueFocus('We repair roofs and gutters for local homeowners.', 'Fast, honest, affordable.'), false);
  });

  test('handles null/undefined/empty fields without throwing', () => {
    assert.equal(detectsHighValueFocus(null, undefined, ''), false);
  });
});

describe('topHighValueNeighborhoods (lib/vendorTargeting.js)', () => {
  test('returns the requested count, highest approxMedianValue first', () => {
    const top3 = topHighValueNeighborhoods(3);
    assert.equal(top3.length, 3);
    assert.equal(top3[0], 'River Oaks'); // highest approxMedianValue in the curated list
  });

  test('defaults to 5 when no count is given', () => {
    assert.equal(topHighValueNeighborhoods().length, 5);
  });
});

describe('addressInHighValueZip (lib/vendorTargeting.js)', () => {
  test('matches a real Places-shaped address in a known high-value zip', () => {
    assert.equal(addressInHighValueZip('2100 River Oaks Blvd, Houston, TX 77019, USA'), true);
  });

  test('does not match an address in an untracked zip', () => {
    assert.equal(addressInHighValueZip('123 Main St, Houston, TX 77002, USA'), false);
  });

  test('does not mistake a street number for a zip code', () => {
    // 77019 appears as a street number here, not after a state code — must not match.
    assert.equal(addressInHighValueZip('77019 Nowhere Rd, Beaumont, TX 77701, USA'), false);
  });

  test('handles a missing/empty address without throwing', () => {
    assert.equal(addressInHighValueZip(null), false);
    assert.equal(addressInHighValueZip(''), false);
  });
});

describe('qualifiesForPermits (lib/realEstateAccess.js)', () => {
  test('qualifies by industry alone, regardless of company name', () => {
    assert.equal(qualifiesForPermits({ industry: 'home_services', companyName: 'Anything Inc' }), true);
    assert.equal(qualifiesForPermits({ industry: 'real_estate', companyName: 'Anything Inc' }), true);
  });

  test('qualifies a construction-named company under a non-real-estate industry', () => {
    assert.equal(qualifiesForPermits({ industry: 'other', companyName: 'ABC Construction LLC' }), true);
    assert.equal(qualifiesForPermits({ industry: 'professional_services', companyName: 'Smith General Contracting' }), true);
    assert.equal(qualifiesForPermits({ industry: 'other', companyName: 'Gulf Coast Roofing' }), true);
    assert.equal(qualifiesForPermits({ industry: 'retail', companyName: 'Houston Remodelers' }), true);
  });

  test('is case-insensitive', () => {
    assert.equal(qualifiesForPermits({ industry: 'other', companyName: 'lone star CONSTRUCTION co' }), true);
  });

  test('does not qualify an unrelated business under a non-real-estate industry', () => {
    assert.equal(qualifiesForPermits({ industry: 'retail', companyName: 'Downtown Coffee Shop' }), false);
    assert.equal(qualifiesForPermits({ industry: 'other', companyName: 'Acme Consulting' }), false);
  });

  test('handles missing fields without throwing', () => {
    assert.equal(qualifiesForPermits({}), false);
    assert.equal(qualifiesForPermits(), false);
    assert.equal(qualifiesForPermits({ industry: 'other', companyName: null }), false);
  });
});

describe('getZipRegion (lib/houstonZipRegions.js)', () => {
  test('returns a named region for a known Houston zip', () => {
    assert.equal(getZipRegion('77019'), 'River Oaks');
  });

  test('matches the curated high-value neighborhood name where both files cover the same zip', () => {
    // These two reference lists are maintained separately (this one is far
    // broader) but must never show two different names for the same zip.
    for (const { zip, neighborhood } of HOUSTON_HIGH_VALUE_ZIPS) {
      assert.equal(getZipRegion(zip), neighborhood, `region for ${zip} should match houstonZipValues.js`);
    }
  });

  test('returns null for a zip with no entry', () => {
    assert.equal(getZipRegion('00000'), null);
  });

  test('every mapped zip is a real 5-digit zip code string', () => {
    for (const zip of Object.keys(HOUSTON_ZIP_REGIONS)) {
      assert.match(zip, /^\d{5}$/);
    }
  });
});

describe('describeWorkType (lib/permitMailer.js)', () => {
  test('recognizes a roof permit', () => {
    assert.equal(describeWorkType('Roof Replacement').label, 'the roof work');
  });

  test('recognizes a pool permit', () => {
    assert.equal(describeWorkType('Residential Pool/Spa').label, 'the pool or spa project');
  });

  test('falls back honestly for an unrecognized permit type', () => {
    const d = describeWorkType('Some Unusual Permit Category');
    assert.equal(d.label, 'the recent work at your property');
  });

  test('handles a missing permit type without throwing', () => {
    assert.equal(describeWorkType(null).label, 'the recent work at your property');
    assert.equal(describeWorkType(undefined).label, 'the recent work at your property');
  });
});

describe('humanizeComments (lib/permitMailer.js)', () => {
  test('strips building-code citations and classification codes into a clean phrase', () => {
    assert.equal(humanizeComments('PARKING GARAGE REMODEL 1-14-1-S2-A 2021 IBC'), 'parking garage remodel');
  });

  test('strips sprinkler/fire-alarm shorthand, M# references, and IRC/IECC citations', () => {
    const out = humanizeComments("DUPLEX RES.W/ATT. GARAGE (1-2-5-R3-B) 21 IRC/21 IECC (M#26027119)");
    assert.ok(out && !/\d/.test(out), 'should have no leftover digits: ' + out);
    assert.match(out, /residential/);
    assert.match(out, /attached/);
  });

  test('strips a leading PPR report-type prefix and expands common abbreviations', () => {
    const out = humanizeComments('PPR RESIDENTIAL DETACHED GARAGE WITH LIVING SPACE ABOVE ADDITION');
    assert.doesNotMatch(out, /^ppr/i);
    assert.match(out, /residential detached garage/);
  });

  test('returns null for empty/missing comments', () => {
    assert.equal(humanizeComments(''), null);
    assert.equal(humanizeComments(null), null);
    assert.equal(humanizeComments(undefined), null);
  });

  test('returns null rather than a garbled fragment for comments that are mostly codes', () => {
    assert.equal(humanizeComments('1-1-1-A5-B 2021 IBC (M#12345)'), null);
  });

  test('never leaves a stray digit in the returned phrase', () => {
    const out = humanizeComments('896 SF CVT SINGLE FAMILY RESIDENCE TO RETAIL 1-1-5-M-B \'21 IBC');
    assert.ok(out === null || !/\d/.test(out));
  });
});

describe('looksLikeBusinessOrPlaceholder (lib/hcadOwnerNames.js)', () => {
  test('flags HCAD\'s "CURRENT OWNER" placeholder', () => {
    assert.equal(looksLikeBusinessOrPlaceholder('CURRENT OWNER'), true);
  });

  test('flags an empty/missing name', () => {
    assert.equal(looksLikeBusinessOrPlaceholder(''), true);
    assert.equal(looksLikeBusinessOrPlaceholder(null), true);
  });

  test('flags real-world business/trust/government owner names', () => {
    ['CITY OF HOUSTON', 'MICHAEL RYAN FEAGIN TRUST', 'MILBY CHARLES FAMILY PTNSH',
      'B & W C1 LLC', 'DKGA / WUC LP', 'PORT OF HOUSTON AUTHORITY',
      'HARRIS COUNTY FLOOD CONTROL DISTRICT', 'JEHOVAHS WITNESS BELLAIRE CONGREGATION',
      'PROSPERITY BANK % PROSPERITY BANK'
    ].forEach(name => assert.equal(looksLikeBusinessOrPlaceholder(name), true, name));
  });

  test('does not flag a plain individual name', () => {
    assert.equal(looksLikeBusinessOrPlaceholder('STEPHENSON MELINDA'), false);
    assert.equal(looksLikeBusinessOrPlaceholder('BRANDT SCOTT M'), false);
  });
});

describe('parseOwnerPersonName (lib/hcadOwnerNames.js)', () => {
  test('parses a simple two-token individual name', () => {
    assert.deepEqual(parseOwnerPersonName('STEPHENSON MELINDA'), { firstName: 'Melinda', lastName: 'Stephenson' });
  });

  test('parses a three-token name with a middle initial', () => {
    assert.deepEqual(parseOwnerPersonName('BRANDT SCOTT M'), { firstName: 'Scott', lastName: 'Brandt' });
  });

  test('parses only the first-listed owner out of a joint-owner name', () => {
    assert.deepEqual(parseOwnerPersonName('MILSTEIN JEFFREY J & LAUREN K'), { firstName: 'Jeffrey', lastName: 'Milstein' });
    assert.deepEqual(parseOwnerPersonName('FREDERICK KEVIN & DANIELLE'), { firstName: 'Kevin', lastName: 'Frederick' });
  });

  test('returns null for a business/trust/government/placeholder name', () => {
    assert.equal(parseOwnerPersonName('CURRENT OWNER'), null);
    assert.equal(parseOwnerPersonName('MICHAEL RYAN FEAGIN TRUST'), null);
    assert.equal(parseOwnerPersonName('CITY OF HOUSTON'), null);
  });

  test('returns null for a 4-token name that dodges the keyword list (token-shape safety net)', () => {
    // A real HCAD example: no BUSINESS_KEYWORDS hit, but 4 tokens is not a
    // "LAST FIRST [MI]" shape — must not be treated as a confident person.
    assert.equal(parseOwnerPersonName('HOME SAVING OF AMERICA'), null);
  });

  test('returns null for a single-token or empty name', () => {
    assert.equal(parseOwnerPersonName('MADONNA'), null);
    assert.equal(parseOwnerPersonName(''), null);
    assert.equal(parseOwnerPersonName(null), null);
  });
});

describe('normalizeAddress (lib/hcadOwnerNames.js)', () => {
  test('uppercases, strips periods/commas, and collapses whitespace', () => {
    assert.equal(normalizeAddress('123  Main   St.'), '123 MAIN ST');
  });

  test('handles a missing address without throwing', () => {
    assert.equal(normalizeAddress(null), '');
    assert.equal(normalizeAddress(undefined), '');
  });
});

describe('parseRealAcctOwnerLine (lib/hcadZipValues.js)', () => {
  const header = 'acct\tmailto\tsite_addr_1\tsite_addr_3\ttot_mkt_val';
  const headerIndex = buildRealAcctHeaderIndex(header);

  test('extracts a confident owner row for a real-shaped individual-owner line', () => {
    const line = '0011870000002\tSTEPHENSON MELINDA\t4815 PALMETTO ST\t77401\t500000';
    const row = parseRealAcctOwnerLine(headerIndex, line);
    assert.deepEqual(row, {
      zip: '77401',
      rawSiteAddress: '4815 PALMETTO ST',
      normalizedAddress: '4815 PALMETTO ST',
      ownerFirstName: 'Melinda',
      ownerLastName: 'Stephenson'
    });
  });

  test('returns null for a business-owned parcel', () => {
    const line = '0011870000002\tCITY OF HOUSTON\t0 FRANKLIN\t77002\t319200';
    assert.equal(parseRealAcctOwnerLine(headerIndex, line), null);
  });

  test('returns null for a missing zip or address', () => {
    assert.equal(parseRealAcctOwnerLine(headerIndex, '0011870000002\tSTEPHENSON MELINDA\t\t77401\t500000'), null);
    assert.equal(parseRealAcctOwnerLine(headerIndex, '0011870000002\tSTEPHENSON MELINDA\t4815 PALMETTO ST\t\t500000'), null);
  });
});

describe('buildPermitLetter (lib/permitMailer.js)', () => {
  const tenant = { name: 'Levi Homes', founder: 'Alex Levi', phone: '(713) 555-0100', email: 'alex@levihomes.com', services: 'custom home building and remodeling', unique: 'We handle every project personally.' };

  test('includes the real permit address as the recipient address', () => {
    const letter = buildPermitLetter({
      permit: { address: '123 Main St', permitType: 'Roof', permitDate: '2026-08-01', projectNo: 'P-1' },
      area: { zip: '77019', region: 'River Oaks' },
      tenant
    });
    assert.equal(letter.recipientAddress, '123 Main St');
    assert.equal(letter.zip, '77019');
  });

  test('addresses "Property Owner" and uses a generic greeting when no owner is resolved', () => {
    const letter = buildPermitLetter({
      permit: { address: '456 Oak Dr', permitType: 'Remodel', permitDate: '2026-08-05', projectNo: 'P-2' },
      area: { zip: '77024', region: 'Memorial / Tanglewood' },
      tenant
    });
    assert.equal(letter.recipientName, 'Property Owner');
    assert.equal(letter.greeting, 'Dear Property Owner,');
  });

  test('addresses a real name and uses a first-name greeting only when an owner is passed in', () => {
    const letter = buildPermitLetter({
      permit: { address: '456 Oak Dr', permitType: 'Remodel', permitDate: '2026-08-05', projectNo: 'P-2' },
      area: { zip: '77024', region: 'Memorial / Tanglewood' },
      tenant,
      owner: { firstName: 'Jeffrey', lastName: 'Milstein' }
    });
    assert.equal(letter.recipientName, 'Jeffrey Milstein');
    assert.equal(letter.greeting, 'Dear Jeffrey,');
  });

  test('mentions the tenant\'s own contact info and company name, not a placeholder', () => {
    const letter = buildPermitLetter({
      permit: { address: '456 Oak Dr', permitType: 'Remodel', permitDate: '2026-08-05', projectNo: 'P-2' },
      area: { zip: '77024', region: 'Memorial / Tanglewood' },
      tenant
    });
    const full = letter.bodyParagraphs.join(' ');
    assert.match(full, /\(713\) 555-0100/);
    assert.match(full, /Levi Homes/);
    assert.deepEqual(letter.signatureLines, ['Alex Levi', 'Levi Homes', '(713) 555-0100 · alex@levihomes.com']);
  });

  test('uses the permit\'s own comments for specificity when they clean up well', () => {
    const letter = buildPermitLetter({
      permit: { address: '1600 Smith St', permitType: 'Building Pmt', permitDate: '2026-08-05', projectNo: 'P-3', comments: 'PARKING GARAGE REMODEL 1-14-1-S2-A 2021 IBC' },
      area: { zip: '77002', region: 'Downtown' },
      tenant
    });
    assert.equal(letter.workLabel, 'the parking garage remodel');
    assert.match(letter.bodyParagraphs[0], /parking garage remodel/);
  });

  test('falls back to a generic-but-honest work label when comments don\'t clean up', () => {
    const letter = buildPermitLetter({
      permit: { address: '1600 Smith St', permitType: 'Some Unusual Type', permitDate: '2026-08-05', projectNo: 'P-4', comments: '1-1-1-A5-B 2021 IBC' },
      area: { zip: '77002', region: 'Downtown' },
      tenant
    });
    assert.equal(letter.workLabel, 'the recent work at your property');
  });

  test('two different permits of the same type produce different letter text (not copy-pasted)', () => {
    const a = buildPermitLetter({
      permit: { address: '1 First St', permitType: 'Roof', permitDate: '2026-08-01', projectNo: 'P-A' },
      area: { zip: '77019', region: 'River Oaks' },
      tenant
    });
    const b = buildPermitLetter({
      permit: { address: '2 Second St', permitType: 'Roof', permitDate: '2026-08-02', projectNo: 'P-B' },
      area: { zip: '77019', region: 'River Oaks' },
      tenant
    });
    assert.notEqual(a.bodyParagraphs.join(' '), b.bodyParagraphs.join(' '));
  });

  test('the same permit always produces the same letter text (stable, not random)', () => {
    const permit = { address: '9 Ninth St', permitType: 'Fence', permitDate: '2026-08-09', projectNo: 'P-9' };
    const area = { zip: '77005', region: 'West University Place' };
    const first = buildPermitLetter({ permit, area, tenant });
    const second = buildPermitLetter({ permit, area, tenant });
    assert.deepEqual(first.bodyParagraphs, second.bodyParagraphs);
  });

  test('handles a missing tenant profile without throwing', () => {
    const letter = buildPermitLetter({
      permit: { address: '10 Tenth St', permitType: 'Roof', permitDate: '2026-08-10', projectNo: 'P-10' },
      area: { zip: '77019', region: 'River Oaks' },
      tenant: {}
    });
    assert.match(letter.bodyParagraphs.join(' '), /the number below/);
  });
});
