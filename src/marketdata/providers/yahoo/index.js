'use strict';
// Yahoo Finance fetchers: each one fetches one kind of data. They share a
// single YahooClient, so they also share its rate limiter and its cached
// quote summary.

const { SymbolNotFoundError } = require('../../errors');
const base = require('../../fetchers/base');
const mappers = require('./mappers');
const { PROVIDER, YahooClient } = require('./client');

async function quoteInfo(fetcher, symbol) {
  const info = await fetcher.client.info(symbol);
  if (!mappers.hasQuote(info)) throw new SymbolNotFoundError(PROVIDER, symbol);
  return info;
}

class YahooProfileFetcher extends base.ProfileFetcher {
  static provider = PROVIDER;

  constructor(client = new YahooClient()) {
    super(client);
  }

  async _fetch(symbol) {
    return mappers.toProfile(symbol, await quoteInfo(this, symbol));
  }
}

class YahooMetricsFetcher extends base.MetricsFetcher {
  static provider = PROVIDER;

  constructor(client = new YahooClient()) {
    super(client);
  }

  async _fetch(symbol) {
    return mappers.toMetrics(symbol, await quoteInfo(this, symbol));
  }
}

class YahooPriceHistoryFetcher extends base.PriceHistoryFetcher {
  static provider = PROVIDER;

  constructor(client = new YahooClient()) {
    super(client);
  }

  async _fetch(symbol, period) {
    const { bars, currency } = await this.client.history(symbol, period);
    return mappers.toPriceBars(symbol, bars, currency);
  }
}

// Targets are null (not an error) when no analyst covers the symbol, so the
// cache can record that it checked.
class YahooPriceTargetFetcher extends base.PriceTargetFetcher {
  static provider = PROVIDER;

  constructor(client = new YahooClient()) {
    super(client);
  }

  async _fetch(symbol) {
    return mappers.toPriceTarget(symbol, await quoteInfo(this, symbol));
  }
}

class YahooRatingActionFetcher extends base.RatingActionFetcher {
  static provider = PROVIDER;

  constructor(client = new YahooClient()) {
    super(client);
  }

  async _fetch(symbol, period) {
    return mappers.toRatingActions(symbol, await this.client.upgradesDowngrades(symbol), period);
  }
}

// Stocks get a composition too (quoteType "EQUITY", no weights).
class YahooFundCompositionFetcher extends base.FundCompositionFetcher {
  static provider = PROVIDER;

  constructor(client = new YahooClient()) {
    super(client);
  }

  async _fetch(symbol) {
    await quoteInfo(this, symbol);
    return mappers.toFundComposition(symbol, await this.client.fund(symbol));
  }
}

module.exports = {
  YahooClient,
  YahooProfileFetcher,
  YahooMetricsFetcher,
  YahooPriceHistoryFetcher,
  YahooPriceTargetFetcher,
  YahooRatingActionFetcher,
  YahooFundCompositionFetcher,
};
