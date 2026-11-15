'use strict';
// Translate World Bank JSON rows into marketdata models.

const models = require('../../models');
const { toDate, toFloat, toText } = require('../../parsing');
const { PROVIDER } = require('./client');

const SITE_URL = 'https://data.worldbank.org/indicator';

// Where an indicator's values come from, from its metadata
// (/indicator/{code}) and the `lastupdated` of the data response.
function toSource(indicatorMeta, dataMeta) {
  return {
    dataset: toText(indicatorMeta?.source?.value),
    sourceOrganization: toText(indicatorMeta?.sourceOrganization),
    sourceUpdatedOn: toDate(dataMeta?.lastupdated),
  };
}

// null for rows without a value (years not published yet) or that are not
// yearly ("2025M01", "2025Q1").
function toObservation(raw, source = {}) {
  const value = toFloat(raw?.value);
  const date = toText(raw?.date);
  const country = toText(raw?.countryiso3code) || toText(raw?.country?.id);
  const indicator = toText(raw?.indicator?.id);
  if (value == null || !date || !/^\d{4}$/.test(date) || !country || !indicator) return null;
  // The website takes the World Bank's own 2-character country id ("CA", "1W").
  const location = toText(raw.country?.id);
  return models.macroObservation({
    country,
    indicator,
    year: Number(date),
    value,
    provider: PROVIDER,
    countryName: toText(raw.country?.value),
    indicatorName: toText(raw.indicator?.value),
    ...source,
    sourceUrl: `${SITE_URL}/${encodeURIComponent(indicator)}` +
      (location ? `?locations=${encodeURIComponent(location)}` : ''),
  });
}

module.exports = { toObservation, toSource };
