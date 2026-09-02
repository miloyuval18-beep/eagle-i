// Zip code -> named Houston-area region/neighborhood, for grouping and
// filtering permit results by area. This is a broader, general-purpose
// companion to lib/houstonZipValues.js's curated *high-value* list (which
// only covers ~13 zips and exists purely to flag likely high-net-worth
// areas) — this file's job is just "what do people actually call this zip,"
// for every zip that shows up in the weekly permit reports, high-value or
// not. Compiled from public, well-known Houston-area neighborhood/zip
// references; like houstonZipValues.js, treat these as directional
// ("roughly this area"), not precise legal neighborhood boundaries — a few
// zips straddle two named areas and are labeled with both.
//
// Where a zip also appears in HOUSTON_HIGH_VALUE_ZIPS, the region name here
// is kept identical to that file's `neighborhood` text on purpose, so the
// UI never shows two different names for the same zip.
const HOUSTON_ZIP_REGIONS = {
  // Inner Loop / Central
  '77002': 'Downtown',
  '77003': 'East Downtown (EaDo) / Third Ward',
  '77004': 'Museum District / Third Ward',
  '77005': 'West University Place',
  '77006': 'Montrose',
  '77007': 'The Heights',
  '77008': 'The Heights (North)',
  '77009': 'Near Northside / Woodland Heights',
  '77010': 'Downtown (CBD)',
  '77011': 'East End / Second Ward',
  '77012': 'East End (Harrisburg / Manchester)',
  '77019': 'River Oaks',
  '77021': 'South Union / MacGregor',
  '77023': 'Idylwood / Eastwood',
  '77024': 'Memorial / Tanglewood',
  '77025': 'Braeswood / Meyerland area',
  '77026': 'Fifth Ward',
  '77027': 'River Oaks (East) / Highland Village',
  '77030': 'Texas Medical Center',
  '77046': 'Greenway Plaza / Upper Kirby',
  '77054': 'South Main / Medical Center South',
  '77056': 'Galleria / Uptown',
  '77057': 'Galleria / Uptown',
  '77081': 'Gulfton',
  '77096': 'Meyerland',
  '77098': 'Upper Kirby / River Oaks area',
  '77401': 'Bellaire',

  // Northside / Near North
  '77013': 'Galena Park / Jacinto City',
  '77016': 'Trinity Gardens / Northside',
  '77018': 'Garden Oaks / Oak Forest',
  '77020': 'Denver Harbor / Fifth Ward (East)',
  '77022': 'Independence Heights / Northline',
  '77028': 'Kashmere Gardens / Trinity Gardens (East)',
  '77076': 'Northline',
  '77088': 'Acres Homes',
  '77091': 'Acres Homes (South)',
  '77092': 'Oak Forest / Garden Oaks (West)',
  '77093': 'Northline / Trinity Gardens',

  // Southwest / South
  '77031': 'Alief (Southwest)',
  '77033': 'Sunnyside',
  '77034': 'South Belt / Ellington',
  '77035': 'Westbury',
  '77036': 'Sharpstown',
  '77045': 'South Post Oak',
  '77047': 'Sunnyside (South) / Almeda',
  '77048': 'South Acres / Almeda',
  '77051': 'South Park',
  '77053': 'Almeda-Genoa',
  '77061': 'South Houston border',
  '77071': 'Fondren Southwest',
  '77072': 'Alief',
  '77074': 'Sharpstown (South)',
  '77075': 'South Belt / Beamer',
  '77085': 'Fondren Gardens / South Main',
  '77089': 'South Belt / Scarsdale',
  '77099': 'Alief (Southwest)',

  // West / Energy Corridor / Spring Branch
  '77042': 'Westchase',
  '77043': 'Spring Branch (East)',
  '77055': 'Spring Branch (East) / Memorial Villages border',
  '77063': 'Woodlake / Briargrove Park',
  '77077': 'Energy Corridor',
  '77079': 'Memorial (West)',
  '77080': 'Spring Branch (Central)',
  '77082': 'Alief / Westchase border',
  '77083': 'Alief (Far West)',
  '77094': 'Energy Corridor (Far West)',

  // Northwest / Cypress / Willowbrook
  '77040': 'Jersey Village / Copperfield East',
  '77041': 'Jersey Village (South) / Ridgecrest',
  '77064': 'Willowbrook / Copperfield',
  '77065': 'Copperfield / Bear Creek',
  '77066': 'Champions (Northwest)',
  '77067': 'Greenspoint (Northwest)',
  '77068': 'Champion Forest',
  '77069': 'Champions',
  '77070': 'Willowbrook / Champions (West)',
  '77084': 'Bear Creek / Copperfield West',
  '77086': 'Inwood Forest',
  '77095': 'Copperfield (West) / Bear Creek',
  '77429': 'Cypress (Towne Lake)',
  '77433': 'Cypress',
  '77449': 'Katy (Cinco Ranch North)',
  '77450': 'Katy',
  '77494': 'Katy (Cinco Ranch / Cross Creek)',
  '77406': 'Richmond',

  // North / Greenspoint / Aldine / IAH
  '77014': 'Greenspoint',
  '77032': 'Greater Greenspoint / IAH',
  '77037': 'Aldine',
  '77038': 'Aldine (North)',
  '77039': 'Aldine / North Houston',
  '77050': 'Aldine (Northeast)',
  '77060': 'Greenspoint (North)',
  '77073': 'Greenspoint / Beltway 8 North',
  '77090': 'Greenspoint / North Houston',
  '77338': 'Aldine / Greenspoint North',

  // East / Channelview / Galena Park
  '77015': 'East Houston / Woodforest',
  '77017': 'South Park / Pasadena border',
  '77029': 'Manchester / Jacinto City',
  '77049': 'Channelview',
  '77078': 'East Houston / Jacinto City border',
  '77521': 'Baytown',
  '77520': 'Baytown',
  '77532': 'Crosby',
  '77571': 'La Porte',

  // Pasadena / Southeast
  '77503': 'Pasadena',
  '77504': 'Pasadena (South)',
  '77505': 'Pasadena (East)',
  '77506': 'Pasadena (West)',
  '77507': 'Pasadena (Southeast)',
  '77587': 'South Houston',

  // Clear Lake / Bay Area
  '77044': 'Lake Houston / Fall Creek',
  '77058': 'Clear Lake (NASA area)',
  '77059': 'Clear Lake (Nassau Bay)',
  '77062': 'Clear Lake (Middlebrook)',

  // Kingwood / Humble / Atascocita
  '77339': 'Kingwood (West)',
  '77345': 'Kingwood (East)',
  '77346': 'Atascocita',
  '77396': 'Humble',

  // The Woodlands / Spring / Conroe
  '77373': 'Spring',
  '77379': 'Spring (Champions area)',
  '77380': 'The Woodlands (South)',
  '77381': 'The Woodlands',
  '77382': 'The Woodlands (West)',
  '77384': 'The Woodlands (North)',
  '77385': 'Spring',
  '77386': 'Spring / Woodlands border',
  '77388': 'Spring (Cypresswood)',

  // Sugar Land / Missouri City / Fort Bend
  '77459': 'Missouri City',
  '77471': 'Rosenberg',
  '77477': 'Stafford',
  '77478': 'Sugar Land',
  '77479': 'Sugar Land (First Colony)',
  '77489': 'Missouri City (Quail Valley)',
  '77545': 'Fresno',

  // Pearland / Manvel
  '77581': 'Pearland',
  '77584': 'Pearland',
  '77583': 'Rosharon / Manvel'
};

function getZipRegion(zip) {
  return HOUSTON_ZIP_REGIONS[zip] || null;
}

module.exports = { HOUSTON_ZIP_REGIONS, getZipRegion };
