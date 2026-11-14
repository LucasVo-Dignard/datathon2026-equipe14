'use strict';
// Abstract fetcher hierarchy.
//
// One abstract class per kind of data (ProfileFetcher, PriceHistoryFetcher,
// ...). Code that needs data depends only on these, so providers can be
// swapped or combined without touching callers. A concrete fetcher extends a
// kind and has a single job: fetch one kind of data from one provider, e.g.
// `class FinnhubNewsFetcher extends NewsFetcher`. It sets `static provider`
// and receives that provider's shared client.
//
// The public `fetch` methods are template methods: they normalize the input,
// then call `_fetch`, which subclasses implement.

const { normalizeSymbol, DateRange } = require('../values');

class Fetcher {
  static provider = null;

  constructor(client) {
    if (new.target === Fetcher) throw new TypeError('Fetcher is abstract');
    this.client = client;
  }

  get provider() {
    return this.constructor.provider;
  }

  async _fetch() {
    throw new Error(`${this.constructor.name} must implement _fetch()`);
  }
}

// Data that depends only on a symbol (profile, metrics, ...). Rejects with
// SymbolNotFoundError when the provider has nothing for it.
class SymbolFetcher extends Fetcher {
  async fetch(symbol) {
    return this._fetch(normalizeSymbol(symbol));
  }
}

// A time series for a symbol over a DateRange. Resolves to an empty list when
// the provider has nothing in the range.
class RangeFetcher extends Fetcher {
  async fetch(symbol, period) {
    if (!(period instanceof DateRange)) throw new TypeError('period must be a DateRange');
    return this._fetch(normalizeSymbol(symbol), period);
  }
}

// --- One abstract class per kind of data -------------------------------------

/** Company identity: name, exchange, sector, market cap, ... */
class ProfileFetcher extends SymbolFetcher {}
/** Snapshot of fundamentals: P/E, EPS, margins, ... */
class MetricsFetcher extends SymbolFetcher {}
/** Monthly analyst rating counts. */
class RecommendationFetcher extends SymbolFetcher {}
/** Analysts' consensus price target (mean, median, high, low). */
class PriceTargetFetcher extends SymbolFetcher {}
/** Per-firm upgrades, downgrades and price-target changes. */
class RatingActionFetcher extends RangeFetcher {}
/** Daily OHLCV bars. */
class PriceHistoryFetcher extends RangeFetcher {}
/** Company news articles. */
class NewsFetcher extends RangeFetcher {}
/** Earnings releases (past and scheduled). */
class EarningsFetcher extends RangeFetcher {}

module.exports = {
  Fetcher,
  SymbolFetcher,
  RangeFetcher,
  ProfileFetcher,
  MetricsFetcher,
  RecommendationFetcher,
  PriceTargetFetcher,
  RatingActionFetcher,
  PriceHistoryFetcher,
  NewsFetcher,
  EarningsFetcher,
};
