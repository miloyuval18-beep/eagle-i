// San Diego County ZIP codes: what people call each area, and how expensive it
// is. The counterpart of lib/houstonZipRegions.js + lib/houstonZipValues.js.
//
// Values come from data/sd_zip_values.json, built by scripts/importSdZipValues.js
// from the PUBLIC SANDAG/SanGIS parcel layers: for each ZIP, the median county
// assessed value of single-family homes whose last transfer was recorded since
// 2022. California reassesses a home to its purchase price when it sells, so for
// recently-sold homes that figure is close to what they sold for -- which makes
// it a fair "how expensive is this area" signal, but it is NOT an appraisal or a
// live market price, and a ZIP with fewer than 30 recent transfers is left
// without a value rather than guessed. Re-run the script to refresh it.
//
// Area names are directional ("roughly this part of town"), written from public
// neighborhood references; a few ZIPs straddle two neighborhoods and carry both.
const data = require('../data/sd_zip_values.json');

// Neighborhood names for City of San Diego ZIPs, where the postal community is
// just "San Diego" and says nothing about which part of town. Everywhere else the
// postal community itself (Escondido, Carlsbad, La Jolla...) is the name.
const SD_CITY_ZIP_REGIONS = {
  '92101': 'Downtown / Little Italy / East Village',
  '92102': 'Golden Hill / Sherman Heights',
  '92103': 'Hillcrest / Mission Hills / Bankers Hill',
  '92104': 'North Park',
  '92105': 'City Heights / East San Diego',
  '92106': 'Point Loma',
  '92107': 'Ocean Beach',
  '92108': 'Mission Valley',
  '92109': 'Pacific Beach / Mission Beach',
  '92110': 'Bay Park / Morena / Old Town area',
  '92111': 'Linda Vista / Clairemont (south)',
  '92113': 'Logan Heights / Barrio Logan',
  '92114': 'Encanto / Valencia Park',
  '92115': 'College Area / Rolando',
  '92116': 'Normal Heights / Kensington',
  '92117': 'Clairemont',
  '92119': 'San Carlos',
  '92120': 'Del Cerro / Allied Gardens',
  '92121': 'Sorrento Valley',
  '92122': 'University City',
  '92123': 'Kearny Mesa',
  '92124': 'Tierrasanta',
  '92126': 'Mira Mesa',
  '92127': 'Rancho Bernardo (West) / 4S Ranch',
  '92128': 'Rancho Bernardo',
  '92129': 'Rancho Peñasquitos',
  '92130': 'Carmel Valley',
  '92131': 'Scripps Ranch',
  '92139': 'Paradise Hills',
  '92154': 'Otay Mesa / Nestor',
  '92173': 'San Ysidro'
};

const titleCase = (s) => String(s || '').toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, a, b) => a + b.toUpperCase());

function getSdZipRegion(zip) {
  const z = String(zip || '').slice(0, 5);
  if (SD_CITY_ZIP_REGIONS[z]) return SD_CITY_ZIP_REGIONS[z];
  const row = data.zips[z];
  return row && row.community ? titleCase(row.community) : null;
}

// A ZIP counts as "high value" when its recent-sale median is $1M or more and
// it has enough homes behind the number to mean something.
const HIGH_VALUE_FLOOR = 1000000;
const MIN_PARCELS = 100;

function getSdZipInfo(zip) {
  const z = String(zip || '').slice(0, 5);
  const row = data.zips[z];
  if (!row) return null;
  const value = row.medianRecentValue;
  return {
    zip: z,
    region: getSdZipRegion(z),
    approxMedianValue: value || null,
    recentTransfers: row.recentTransfers,
    singleFamilyParcels: row.singleFamilyParcels,
    valueSince: data.recentSinceYear,
    highValue: !!value && value >= HIGH_VALUE_FLOOR && row.singleFamilyParcels >= MIN_PARCELS
  };
}

// Same shape as HOUSTON_HIGH_VALUE_ZIPS in lib/houstonZipValues.js.
const SD_HIGH_VALUE_ZIPS = Object.keys(data.zips)
  .map(getSdZipInfo)
  .filter(i => i && i.highValue)
  .map(i => ({ zip: i.zip, neighborhood: i.region, approxMedianValue: i.approxMedianValue }))
  .sort((a, b) => b.approxMedianValue - a.approxMedianValue);

module.exports = { SD_CITY_ZIP_REGIONS, SD_HIGH_VALUE_ZIPS, getSdZipRegion, getSdZipInfo, HIGH_VALUE_FLOOR, SD_VALUES_META: { source: data.source, generatedAt: data.generatedAt, since: data.recentSinceYear } };
