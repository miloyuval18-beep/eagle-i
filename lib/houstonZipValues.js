// Approximate median home values for well-known higher-value Houston zip
// codes, compiled from public real-estate reporting (HomeSnacks neighborhood
// income/value data, KHOU luxury-market reporting, Rocket/Redfin market
// trends) as of August 2026. These are directional, not live/precise —
// treat this as "roughly high-value area," not an exact appraisal. Zip
// codes not listed here simply aren't in this reference set; that does NOT
// mean they're low-value, just untracked.
//
// The 21 zips below the original 13 (marked "HCAD") were added by lowering
// the "high value" floor 15% below the original list's lowest entry (77006,
// $380,000 -> $323,000) and pulling every zip that clears it from real
// Harris County Appraisal District data (hcad_zip_stats, see
// lib/hcadZipValues.js) instead of guessing — median_market_value, not an
// estimate. Filtered to zips with a real named neighborhood
// (lib/houstonZipRegions.js) and at least 300 parcels, so a handful of
// single-parcel data artifacts in the HCAD import don't get treated as
// "high value" areas.
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
  { zip: '77098', neighborhood: 'Upper Kirby / River Oaks area', approxMedianValue: 600000 },
  // -- added: real HCAD median value, >= $323,000 (15% below the $380,000 floor above) --
  { zip: '77030', neighborhood: 'Texas Medical Center', approxMedianValue: 546426 },
  { zip: '77055', neighborhood: 'Spring Branch (East) / Memorial Villages border', approxMedianValue: 554362 },
  { zip: '77094', neighborhood: 'Energy Corridor (Far West)', approxMedianValue: 534370 },
  { zip: '77018', neighborhood: 'Garden Oaks / Oak Forest', approxMedianValue: 484438 },
  { zip: '77059', neighborhood: 'Clear Lake (Nassau Bay)', approxMedianValue: 413440 },
  { zip: '77096', neighborhood: 'Meyerland', approxMedianValue: 404876 },
  { zip: '77581', neighborhood: 'Pearland', approxMedianValue: 398811 },
  { zip: '77345', neighborhood: 'Kingwood (East)', approxMedianValue: 392690 },
  { zip: '77433', neighborhood: 'Cypress', approxMedianValue: 383579 },
  { zip: '77043', neighborhood: 'Spring Branch (East)', approxMedianValue: 371942 },
  { zip: '77077', neighborhood: 'Energy Corridor', approxMedianValue: 369442 },
  { zip: '77009', neighborhood: 'Near Northside / Woodland Heights', approxMedianValue: 368600 },
  { zip: '77494', neighborhood: 'Katy (Cinco Ranch / Cross Creek)', approxMedianValue: 360817 },
  { zip: '77429', neighborhood: 'Cypress (Towne Lake)', approxMedianValue: 359038 },
  { zip: '77379', neighborhood: 'Spring (Champions area)', approxMedianValue: 349572 },
  { zip: '77003', neighborhood: 'East Downtown (EaDo) / Third Ward', approxMedianValue: 341496 },
  { zip: '77004', neighborhood: 'Museum District / Third Ward', approxMedianValue: 334724 },
  { zip: '77450', neighborhood: 'Katy', approxMedianValue: 330505 },
  { zip: '77080', neighborhood: 'Spring Branch (Central)', approxMedianValue: 328225 },
  { zip: '77046', neighborhood: 'Greenway Plaza / Upper Kirby', approxMedianValue: 326252 },
  { zip: '77069', neighborhood: 'Champions', approxMedianValue: 326047 },
  // -- added on request, outside the 15%-floor sweep above --
  { zip: '77389', neighborhood: 'Spring (Gleannloch Farms / Augusta Pines area)', approxMedianValue: 402301 }, // real HCAD median, was missing only because lib/houstonZipRegions.js had no name on file for it
  { zip: '77382', neighborhood: 'The Woodlands (West)', approxMedianValue: 550000 } // Montgomery County, not Harris — outside HCAD's coverage, so this is a directional estimate like the original 13, not real appraisal data
];

function getHighValueZipInfo(zip) {
  return HOUSTON_HIGH_VALUE_ZIPS.find(z => z.zip === zip) || null;
}

module.exports = { HOUSTON_HIGH_VALUE_ZIPS, getHighValueZipInfo };
