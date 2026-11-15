'use strict';
// Real news for the dashboard, read from news_items (V10), filled every 2 h by
// src/marketdata/jobs/news-refresh.js (RSS feeds of known media + Yahoo
// Finance, enriched with Amazon Comprehend).
//
// First the articles about the user's holdings (with why they are linked),
// then general news that matters to an investor, by relevance (see
// generalRelevance): local or human-interest stories from the feeds are left
// out. Articles are shown in their original language (English or French).
// Without a database, enabled = false and the portfolio keeps its sample news.

const LINKED_LIMIT = 20;
const PER_SYMBOL = 4; // so one very covered stock doesn't hide the others
const GENERAL_LIMIT = 10;
const MAX_AGE_DAYS = 7;
const GENERAL_SECTOR = 'Marché';
const GENERAL_CANDIDATES = 150; // recent media articles scored for the general section
const GENERAL_PER_COMPANY = 2; // so one company in the headlines doesn't fill the section

// Market themes (EN/FR) that make a general article worth showing. Matched on
// whole words in the title and summary; the label is shown to the user.
const THEMES = [
  ['Taux d’intérêt', /\b(interest rates?|rate (cut|hike)s?|taux( d'intérêt| directeur)?|baisse de taux|hausse de taux)\b/i],
  ['Banques centrales', /\b(bank of canada|banque du canada|federal reserve|the fed|réserve fédérale|central banks?|banques? centrales?)\b/i],
  ['Inflation', /\b(inflation|consumer price index|cpi|indice des prix)\b/i],
  ['Bourse', /\b(stocks?|stock market|shares|tsx|s&p ?500|nasdaq|dow jones|wall street|bourses?|actions|marchés? boursiers?|indices? boursiers?)\b/i],
  // Financial terms only: "profits" alone also describes a local craft fair.
  ['Résultats d’entreprises', /\b(earnings|quarterly (results|profit|revenue)|profit warning|guidance|dividends?|résultats (trimestriels|financiers)|bénéfice (net|trimestriel)|dividendes?)\b/i],
  ['Commerce et tarifs', /\b(tariffs?|trade war|trade deal|tarifs? douaniers?|droits de douane|guerre commerciale|accord commercial)\b/i],
  ['Emploi et croissance', /\b(jobs report|unemployment|gdp|recession|économie canadienne|chômage|pib|récession|croissance économique)\b/i],
  ['Énergie et matières premières', /\b(oil prices?|crude|opec|pétrole|prix du pétrole|gold prices?|prix de l'or)\b/i],
  ['Devises', /\b(canadian dollar|loonie|dollar canadien|huard|exchange rates?|taux de change)\b/i],
  ['Logement et crédit', /\b(housing market|home prices|mortgage rates?|marché immobilier|prix des maisons|taux hypothécaires?)\b/i],
];

// Why a general article (not about the user's holdings) is worth showing:
// { score, reason } or null. Listed companies count most, more so in the
// user's sectors; then market themes.
function generalRelevance(row, userSectors) {
  const text = `${row.title} ${row.summary || ''}`;
  const themes = THEMES.filter(([, re]) => re.test(text)).map(([label]) => label);
  const companies = row.companies || []; // [{ symbol, name, sector }] linked listed companies
  const inSectors = companies.filter((c) => c.sector && userSectors.has(c.sector));
  let score = 0;
  if (inSectors.length) score += 4;
  else if (companies.length) score += 2;
  score += Math.min(themes.length, 2);
  if (!score) return null;
  const parts = [];
  if (inSectors.length) parts.push(`${inSectors[0].name}, secteur de vos titres (${inSectors[0].sector})`);
  else if (companies.length) parts.push(`société cotée : ${companies[0].name}`);
  if (themes.length) parts.push(`thème : ${themes.slice(0, 2).join(', ').toLowerCase()}`);
  return { score, reason: parts.join(' ; ') };
}

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
    relevance: row.relevance || null, // general news: why it is shown
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
    // General news: recent media articles, only those relevant to an investor,
    // most relevant first (then most recent).
    const candidates = (await pool.query(
      `SELECT ${columns},
              (SELECT json_agg(json_build_object('symbol', c.symbol, 'name', c.name, 'sector', c.sector))
                 FROM (SELECT DISTINCT ON (p.symbol) p.symbol, p.name, p.sector
                         FROM news_item_symbols s JOIN company_profiles p ON p.symbol = s.symbol
                        WHERE s.news_id = i.id ORDER BY p.symbol, p.fetched_at DESC) c) AS companies
         FROM news_items i
        WHERE i.source <> 'yahoo' AND i.published_at > now() - make_interval(days => $1)
          AND NOT (i.id = ANY($2::bigint[]))
          -- Articles about the user's own stocks belong to the first section only
          -- (beyond its per-stock cap they are dropped, not shown as general news).
          AND NOT EXISTS (SELECT 1 FROM news_item_symbols o WHERE o.news_id = i.id AND o.symbol = ANY($4))
        ORDER BY i.published_at DESC LIMIT $3`,
      [MAX_AGE_DAYS, seen, GENERAL_CANDIDATES, symbols],
    )).rows;
    const userSectors = new Set(holdings.map((h) => h.sector).filter(Boolean));
    const perCompany = new Map();
    const general = candidates
      .map((r) => ({ r, rel: generalRelevance(r, userSectors) }))
      .filter((x) => x.rel)
      .sort((a, b) => b.rel.score - a.rel.score || b.r.published_at - a.r.published_at)
      .filter(({ r }) => {
        const company = r.companies?.[0]?.symbol;
        if (!company) return true;
        const n = perCompany.get(company) || 0;
        perCompany.set(company, n + 1);
        return n < GENERAL_PER_COMPANY;
      })
      .slice(0, GENERAL_LIMIT)
      .map(({ r, rel }) => ({ ...r, relevance: rel.reason }));
    return [...picked, ...general].map((r) => toItem(r, sectors));
  }

  return { enabled, forHoldings };
}

module.exports = { createNewsService, generalRelevance, GENERAL_SECTOR };
