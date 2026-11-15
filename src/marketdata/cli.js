'use strict';
// Try the fetchers from the command line:
//
//     node src/marketdata/cli.js NVDA
//     node src/marketdata/cli.js RY.TO --days 10

const { parseArgs } = require('node:util');
const { MarketDataError } = require('./errors');
const yahoo = require('./providers/yahoo');
const { DateRange } = require('./values');

async function show(title, call, limit = 5) {
  console.log(`\n== ${title}`);
  let result;
  try {
    result = await call();
  } catch (err) {
    if (!(err instanceof MarketDataError)) throw err;
    console.log(`   error: ${err.message}`);
    return;
  }
  const items = Array.isArray(result) ? result : [result];
  if (!items.length) console.log('   (nothing)');
  for (const item of items.slice(-limit)) {
    const { raw, description, ...rest } = item;
    console.log(`   ${JSON.stringify(rest)}`);
  }
}

async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { days: { type: 'string', default: '30' } },
    allowPositionals: true,
  });
  if (positionals.length !== 1) {
    console.error('usage: node src/marketdata/cli.js SYMBOL [--days N]');
    return 2;
  }
  const [symbol] = positionals;
  const period = DateRange.lastDays(Number(values.days));

  const client = new yahoo.YahooClient();
  await show('Yahoo profile', () => new yahoo.YahooProfileFetcher(client).fetch(symbol));
  await show('Yahoo metrics', () => new yahoo.YahooMetricsFetcher(client).fetch(symbol));
  await show('Yahoo prices (last 5)', () => new yahoo.YahooPriceHistoryFetcher(client).fetch(symbol, period));
  await show('Yahoo price target', () => new yahoo.YahooPriceTargetFetcher(client).fetch(symbol));
  await show('Yahoo rating actions (last 5)', () => new yahoo.YahooRatingActionFetcher(client).fetch(symbol, period));
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { main };
