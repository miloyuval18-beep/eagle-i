// The metro areas the vendor directories cover. Houston was the first, and each
// source keeps its own Houston lists (they differ slightly from source to
// source), so Houston behaves exactly as it always has. The other markets use
// the lists below. Most state datasets are statewide, so adding a market is
// mostly a matter of which cities and counties count as part of it.
//
// Every market belongs to a state (Texas unless it says otherwise). The state
// decides which government datasets can feed it: the Texas lists (TBAE, TDLR,
// TREC and so on) only cover Texas markets, and a California market gets its
// own sources (CSLB contractors, DRE brokers) instead.
//
// Counties are the metro's core counties (the ones whose businesses a general
// contractor in that metro would realistically work with). County codes are the
// Texas Comptroller's own numbering (alphabetical, 001-254), checked against
// the Comptroller's data.
const MARKETS = {
  houston: {
    key: 'houston', label: 'Houston', short: 'Houston', defaultCity: 'Houston', weatherPoint: '29.7604,-95.3698',
    cities: null, counties: null, countyCodes: null, fdicCounties: null // each source's own Houston lists apply
  },
  dallas: {
    key: 'dallas', label: 'Dallas–Fort Worth', short: 'Dallas–Fort Worth', defaultCity: 'Dallas', weatherPoint: '32.7767,-96.7970',
    cities: [
      'DALLAS', 'FORT WORTH', 'ARLINGTON', 'PLANO', 'IRVING', 'GARLAND', 'FRISCO', 'MCKINNEY', 'GRAND PRAIRIE', 'DENTON',
      'MESQUITE', 'CARROLLTON', 'RICHARDSON', 'LEWISVILLE', 'ALLEN', 'FLOWER MOUND', 'MANSFIELD', 'ROWLETT', 'ADDISON',
      'COPPELL', 'GRAPEVINE', 'SOUTHLAKE', 'KELLER', 'COLLEYVILLE', 'NORTH RICHLAND HILLS', 'EULESS', 'BEDFORD', 'HURST',
      'DESOTO', 'CEDAR HILL', 'DUNCANVILLE', 'LANCASTER', 'THE COLONY', 'WYLIE', 'ROCKWALL', 'HIGHLAND VILLAGE', 'LITTLE ELM',
      'PROSPER', 'SACHSE', 'FARMERS BRANCH', 'HALTOM CITY', 'WATAUGA', 'BURLESON', 'WEATHERFORD', 'CROWLEY', 'SAGINAW',
      'BENBROOK', 'MURPHY', 'ROYSE CITY', 'MIDLOTHIAN', 'WAXAHACHIE', 'FORNEY', 'HIGHLAND PARK', 'UNIVERSITY PARK',
      'FAIRVIEW', 'ANNA', 'CELINA', 'ARGYLE', 'TROPHY CLUB', 'WESTLAKE', 'ROANOKE', 'LAKE DALLAS', 'CORINTH', 'SANGER'
    ],
    counties: ['DALLAS', 'TARRANT', 'COLLIN', 'DENTON', 'ROCKWALL', 'KAUFMAN', 'ELLIS', 'JOHNSON', 'PARKER'],
    countyCodes: ['057', '220', '043', '061', '199'],
    fdicCounties: ['Dallas', 'Tarrant', 'Collin', 'Denton', 'Rockwall']
  },
  austin: {
    key: 'austin', label: 'Austin', short: 'Austin', defaultCity: 'Austin', weatherPoint: '30.2672,-97.7431',
    cities: [
      'AUSTIN', 'ROUND ROCK', 'CEDAR PARK', 'PFLUGERVILLE', 'GEORGETOWN', 'LEANDER', 'KYLE', 'SAN MARCOS', 'BUDA', 'HUTTO',
      'LAKEWAY', 'BEE CAVE', 'DRIPPING SPRINGS', 'MANOR', 'TAYLOR', 'LIBERTY HILL', 'WEST LAKE HILLS', 'ROLLINGWOOD',
      'SUNSET VALLEY', 'BASTROP', 'ELGIN', 'LOCKHART', 'WIMBERLEY', 'JARRELL', 'LAGO VISTA', 'MANCHACA', 'SPICEWOOD',
      'DRIFTWOOD', 'NIEDERWALD', 'THRALL', 'SUNRISE BEACH VILLAGE', 'VOLENTE', 'BRIARCLIFF', 'WEST LAKE HILLS'
    ],
    counties: ['TRAVIS', 'WILLIAMSON', 'HAYS', 'BASTROP', 'CALDWELL'],
    countyCodes: ['227', '246', '105', '011'],
    fdicCounties: ['Travis', 'Williamson', 'Hays', 'Bastrop']
  },
  san_antonio: {
    key: 'san_antonio', label: 'San Antonio', short: 'San Antonio', defaultCity: 'San Antonio', weatherPoint: '29.4241,-98.4936',
    cities: [
      'SAN ANTONIO', 'NEW BRAUNFELS', 'SCHERTZ', 'CIBOLO', 'SELMA', 'UNIVERSAL CITY', 'LIVE OAK', 'CONVERSE', 'BOERNE',
      'HELOTES', 'LEON VALLEY', 'ALAMO HEIGHTS', 'KIRBY', 'SEGUIN', 'FAIR OAKS RANCH', 'SHAVANO PARK', 'TERRELL HILLS',
      'WINDCREST', 'GARDEN RIDGE', 'CASTLE HILLS', 'HOLLYWOOD PARK', 'BULVERDE', 'SPRING BRANCH', 'MARION', 'SAINT HEDWIG'
    ],
    counties: ['BEXAR', 'COMAL', 'GUADALUPE', 'KENDALL', 'MEDINA'],
    countyCodes: ['015', '046', '094', '130'],
    fdicCounties: ['Bexar', 'Comal', 'Guadalupe', 'Kendall']
  },
  san_diego: {
    key: 'san_diego', label: 'San Diego', short: 'San Diego', defaultCity: 'San Diego', weatherPoint: '32.7157,-117.1611',
    state: 'CA', stateName: 'California',
    // San Diego County cities and communities as they appear in the state
    // license files (the mailing city a licensee gave).
    cities: [
      'SAN DIEGO', 'LA JOLLA', 'CHULA VISTA', 'OCEANSIDE', 'ESCONDIDO', 'CARLSBAD', 'EL CAJON', 'VISTA', 'SAN MARCOS',
      'ENCINITAS', 'NATIONAL CITY', 'LA MESA', 'SANTEE', 'POWAY', 'IMPERIAL BEACH', 'LEMON GROVE', 'CORONADO',
      'SOLANA BEACH', 'DEL MAR', 'SPRING VALLEY', 'LAKESIDE', 'FALLBROOK', 'RAMONA', 'ALPINE', 'BONITA', 'BONSALL',
      'CARDIFF', 'CARDIFF BY THE SEA', 'RANCHO SANTA FE', 'SAN YSIDRO', 'JAMUL', 'JULIAN', 'VALLEY CENTER',
      'PINE VALLEY', 'SAN LUIS REY', 'PAUMA VALLEY', 'DESCANSO', 'BORREGO SPRINGS', 'CAMPO', 'BOULEVARD', 'PALA',
      'SANTA YSABEL', 'WARNER SPRINGS', 'TECATE'
    ],
    counties: ['SAN DIEGO'],
    countyCodes: null,
    fdicCounties: ['San Diego']
  }
};

const DEFAULT_MARKET = 'houston';
const stateOf = (mk) => (mk && mk.state) || 'TX';
// The Texas importers union every OTHER Texas market's lists into their pull; a
// California market's counties and cities must stay out of those (there is a
// San Diego, Texas).
const others = () => Object.values(MARKETS).filter(m => m.key !== DEFAULT_MARKET && stateOf(m) === 'TX');
const union = (legacy, field) => [...new Set([...(legacy || []), ...others().flatMap(m => m[field] || [])])];

function getMarket(key) { return MARKETS[key] || MARKETS[DEFAULT_MARKET]; }
const isMarketKey = (key) => Object.prototype.hasOwnProperty.call(MARKETS, key);

// What a source should filter on for this market: its own Houston list for
// Houston, the market's list for anything else.
const listFor = (mk, field, houstonList) => (mk && mk.key !== DEFAULT_MARKET && mk[field] ? mk[field] : houstonList);

// Replaces the word "Houston" (and the {market} token the California sources use) in a
// section title or blurb with the market's name.
const localize = (text, mk) => (mk && mk.key !== DEFAULT_MARKET ? String(text).replace(/Houston/g, mk.short).replace(/\{market\}/g, mk.short) : text);

// Counties of every market in a state, for importers that only keep the
// markets we serve (the California license files are statewide and large).
const countiesInState = (state) => [...new Set(Object.values(MARKETS).filter(m => stateOf(m) === state).flatMap(m => m.counties || []))];

module.exports = { MARKETS, DEFAULT_MARKET, getMarket, isMarketKey, listFor, localize, union, stateOf, countiesInState };
