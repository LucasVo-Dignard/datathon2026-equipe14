'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMacroLookup, STALE_MS } = require('../app/macro');
const models = require('../src/marketdata/models');
const { DEFAULT_INDICATORS } = require('../src/marketdata/providers/worldbank');

const quiet = { info() {}, warn() {}, error() {} };
const INDICATORS = Object.keys(DEFAULT_INDICATORS);

function fakeFetcher({ fail = [], dataset = 'World Development Indicators' } = {}) {
  const calls = [];
  return {
    calls,
    async fetch(indicator, countries) {
      calls.push(indicator);
      if (fail.includes(indicator)) throw new Error('worldbank down');
      return countries.slice(0, 2).flatMap((country) => [2023, 2024].map((year) => models.macroObservation({
        country, indicator, year, value: year - 2000, provider: 'worldbank', indicatorName: `${indicator} name`,
        dataset, sourceOrganization: 'IMF', sourceUpdatedOn: '2026-11-11',
        sourceUrl: `https://data.worldbank.org/indicator/${indicator}?locations=${country.slice(0, 2)}`,
      })));
    },
  };
}

test('macro page loads in the background, then serves grouped tables', async () => {
  const fetcher = fakeFetcher();
  const macro = createMacroLookup({ connectionString: '', fetcher, log: quiet });

  const first = await macro.overview();
  assert.deepEqual(first, { indicators: [], loading: true });
  await macro.settled();

  const { indicators, loading } = await macro.overview();
  assert.equal(loading, false);
  assert.deepEqual(indicators.map((i) => i.code), INDICATORS); // default order
  const [gdp] = indicators;
  assert.deepEqual(gdp.years, [2024, 2023]); // most recent first
  assert.deepEqual(gdp.countries.map((c) => c.code), ['CAN', 'USA']);
  assert.deepEqual(gdp.countries[0].values, { 2023: { value: 23, source: 0 }, 2024: { value: 24, source: 0 } });
  assert.deepEqual(gdp.sources, [{ id: 0, provider: 'worldbank', dataset: 'World Development Indicators',
    organization: 'IMF', updatedOn: '2026-11-11' }]);
  assert.equal(gdp.countries[0].url, `https://data.worldbank.org/indicator/${gdp.code}?locations=CA`);
  assert.equal(fetcher.calls.length, INDICATORS.length);
});

test('macro page reloads values saved without provenance', async () => {
  let now = Date.now();
  const fetcher = fakeFetcher({ dataset: null });
  const macro = createMacroLookup({ connectionString: '', fetcher, now: () => now, log: quiet });
  await macro.overview();
  await macro.settled();
  now += 11 * 60 * 1000;
  await macro.overview();
  await macro.settled();
  assert.equal(fetcher.calls.length, 2 * INDICATORS.length);
});

test('macro page retries only stale or missing indicators, not on every view', async () => {
  let now = Date.now();
  const broken = INDICATORS[0];
  const fetcher = fakeFetcher({ fail: [broken] });
  const macro = createMacroLookup({ connectionString: '', fetcher, now: () => now, log: quiet });
  await macro.overview();
  await macro.settled();
  assert.equal(fetcher.calls.length, INDICATORS.length);

  await macro.overview(); // failed recently: no new attempt
  assert.equal(fetcher.calls.length, INDICATORS.length);

  now += 11 * 60 * 1000;
  await macro.overview();
  await macro.settled();
  assert.deepEqual(fetcher.calls.slice(INDICATORS.length), [broken]);

  now += STALE_MS + 1;
  await macro.overview();
  await macro.settled();
  assert.equal(fetcher.calls.length, 2 * INDICATORS.length + 1);
});
