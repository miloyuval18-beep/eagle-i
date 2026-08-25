// Approximate median home values for well-known higher-value Houston zip
// codes, compiled from public real-estate reporting (HomeSnacks neighborhood
// income/value data, KHOU luxury-market reporting, Rocket/Redfin market
// trends) as of August 2026. These are directional, not live/precise —
// treat this as "roughly high-value area," not an exact appraisal. Zip
// codes not listed here simply aren't in this reference set; that does NOT
// mean they're low-value, just untracked.
const HOUSTON_HIGH_VALUE_ZIPS = [
  { zip: '77019', neighborhood: 'River Oaks', approxMedianValue: 3800000 },
  { zip: '77024', neighborhood: 'Memorial / Tanglewood', approxMedianValue: 850000 },
  { zip: '77005', neighborhood: 'West University Place', approxMedianValue: 1700000 },
  { zip: '77079', neighborhood: 'Memorial (West)', approxMedianValue: 800000 },
  { zip: '77007', neighborhood: 'The Heights', approxMedianValue: 550000 },
  { zip: '77008', neighborhood: 'The Heights (North)', approxMedianValue: 500000 },
  { zip: '77056', neighborhood: 'Galleria / Uptown', approxMedianValue: 420000 },
  { zip: '77057', neighborhood: 'Galleria / Uptown', approxMedianValue: 400000 },
  { zip: '77401', neighborhood: 'Bellaire', approxMedianValue: 750000 },
  { zip: '77025', neighborhood: 'Braeswood / Meyerland area', approxMedianValue: 450000 },
  { zip: '77006', neighborhood: 'Montrose', approxMedianValue: 380000 },
  { zip: '77027', neighborhood: 'River Oaks (East) / Highland Village', approxMedianValue: 650000 },
  { zip: '77098', neighborhood: 'Upper Kirby / River Oaks area', approxMedianValue: 600000 }
];

function getHighValueZipInfo(zip) {
  return HOUSTON_HIGH_VALUE_ZIPS.find(z => z.zip === zip) || null;
}

module.exports = { HOUSTON_HIGH_VALUE_ZIPS, getHighValueZipInfo };
