'use strict';
// Real news: RSS parsing, company matching, Comprehend enrichment, the
// news-refresh job and the app's query. Database tests need TEST_DATABASE_URL
// on a THROWAWAY database with all db/migrations applied (they delete rows).
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRss, cleanText, httpUrl } = require('../src/marketdata/news/rss');
const { createMatcher, normalizeName } = require('../src/marketdata/news/match');
const { analyze, docText } = require('../src/marketdata/news/enrich');
const newsJob = require('../src/marketdata/jobs/news-refresh');
const { isBlockedPublisher } = require('../src/marketdata/news/blocked');
const { createNewsService, generalRelevance } = require('../app/news');

test('AI-generated article publishers are blocked, real media are not', () => {
  for (const name of ['Simply Wall St.', 'Simply Wall St. (via Yahoo Finance)', 'GuruFocus.com', 'Insider Monkey', 'TipRanks', 'Alpha Vantage', 'Benzinga']) {
    assert.equal(isBlockedPublisher(name), true, name);
  }
  for (const name of ['Reuters', 'Bloomberg (via Yahoo Finance)', 'Yahoo Finance', 'Wall Street Journal', '', null]) {
    assert.equal(isBlockedPublisher(name), false, String(name));
  }
});

const rss = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${items}</channel></rss>`;
const item = ({ title, link, date = 'Sat, 14 Nov 2026 07:11:29 EST', desc = '', guid }) => `<item>
  <title><![CDATA[${title}]]></title><link>${link}</link>${guid ? `<guid isPermaLink="false">${guid}</guid>` : ''}
  <pubDate>${date}</pubDate><description><![CDATA[${desc}]]></description></item>`;

test('RSS: CDATA, HTML and entities are cleaned; bad links and dates are skipped', () => {
  const items = parseRss(rss([
    item({ title: 'Microsoft &amp; partners <b>restore</b> services', link: 'https://cbc.ca/a', guid: '1.20', desc: '<p>Teams &#8217;s back <img src=x onerror=alert(1)></p>' }),
    item({ title: 'Evil', link: 'javascript:alert(1)' }),
    item({ title: 'No date', link: 'https://cbc.ca/b', date: 'not a date' }),
    item({ title: '', link: 'https://cbc.ca/c' }),
  ].join('')));
  assert.equal(items.length, 1);
  const [a] = items;
  assert.equal(a.title, 'Microsoft & partners restore services');
  assert.equal(a.summary, 'Teams ’s back');
  assert.equal(a.externalId, '1.20', 'guid kept as text (not parsed as a number)');
  assert.equal(a.url, 'https://cbc.ca/a');
  assert.equal(a.publishedAt.toISOString(), '2026-11-14T12:11:29.000Z');
});

test('RSS: a single item, long summaries truncated, guid defaults to the link', () => {
  const [a] = parseRss(rss(item({ title: 'T', link: 'https://x.ca/1', desc: 'mot '.repeat(300) })));
  assert.ok(a.summary.length <= 401 && a.summary.endsWith('…'));
  assert.equal(a.externalId, 'https://x.ca/1');
  assert.equal(httpUrl('ftp://x'), null);
  assert.equal(cleanText(['first', 'second']), 'first');
});

const COMPANIES = [
  { symbol: 'RY', name: 'Royal Bank of Canada' }, { symbol: 'RY.TO', name: 'Royal Bank of Canada' },
  { symbol: 'MSFT', name: 'Microsoft Corporation' }, { symbol: 'NA.TO', name: 'National Bank of Canada' },
  { symbol: 'TD.TO', name: 'The Toronto-Dominion Bank' }, { symbol: 'BMO.TO', name: 'Bank of Montreal' },
  { symbol: 'X1', name: 'Global Energy One Inc.' }, { symbol: 'X2', name: 'Global Energy Two Inc.' }, { symbol: 'X3', name: 'Global Energy Three Inc.' },
];

test('company matching: names, legal forms, aliases (EN/FR), and no false friends', () => {
  const match = createMatcher(COMPANIES);
  const syms = (orgs) => match(orgs).map((m) => m.symbol).sort();
  assert.deepEqual(syms(['Microsoft']), ['MSFT']);
  assert.deepEqual(syms(['Royal Bank']), ['RY', 'RY.TO']);
  assert.deepEqual(syms(['RBC']), ['RY.TO', 'RY'].sort());
  assert.deepEqual(syms(['Banque Nationale du Canada']), ['NA.TO']);
  assert.deepEqual(syms(['TD']), ['TD.TO']);
  assert.deepEqual(syms(['Bank of Canada']), [], 'the central bank is not Royal Bank of Canada');
  assert.deepEqual(syms(['National', 'Canada', 'Bank']), [], 'generic words link nothing');
  assert.deepEqual(syms(['Global Energy']), [], 'too vague: fits 3 companies');
  assert.equal(normalizeName('Hydro-Québec Ltée'), 'hydro quebec');
  assert.deepEqual(match(['Microsoft', 'Microsoft Corp.']), [{ symbol: 'MSFT', organization: 'Microsoft' }]);
});

// Fake Comprehend: sentiment from a keyword, organizations from a list.
function fakeComprehend(orgsByText = {}) {
  const calls = [];
  return {
    calls,
    async send(cmd) {
      const name = cmd.constructor.name;
      calls.push({ name, n: cmd.input.TextList.length, lang: cmd.input.LanguageCode });
      if (name === 'BatchDetectSentimentCommand') {
        return {
          ResultList: cmd.input.TextList.map((t, Index) => {
            const s = /loss|layoff|mises à pied|outage/i.test(t) ? 'NEGATIVE' : /beats|record/i.test(t) ? 'POSITIVE' : 'NEUTRAL';
            return { Index, Sentiment: s, SentimentScore: { Positive: 0.1, Negative: 0.1, Neutral: 0.1, Mixed: 0.1, [s[0] + s.slice(1).toLowerCase()]: 0.9 } };
          }),
          ErrorList: [],
        };
      }
      return {
        ResultList: cmd.input.TextList.map((t, Index) => ({
          Index,
          Entities: Object.entries(orgsByText).filter(([k]) => t.includes(k))
            .flatMap(([, orgs]) => orgs.map((o) => ({ Type: 'ORGANIZATION', Text: o, Score: 0.99 })))
            .concat([{ Type: 'PERSON', Text: 'Someone', Score: 0.99 }, { Type: 'ORGANIZATION', Text: 'Unsure Corp', Score: 0.3 }]),
        })),
        ErrorList: [],
      };
    },
  };
}

test('Comprehend enrichment: batches per language, sentiment, confident organizations only', async () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ id: i, language: i < 27 ? 'en' : 'fr', title: `RBC beats ${i}`, summary: 's' }));
  const c = fakeComprehend({ RBC: ['RBC'] });
  const r = await analyze(c, items);
  assert.deepEqual(c.calls.map((x) => `${x.name}:${x.lang}:${x.n}`).sort(), [
    'BatchDetectEntitiesCommand:en:2', 'BatchDetectEntitiesCommand:en:25', 'BatchDetectEntitiesCommand:fr:3',
    'BatchDetectSentimentCommand:en:2', 'BatchDetectSentimentCommand:en:25', 'BatchDetectSentimentCommand:fr:3',
  ]);
  assert.deepEqual(r.get(0), { sentiment: 'POSITIVE', sentimentScore: 0.9, organizations: ['RBC'] });
  assert.ok(docText({ title: 'a', summary: 'x'.repeat(5000) }).length <= 1500);
});

// --- Database -----------------------------------------------------------------

const needsDb = { skip: !process.env.TEST_DATABASE_URL && 'TEST_DATABASE_URL not set' };
const quietLog = { info() {}, warn() {} };

async function withPool(fn) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const clean = async () => {
    await pool.query("DELETE FROM news_items WHERE source LIKE 'test-%' OR source = 'yahoo'");
    await pool.query("DELETE FROM users WHERE username LIKE 'news-%'"); // cascades to portfolios (V12)
    await pool.query("DELETE FROM company_profiles WHERE provider = 'test-news'");
  };
  await clean();
  try {
    await fn(pool);
  } finally {
    await clean();
    await pool.end();
  }
}

function fakeFetch(feeds) {
  return async (url) => {
    if (!(url in feeds)) return { ok: false, status: 503, headers: new Map(), text: async () => '' };
    return { ok: true, status: 200, headers: new Map(), text: async () => feeds[url] };
  };
}

test('news-refresh job: feeds + Yahoo -> enriched, linked, deduplicated; app query', needsDb, () => withPool(async (pool) => {
  const now = Date.now();
  const recent = new Date(now - 3600e3).toUTCString();
  const old = new Date(now - 40 * 86400e3).toUTCString();
  for (const [symbol, name] of [['RY.TO', 'Royal Bank of Canada'], ['MSFT', 'Microsoft Corporation'], ['NVDA', 'NVIDIA Corporation']]) {
    await pool.query(`INSERT INTO company_profiles (symbol, provider, name, sector, fetched_at)
                      VALUES ($1, 'test-news', $2, 'Tech', now()) ON CONFLICT DO NOTHING`, [symbol, name]);
  }
  await pool.query("INSERT INTO users (username) VALUES ('news-a')");
  await pool.query("INSERT INTO portfolios (username, source, cash) VALUES ('news-a', 'custom', 0)");
  await pool.query("INSERT INTO portfolio_holdings (username, symbol, quantity, avg_cost) VALUES ('news-a', 'RY.TO', 1, 1), ('news-a', 'MSFT', 1, 1)");

  const feeds = [
    { id: 'test-cbc', name: 'CBC Business', url: 'https://feed/cbc', language: 'en' },
    { id: 'test-rc', name: 'Radio-Canada Économie', url: 'https://feed/rc', language: 'fr' },
    { id: 'test-down', name: 'Down', url: 'https://feed/down', language: 'en' },
  ];
  const fetchFn = fakeFetch({
    'https://feed/cbc': rss(item({ title: 'RBC beats estimates', link: 'https://cbc.ca/rbc', date: recent, desc: 'Royal Bank results' })
      + item({ title: 'Minimum wage report', link: 'https://cbc.ca/wage', date: recent })
      + item({ title: 'Bank of Canada holds its key interest rate', link: 'https://cbc.ca/boc', date: recent })
      + item({ title: 'Too old', link: 'https://cbc.ca/old', date: old })),
    'https://feed/rc': rss(item({ title: 'Mises à pied chez un détaillant', link: 'https://ici.radio-canada.ca/1', date: recent, desc: 'Résumé en français' })),
  });
  const yahoo = {
    async news(symbol) {
      if (symbol !== 'MSFT') return [];
      return [{ id: 'y1', title: 'Microsoft and Nvidia expand AI deal', publisher: 'Reuters', url: 'https://finance.yahoo.com/y1',
        publishedAt: new Date(now - 7200e3), relatedSymbols: ['MSFT', 'NVDA', 'HG=F'] }];
    },
  };
  const comprehend = fakeComprehend({ RBC: ['RBC', 'Royal Bank'], 'Mises à pied': ['Detaillant Inc'] });
  const env = { DATABASE_URL: process.env.TEST_DATABASE_URL };

  assert.equal(await newsJob.main([], { env, log: quietLog, feeds, fetchFn, yahoo, comprehend, now }), 0);

  const { rows } = await pool.query(
    `SELECT source, title, language, sentiment, organizations, enriched_at IS NOT NULL AS enriched,
            (SELECT json_agg(json_build_object('s', symbol, 'r', reason) ORDER BY symbol) FROM news_item_symbols WHERE news_id = id) AS links
       FROM news_items WHERE source LIKE 'test-%' OR source = 'yahoo' ORDER BY title`);
  const byTitle = Object.fromEntries(rows.map((r) => [r.title, r]));
  assert.deepEqual(Object.keys(byTitle).sort(), ['Bank of Canada holds its key interest rate', 'Microsoft and Nvidia expand AI deal',
    'Minimum wage report', 'Mises à pied chez un détaillant', 'RBC beats estimates']);
  assert.ok(rows.every((r) => r.enriched), 'all enriched by Comprehend');
  assert.equal(byTitle['RBC beats estimates'].sentiment, 'POSITIVE');
  assert.deepEqual(byTitle['RBC beats estimates'].links, [{ s: 'RY.TO', r: 'comprehend:RBC' }]);
  assert.equal(byTitle['Mises à pied chez un détaillant'].language, 'fr', 'kept in its original language');
  assert.equal(byTitle['Mises à pied chez un détaillant'].sentiment, 'NEGATIVE');
  assert.equal(byTitle['Mises à pied chez un détaillant'].links, null, 'unknown company: general news');
  assert.deepEqual(byTitle['Microsoft and Nvidia expand AI deal'].links, [{ s: 'MSFT', r: 'yahoo' }, { s: 'NVDA', r: 'yahoo' }],
    'Yahoo related tickers, only listed ones (HG=F dropped)');

  // Second run: nothing new, nothing re-enriched (no Comprehend call).
  const c2 = fakeComprehend();
  assert.equal(await newsJob.main([], { env, log: quietLog, feeds, fetchFn, yahoo, comprehend: c2, now }), 0);
  assert.equal(c2.calls.length, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM news_items WHERE source LIKE 'test-%' OR source = 'yahoo'")).rows[0].n, 5);

  // App: linked articles first (with reasons), then only general news relevant to investors.
  const news = createNewsService({ pool });
  const items = await news.forHoldings([{ symbol: 'RY.TO', sector: 'Finance' }, { symbol: 'MSFT', sector: 'Technologie' }]);
  const titles = items.map((i) => i.title);
  assert.deepEqual(titles.slice(0, 2).sort(), ['Microsoft and Nvidia expand AI deal', 'RBC beats estimates']);
  assert.equal(titles[2], 'Bank of Canada holds its key interest rate', 'market theme: kept after the linked articles');
  assert.match(items[2].relevance, /taux d’intérêt/);
  assert.equal(items[0].relevance, null, 'linked articles need no general-news reason');
  assert.ok(!titles.includes('Minimum wage report'), 'no listed company, no market theme: left out');
  assert.ok(!titles.includes('Mises à pied chez un détaillant'), 'unlisted company only: left out');
  const rbc = items.find((i) => i.title === 'RBC beats estimates');
  assert.equal(rbc.sector, 'Finance');
  assert.deepEqual(rbc.links, [{ symbol: 'RY.TO', reason: 'comprehend:RBC' }]);
  assert.equal(rbc.sentiment, 'POSITIVE');
  assert.equal(rbc.url, 'https://cbc.ca/rbc');
  const msft = items.find((i) => i.title.startsWith('Microsoft'));
  assert.deepEqual(msft.symbols, ['MSFT'], 'only the user\'s own symbols are shown');
  assert.equal(items[2].sector, 'Marché');
  assert.ok(!items.some((i) => i.title === 'Too old'));
}));

test('news job is a no-op when disabled, and fails only if nothing worked', needsDb, async () => {
  assert.equal(newsJob.newsEnabled({ NEWS_ENABLED: 'false' }), false);
  assert.equal(await newsJob.main([], { env: { NEWS_ENABLED: 'off' }, log: quietLog }), 0);
  const env = { DATABASE_URL: process.env.TEST_DATABASE_URL };
  const yahooDown = { news: async () => { throw new Error('Yahoo down'); } };
  const run = (fetchFn) => newsJob.main([], {
    env, log: quietLog, feeds: [{ id: 'test-x', name: 'X', url: 'https://feed/x', language: 'en' }],
    fetchFn, yahoo: yahooDown, comprehend: fakeComprehend(), now: Date.now(),
  });
  try {
    assert.equal(await run(fakeFetch({})), 1, 'every source is down: Batch should retry');
    assert.equal(await run(fakeFetch({ 'https://feed/x': rss('') })), 0, 'one source answered (even empty): success');
  } finally {
    const { Client } = require('pg');
    const c = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await c.connect();
    await c.query("DELETE FROM news_items WHERE source LIKE 'test-%'");
    await c.end();
  }
});

test('general news relevance: listed companies (more in the user\'s sectors), then market themes', () => {
  const sectors = new Set(['Technology']);
  const rel = (title, companies = [], summary = '') => generalRelevance({ title, summary, companies }, sectors);
  assert.equal(rel('Le Salon des artisans de Noël réunit une dizaine d’exposants'), null);
  assert.equal(rel('Minimum wage has not kept pace with the cost of living'), null);
  assert.match(rel('La Banque du Canada maintient son taux directeur').reason, /taux d’intérêt, banques centrales/);
  assert.match(rel('TSX closes higher as oil prices climb').reason, /bourse, énergie/);
  const own = rel('Outage', [{ symbol: 'MSFT', name: 'Microsoft Corporation', sector: 'Technology' }]);
  const other = rel('Outage', [{ symbol: 'XOM', name: 'Exxon Mobil', sector: 'Energy' }]);
  assert.ok(own.score > other.score);
  assert.match(own.reason, /secteur de vos titres/);
  assert.match(other.reason, /société cotée : Exxon Mobil/);
  assert.equal(rel('Les actionnaires de la coopérative', [], 'stockholders'), null, 'whole words only');
  assert.equal(rel('Une année record à l’Expo-Cadeaux des artisans', [], 'Les profits de l’événement serviront'), null,
    '"profits" of a local fair is not a market theme');
  assert.match(rel('RBC quarterly profit tops forecasts').reason, /résultats d’entreprises/);
});

