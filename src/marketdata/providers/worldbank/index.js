'use strict';
// World Bank fetchers (World Development Indicators). Free, no API key.
//
// Indicator codes are listed at https://data.worldbank.org/indicator; the
// code is in each indicator's URL. Data is yearly and published with a lag:
// the latest year is usually last year, sometimes older.

const base = require('../../fetchers/base');
const mappers = require('./mappers');
const { PROVIDER, WorldBankClient } = require('./client');

// A starting set for market context. Values are as published (percentages
// stay percentages, see models.macroObservation).
const DEFAULT_INDICATORS = Object.freeze({
  'NY.GDP.MKTP.KD.ZG': 'GDP growth (annual %)',
  'FP.CPI.TOTL.ZG': 'Inflation, consumer prices (annual %)',
  'SL.UEM.TOTL.ZS': 'Unemployment (% of labor force)',
  'FR.INR.RINR': 'Real interest rate (%)',
  'BN.CAB.XOKA.GD.ZS': 'Current account balance (% of GDP)',
  'NY.GDP.MKTP.CD': 'GDP (current US$)',
});

// Canada and its main trading partners, plus the euro area and the world.
const DEFAULT_COUNTRIES = Object.freeze(['CAN', 'USA', 'MEX', 'GBR', 'EMU', 'JPN', 'CHN', 'IND', 'WLD']);

class WorldBankIndicatorFetcher extends base.MacroIndicatorFetcher {
  static provider = PROVIDER;

  constructor(client) {
    super(client);
    this.indicatorMeta = new Map(); // code -> metadata; it rarely changes
  }

  async _fetch(indicator, countries, years) {
    const [indicatorMeta, { meta, rows }] = await Promise.all([
      this.#metadata(indicator),
      this.client.getAll(`/country/${countries.join(';')}/indicator/${indicator}`, {
        date: `${years.start}:${years.end}`,
      }),
    ]);
    const source = mappers.toSource(indicatorMeta, meta);
    return rows.map((row) => mappers.toObservation(row, source)).filter((o) => o && years.includes(o.year));
  }

  // Dataset and original organization of an indicator (/indicator/{code}).
  // Not fatal: without it the values are saved with no provenance, and
  // callers can reload them later (see app/macro.js).
  async #metadata(indicator) {
    if (!this.indicatorMeta.has(indicator)) {
      try {
        const { rows } = await this.client.getAll(`/indicator/${indicator}`);
        this.indicatorMeta.set(indicator, rows[0] || {});
      } catch {
        return {};
      }
    }
    return this.indicatorMeta.get(indicator);
  }
}

module.exports = {
  DEFAULT_COUNTRIES,
  DEFAULT_INDICATORS,
  WorldBankClient,
  WorldBankIndicatorFetcher,
};
