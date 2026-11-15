'use strict';
// Real news for the dashboard, read from news_items (V10), filled every 2 h by
// src/marketdata/jobs/news-refresh.js (RSS feeds of known media + Yahoo
// Finance, enriched with Amazon Comprehend).
//
// First the articles about the user's holdings (with why they are linked),
// then general business news from the media feeds. Articles are shown in
// their original language (English or French).
// Without a database, enabled = false and the portfolio keeps its sample news.

const LINKED_LIMIT = 20;
const PER_SYMBOL = 4; // so one very covered stock doesn't hide the others
const GENERAL_LIMIT = 10;
const MAX_AGE_DAYS = 7;
const GENERAL_SECTOR = 'Marché';

function toItem(row, sectors) {
  const symbols = row.symbols || [];
  return {
    title: row.title,
    summary: row.summary,
    source: row.source_name,
    url: row.url,
    publishedAt: row.published_at.toISOString(),
    symbols,
    sector: symbols.map((s) => sectors.get(s)).find(Boolean) || GENERAL_SECTOR,
    links: row.links || [], // [{ symbol, reason }]
    sentiment: row.sentiment,
    sentimentScore: row.sentiment_score == null ? null : Number(row.sentiment_score),
    language: row.language,
  };
}

function createNewsService({ pool } = {}) {
  const enabled = Boolean(pool);

  // holdings: [{ symbol, sector }]
  async function forHoldings(holdings) {
    if (!enabled) return [];
    const symbols = holdings.map((h) => h.symbol);
    const sectors = new Map(holdings.map((h) => [h.symbol, h.sector]));
    const columns = `i.id, i.source_name, i.url, i.published_at, i.language, i.title, i.summary,
                     i.sentiment, i.sentiment_score`;
    const linked = symbols.length ? (await pool.query(
      `SELECT ${columns},
              array_agg(s.symbol ORDER BY s.symbol) AS symbols,
              json_agg(json_build_object('symbol', s.symbol, 'reason', s.reason) ORDER BY s.symbol) AS links
         FROM news_items i JOIN news_item_symbols s ON s.news_id = i.id AND s.symbol = ANY($1)
        WHERE i.published_at > now() - make_interval(days => $2)
        GROUP BY i.id
        ORDER BY i.published_at DESC LIMIT $3`,
      [symbols, MAX_AGE_DAYS, LINKED_LIMIT * 4],
    )).rows : [];
    // At most PER_SYMBOL articles per stock (counted on the article's first symbol).
    const perSymbol = new Map();
    const picked = [];
    for (const r of linked) {
      const key = r.symbols[0];
      const n = perSymbol.get(key) || 0;
      if (n >= PER_SYMBOL) continue;
      perSymbol.set(key, n + 1);
      picked.push(r);
      if (picked.length >= LINKED_LIMIT) break;
    }
    const seen = picked.map((r) => r.id);
    const general = (await pool.query(
      `SELECT ${columns}
         FROM news_items i
        WHERE i.source <> 'yahoo' AND i.published_at > now() - make_interval(days => $1)
          AND NOT (i.id = ANY($2::bigint[]))
        ORDER BY i.published_at DESC LIMIT $3`,
      [MAX_AGE_DAYS, seen, GENERAL_LIMIT],
    )).rows;
    return [...picked, ...general].map((r) => toItem(r, sectors));
  }

  return { enabled, forHoldings };
}

module.exports = { createNewsService, GENERAL_SECTOR };
