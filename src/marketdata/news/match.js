'use strict';
// Link an article to listed companies from the organizations Amazon Comprehend
// found in it ("Royal Bank" -> Royal Bank of Canada -> RY, RY.TO).
//
// Names are compared after removing accents, punctuation and legal forms
// (Inc., Corp., Ltd...). An organization matches a company when the names are
// equal, or when the organization is the start of the company's name and is
// distinctive enough (two words or more, or one word of 5+ letters that is not
// a generic word). It is deliberately conservative: a missed link only means
// the article shows up as general news.

const LEGAL_FORMS = new Set([
  'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'llc', 'plc', 'lp',
  'sa', 'se', 'ag', 'nv', 'bv', 'ab', 'asa', 'oyj', 'spa', 'kgaa', 'holdings', 'holding', 'group', 'the',
  'ltee', 'limitee', 'cie', 'class', 'adr', 'ord', 'shares', 'common',
]);
// Single words too common to identify a company on their own.
const GENERIC = new Set([
  'bank', 'banque', 'canada', 'canadian', 'national', 'international', 'global', 'american', 'general',
  'energy', 'financial', 'capital', 'royal', 'first', 'united', 'power', 'health', 'group', 'trust',
  'insurance', 'motors', 'systems', 'technologies', 'industries', 'resources', 'services', 'partners',
  'government', 'federal', 'reserve', 'central', 'ministry', 'ministere',
]);

// Short names the Canadian press uses for listed companies -> start of the
// company's normalized name.
const ALIASES = {
  rbc: 'royal bank of canada',
  td: 'toronto dominion bank',
  'td bank': 'toronto dominion bank',
  bmo: 'bank of montreal',
  cibc: 'canadian imperial bank of commerce',
  scotiabank: 'bank of nova scotia',
  'banque nationale': 'national bank of canada',
  'banque nationale du canada': 'national bank of canada',
  'banque royale': 'royal bank of canada',
  'banque royale du canada': 'royal bank of canada',
  'banque de montreal': 'bank of montreal',
  'banque scotia': 'bank of nova scotia',
  'banque td': 'toronto dominion bank',
  'canadien national': 'canadian national railway',
  'financiere sun life': 'sun life financial',
  'national bank': 'national bank of canada',
  cn: 'canadian national railway',
  'cn rail': 'canadian national railway',
  cpkc: 'canadian pacific kansas city',
  'canadian pacific': 'canadian pacific kansas city',
  enbridge: 'enbridge',
  manulife: 'manulife financial',
  'sun life': 'sun life financial',
};

function normalizeName(name) {
  return String(name || '')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !LEGAL_FORMS.has(w))
    .join(' ');
}

// companies: [{ symbol, name }] -> matcher(organizations) -> [{ symbol, organization }]
function createMatcher(companies) {
  const byName = new Map(); // normalized company name -> [symbols]
  for (const { symbol, name } of companies) {
    const key = normalizeName(name);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(symbol);
  }
  const names = [...byName.keys()];

  function distinctive(org) {
    const words = org.split(' ');
    return words.length >= 2 || (words[0].length >= 5 && !GENERIC.has(words[0]));
  }

  return function match(organizations) {
    const found = new Map(); // symbol -> organization
    for (const organization of organizations) {
      const plain = normalizeName(organization);
      if (!plain) continue;
      const org = ALIASES[plain] || plain;
      let keys = byName.has(org) ? [org] : [];
      if (!keys.length && (ALIASES[plain] || distinctive(org))) {
        keys = names.filter((n) => n === org || n.startsWith(`${org} `));
      }
      // An organization that fits many companies is too vague to link.
      if (keys.length > 2) continue;
      for (const k of keys) {
        for (const symbol of byName.get(k)) if (!found.has(symbol)) found.set(symbol, organization);
      }
    }
    return [...found].map(([symbol, organization]) => ({ symbol, organization }));
  };
}

module.exports = { normalizeName, createMatcher };
