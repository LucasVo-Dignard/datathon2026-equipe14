'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ProviderError, RateLimitError, SymbolNotFoundError } = require('../src/marketdata/errors');
const base = require('../src/marketdata/fetchers/base');
const {
  YahooClient,
  YahooMetricsFetcher,
  YahooPriceHistoryFetcher,
  YahooPriceTargetFetcher,
  YahooProfileFetcher,
  YahooRatingActionFetcher,
} = require('../src/marketdata/providers/yahoo');
const { upside } = require('../src/marketdata/models');
const { DateRange } = require('../src/marketdata/values');

const NVDA_INFO = {
  longName: 'NVIDIA Corporation', fullExchangeName: 'NasdaqGS', currency: 'USD',
  country: 'United States', sector: 'Technology', industry: 'Semiconductors',
  marketCap: 3_932_339_044_352, sharesOutstanding: 24_147_000_000,
  trailingPE: 20.58, forwardPE: 10.27, priceToBook: 17.17, trailingEps: 7.91,
  trailingAnnualDividendYield: 0.0017, dividendYield: 0.61, beta: 2.247,
  fiftyTwoWeekHigh: 243.37, fiftyTwoWeekLow: 148.8,
  profitMargins: 0.636, returnOnEquity: 1.172,
};

class FakeYahooClient {
  constructor({ info = {}, history = { bars: [], currency: null }, grades = [] } = {}) {
    Object.assign(this, { infoValue: info, historyValue: history, grades, historyCalls: [] });
  }

  async info() { return this.infoValue; }

  async upgradesDowngrades() { return this.grades; }

  async history(symbol, period) {
    this.historyCalls.push([symbol, period]);
    return this.historyValue;
  }
}

test('fetchers implement the abstract kinds', () => {
  const client = new FakeYahooClient();
  assert.ok(new YahooProfileFetcher(client) instanceof base.ProfileFetcher);
  assert.ok(new YahooMetricsFetcher(client) instanceof base.MetricsFetcher);
  assert.ok(new YahooPriceHistoryFetcher(client) instanceof base.PriceHistoryFetcher);
  assert.ok(new YahooPriceTargetFetcher(client) instanceof base.PriceTargetFetcher);
  assert.ok(new YahooRatingActionFetcher(client) instanceof base.RatingActionFetcher);
  assert.equal(YahooProfileFetcher.provider, 'yahoo');
  assert.equal(new YahooProfileFetcher(client).provider, 'yahoo');
});

test('profile', async () => {
  const profile = await new YahooProfileFetcher(new FakeYahooClient({ info: NVDA_INFO })).fetch('nvda');
  assert.equal(profile.symbol, 'NVDA');
  assert.equal(profile.name, 'NVIDIA Corporation');
  assert.equal(profile.exchange, 'NasdaqGS');
  assert.equal(profile.sector, 'Technology');
  assert.equal(profile.marketCap, 3_932_339_044_352);
});

test('metrics use the fraction dividend yield', async () => {
  const metrics = await new YahooMetricsFetcher(new FakeYahooClient({ info: NVDA_INFO })).fetch('NVDA');
  assert.equal(metrics.dividendYield, 0.0017); // not the percentage `dividendYield`
  assert.equal(metrics.forwardPe, 10.27);
  assert.equal(metrics.netMargin, 0.636);
  assert.equal(metrics.raw.beta, 2.247);
});

test('unknown symbol raises SymbolNotFoundError', async () => {
  const client = new FakeYahooClient({ info: { trailingPegRatio: null } });
  await assert.rejects(new YahooProfileFetcher(client).fetch('ZZZZNOTREAL'), SymbolNotFoundError);
  await assert.rejects(new YahooMetricsFetcher(client).fetch('ZZZZNOTREAL'), SymbolNotFoundError);
  await assert.rejects(new YahooPriceTargetFetcher(new FakeYahooClient()).fetch('ZZZZNOTREAL'), SymbolNotFoundError);
});

test('price history maps rows and skips missing prices', async () => {
  const client = new FakeYahooClient({
    history: {
      currency: 'USD',
      bars: [
        { date: '2026-11-02', open: 207.5, high: 209.9, low: 205, close: 206, adjClose: 202, volume: 119_272_200 },
        { date: '2026-11-03', open: 207.9, high: 209.1, low: 204, close: 207, adjClose: 206.6, volume: 91_943_400 },
        { date: '2026-11-04', open: null, high: 1, low: 1, close: 1, adjClose: 1, volume: 1 },
      ],
    },
  });
  const period = new DateRange('2026-11-02', '2026-11-04');
  const bars = await new YahooPriceHistoryFetcher(client).fetch('NVDA', period);
  assert.deepEqual(client.historyCalls, [['NVDA', period]]);
  assert.deepEqual(bars.map((b) => b.date), ['2026-11-02', '2026-11-03']);
  assert.equal(bars[0].adjClose, 202);
  assert.equal(bars[0].volume, 119_272_200);
  assert.equal(bars[0].currency, 'USD');
});

test('empty history gives an empty list', async () => {
  assert.deepEqual(await new YahooPriceHistoryFetcher(new FakeYahooClient()).fetch('ZZZZ', DateRange.lastDays(5)), []);
});

test('range fetchers require a DateRange', async () => {
  await assert.rejects(new YahooPriceHistoryFetcher(new FakeYahooClient()).fetch('NVDA', { start: 'x' }), TypeError);
});

// --- Price targets -------------------------------------------------------------

const RY_TARGET_INFO = {
  longName: 'Royal Bank of Canada', currency: 'CAD', currentPrice: 200,
  targetMeanPrice: 220, targetMedianPrice: 219, targetHighPrice: 240,
  targetLowPrice: 190, numberOfAnalystOpinions: 14,
  recommendationMean: 2.1, recommendationKey: 'buy',
};

test('price target consensus', async () => {
  const target = await new YahooPriceTargetFetcher(new FakeYahooClient({ info: RY_TARGET_INFO })).fetch('ry.to');
  assert.equal(target.symbol, 'RY.TO');
  assert.equal(target.currency, 'CAD');
  assert.equal(target.targetMean, 220);
  assert.equal(target.targetLow, 190);
  assert.equal(target.analystCount, 14);
  assert.equal(target.recommendationKey, 'buy');
  assert.ok(Math.abs(upside(target) - 0.1) < 1e-9);
});

test('price target without coverage is empty, not an error', async () => {
  const info = { shortName: 'Tiny Co', regularMarketPrice: 1.5, recommendationKey: 'none' };
  const target = await new YahooPriceTargetFetcher(new FakeYahooClient({ info })).fetch('TINY.V');
  assert.equal(target.currentPrice, 1.5); // falls back to regularMarketPrice
  assert.equal(target.targetMean, null);
  assert.equal(target.recommendationKey, null);
  assert.equal(upside(target), null);
});

const GRADES = [
  { gradedAt: new Date('2026-11-10T12:00:00Z'), firm: 'RBC Capital', toGrade: 'Outperform', fromGrade: 'Sector Perform',
    action: 'up', priceTargetAction: 'Raises', currentPriceTarget: 230, priorPriceTarget: 210 },
  { gradedAt: new Date('2026-10-01T09:30:00Z'), firm: 'Scotiabank', toGrade: 'Sector Perform', fromGrade: '',
    action: 'main', priceTargetAction: 'Maintains', currentPriceTarget: 205, priorPriceTarget: 205 },
  { gradedAt: new Date('2026-11-03T08:00:00Z'), firm: 'TD Securities', toGrade: 'Buy', fromGrade: 'Hold',
    action: 'up', priceTargetAction: 'Raises', currentPriceTarget: 0, priorPriceTarget: 0 },
  { gradedAt: new Date('2025-01-01T00:00:00Z'), firm: 'Old Firm', toGrade: 'Hold', fromGrade: '',
    action: 'init', priceTargetAction: 'Announces', currentPriceTarget: 150, priorPriceTarget: 0 },
  { gradedAt: null, firm: 'No Date' },
];

test('rating actions are filtered by period and sorted oldest first', async () => {
  const period = new DateRange('2026-10-01', '2026-11-14');
  const actions = await new YahooRatingActionFetcher(new FakeYahooClient({ grades: GRADES })).fetch('RY.TO', period);
  assert.deepEqual(actions.map((a) => a.firm), ['Scotiabank', 'TD Securities', 'RBC Capital']);
  const rbc = actions.at(-1);
  assert.equal(rbc.symbol, 'RY.TO');
  assert.equal(rbc.gradedAt.toISOString(), '2026-11-10T12:00:00.000Z');
  assert.equal(rbc.action, 'up');
  assert.equal(rbc.fromGrade, 'Sector Perform');
  assert.equal(rbc.priceTarget, 230);
  assert.equal(rbc.priorPriceTarget, 210);
  assert.equal(actions[0].fromGrade, null); // empty string
  assert.equal(actions[1].priceTarget, null); // 0 means no target
});

test('rating actions without target fields', async () => {
  const grades = GRADES.map(({ gradedAt, firm, toGrade, fromGrade, action }) => ({ gradedAt, firm, toGrade, fromGrade, action }));
  const actions = await new YahooRatingActionFetcher(new FakeYahooClient({ grades }))
    .fetch('RY.TO', DateRange.lastDays(365, '2026-11-14'));
  assert.equal(actions.length, 3);
  assert.ok(actions.every((a) => a.priceTarget === null && a.priceTargetAction === null));
});

// --- Client (with a fake yahoo-finance2 library) --------------------------------

function fakeLibrary({ summary, chart } = {}) {
  const calls = { quoteSummary: 0, chart: [] };
  return {
    calls,
    async quoteSummary() {
      calls.quoteSummary++;
      if (summary instanceof Error) throw summary;
      return summary;
    },
    async chart(symbol, options) {
      calls.chart.push(options);
      if (chart instanceof Error) throw chart;
      return chart;
    },
  };
}

test('client flattens the quote summary and caches it briefly', async () => {
  let now = 0;
  const library = fakeLibrary({
    summary: {
      price: { longName: 'Royal Bank of Canada', exchangeName: 'Toronto', exchange: 'TOR', currency: 'CAD', marketCap: 1 },
      summaryDetail: { marketCap: 2, trailingPE: 18 },
      summaryProfile: { sector: 'Financial Services' },
      upgradeDowngradeHistory: { history: [{ epochGradeDate: new Date('2026-11-01T00:00:00Z'), firm: 'X', action: 'up' }] },
    },
  });
  const client = new YahooClient({ library, now: () => now });
  const info = await client.info('RY.TO');
  assert.equal(info.fullExchangeName, 'Toronto');
  assert.equal(info.marketCap, 1); // first module wins
  assert.equal(info.trailingPE, 18);
  assert.equal(info.sector, 'Financial Services');
  const grades = await client.upgradesDowngrades('RY.TO');
  assert.equal(grades[0].firm, 'X');
  assert.equal(library.calls.quoteSummary, 1);
  now = 61_000;
  await client.info('RY.TO');
  assert.equal(library.calls.quoteSummary, 2);
});

test('client: unknown symbols give empty data, other errors are wrapped', async () => {
  const notFound = new YahooClient({
    library: fakeLibrary({
      summary: new Error('Quote not found for symbol: ZZZZ'),
      chart: new Error('No data found, symbol may be delisted'),
    }),
  });
  assert.deepEqual(await notFound.info('ZZZZ'), {});
  assert.deepEqual(await notFound.history('ZZZZ', DateRange.lastDays(5)), { currency: null, bars: [] });

  const down = new YahooClient({ library: fakeLibrary({ summary: new Error('network down') }) });
  await assert.rejects(down.info('RY.TO'), ProviderError);

  const limited = Object.assign(new Error('Too Many Requests'), { code: 429 });
  await assert.rejects(new YahooClient({ library: fakeLibrary({ summary: limited }) }).info('RY.TO'), RateLimitError);
});

test('client makes the end date inclusive and uses the exchange day', async () => {
  const library = fakeLibrary({
    chart: {
      meta: { currency: 'CAD', exchangeTimezoneName: 'America/Toronto' },
      quotes: [{ date: new Date('2026-11-13T14:30:00Z'), open: 1, high: 2, low: 0.5, close: 1.5, adjclose: 1.4, volume: 9 }],
    },
  });
  const result = await new YahooClient({ library }).history('RY.TO', new DateRange('2026-11-02', '2026-11-13'));
  assert.equal(library.calls.chart[0].period1, '2026-11-02');
  assert.equal(library.calls.chart[0].period2, '2026-11-14');
  assert.equal(library.calls.chart[0].interval, '1d');
  assert.equal(result.currency, 'CAD');
  assert.deepEqual(result.bars[0], { date: '2026-11-13', open: 1, high: 2, low: 0.5, close: 1.5, adjClose: 1.4, volume: 9 });
});
