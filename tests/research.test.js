'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { marketExtract } = require('../app/research');

const TEARSHEET = [
  '*Last Updated: November 15, 2026*',
  '',
  '# Market Screenshot',
  '',
  '## Global Markets',
  '*As of November 13, 2026*',
  '### Americas',
  '| United States | SPY | +10.62% |',
  '### Europe',
  '| Germany | EWG | +5.00% |',
  '## Equity Sectors',
  '*Source: FMP*',
  '### United States',
  '| Technology | XLK | +18.27% |',
  '## Currencies',
  '### Fiat Currencies',
  '| EUR/USD | +1.00% |',
  '## Equity Factors',
  '### Qualitative (Relative to S&P 500)',
  '| Quality | QUAL | +1.00% |',
  '### Style (Relative to S&P 500)',
  '| Growth | IWF | -13.53% |',
].join('\n');

test('marketExtract keeps the chosen sections with their part heading', () => {
  const text = marketExtract(TEARSHEET);
  for (const line of ['*Last Updated: November 15, 2026*', '## Global Markets', '*As of November 13, 2026*',
    '| United States | SPY | +10.62% |', '## Equity Sectors', '*Source: FMP*', '| Technology | XLK | +18.27% |',
    '## Equity Factors', '### Style (Relative to S&P 500)', '| Growth | IWF | -13.53% |']) {
    assert.ok(text.includes(line), line);
  }
});

test('marketExtract drops the other sections and parts', () => {
  const text = marketExtract(TEARSHEET);
  for (const line of ['### Europe', 'EWG', '## Currencies', 'EUR/USD', '### Qualitative', 'QUAL']) {
    assert.ok(!text.includes(line), line);
  }
  // A part heading is kept once, before its first kept section.
  assert.equal(text.match(/## Equity Factors/g).length, 1);
  assert.ok(text.indexOf('## Equity Factors') < text.indexOf('### Style'));
});
