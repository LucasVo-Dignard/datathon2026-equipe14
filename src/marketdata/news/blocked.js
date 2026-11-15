'use strict';
// Publishers of automated or AI-generated articles (mostly syndicated through
// Yahoo Finance): left out at ingestion (jobs/news-refresh.js), which also
// purges those already stored, and in the app (app/news.js) until then.

// Compared on the publisher name lowercased, letters and digits only, so
// "Simply Wall St." and "Simply Wall St (via Yahoo Finance)" both match.
const BLOCKED_PUBLISHERS = [
  'simplywallst',
  'gurufocus',
  'insidermonkey',
  'tipranks',
  'alphavantage',
  'benzinga',
];

const squash = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function isBlockedPublisher(name) {
  const key = squash(name);
  return Boolean(key) && BLOCKED_PUBLISHERS.some((p) => key.includes(p));
}

module.exports = { BLOCKED_PUBLISHERS, isBlockedPublisher };
