'use strict';
// News refresh, every 2 hours on AWS Batch (schedule in infra-batch/), and
// locally against the Docker Postgres:
//
//     DATABASE_URL=postgres://bncd_admin:localdev@127.0.0.1:5432/marketdata \
//         node src/marketdata/jobs/news-refresh.js
//
// 1. Reads the RSS feeds of known media (news/feeds.js).
// 2. Reads Yahoo Finance news for every symbol held in a portfolio; Yahoo
//    says which tickers each article is about.
// 3. New articles go through Amazon Comprehend: sentiment, and organizations
//    -> linked companies (news/enrich.js, news/match.js). Articles stay in
//    their original language.
// 4. Articles older than 30 days are deleted.
//
// Each source and each article fails on its own: an unreachable feed or an AWS
// error is logged and retried on the next run. Exit code 1 only if nothing at
// all worked. NEWS_ENABLED=false turns the job into a no-op.

const { connect, transaction } = require('../db/connection');
const { FEEDS } = require('../news/feeds');
const { fetchFeed } = require('../news/rss');
const { createMatcher } = require('../news/match');
const { analyze } = require('../news/enrich');
const { newYahooClient } = require('../refresh');

const RETENTION_DAYS = 30;
const YAHOO_NEWS_PER_SYMBOL = 5;
const MAX_YAHOO_SYMBOLS = 80; // ~80 calls at 30/min: under 3 minutes
const MAX_ENRICH_PER_RUN = 150; // caps Comprehend costs per run

const stamp = (level) => (message) => console.log(`${new Date().toISOString()} ${level} ${message}`);
const defaultLog = { info: stamp('INFO'), warn: stamp('WARNING') };

function newsEnabled(env = process.env) {
  return !['false', '0', 'no', 'off'].includes((env.NEWS_ENABLED ?? 'true').trim().toLowerCase());
}

const tooOld = (date, now) => now - date.getTime() > RETENTION_DAYS * 86400e3;

// Insert an article; returns its id (also when it already existed).
async function saveItem(db, item) {
  const { rows } = await db.query(
    `INSERT INTO news_items (source, source_name, external_id, url, published_at, language, title, summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (source, external_id) DO UPDATE SET source = EXCLUDED.source
     RETURNING id, (xmax = 0) AS inserted`,
    [item.source, item.sourceName, item.externalId, item.url, item.publishedAt, item.language, item.title, item.summary],
  );
  return rows[0];
}

const link = (db, newsId, symbol, reason) => db.query(
  'INSERT INTO news_item_symbols (news_id, symbol, reason) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
  [newsId, symbol, reason.slice(0, 200)],
);

async function readFeeds(db, { feeds, fetchFn, now, log, report }) {
  for (const feed of feeds) {
    try {
      const items = await fetchFeed(feed.url, { fetchFn });
      let added = 0;
      for (const it of items) {
        if (tooOld(it.publishedAt, now)) continue;
        const saved = await saveItem(db, { ...it, source: feed.id, sourceName: feed.name, language: feed.language });
        if (saved.inserted) added += 1;
      }
      report.sourcesOk += 1;
      report.added += added;
      log.info(`${feed.name}: ${items.length} articles, ${added} new`);
    } catch (err) {
      report.sourcesFailed += 1;
      log.warn(`${feed.name} unavailable: ${err.message}`);
    }
  }
}

async function readYahoo(db, { yahoo, now, log, report }) {
  const { rows } = await db.query(
    `SELECT DISTINCT symbol FROM portfolio_holdings ORDER BY symbol LIMIT ${MAX_YAHOO_SYMBOLS}`);
  const known = new Set((await db.query('SELECT DISTINCT symbol FROM company_profiles')).rows.map((r) => r.symbol));
  for (const { symbol } of rows) {
    try {
      const news = await yahoo.news(symbol, YAHOO_NEWS_PER_SYMBOL);
      for (const n of news) {
        if (!n.id || !n.title || !/^https?:\/\//.test(n.url || '') || Number.isNaN(n.publishedAt.getTime())) continue;
        if (tooOld(n.publishedAt, now)) continue;
        const saved = await saveItem(db, {
          source: 'yahoo',
          sourceName: n.publisher ? `${n.publisher} (via Yahoo Finance)` : 'Yahoo Finance',
          externalId: n.id,
          url: n.url,
          publishedAt: n.publishedAt,
          language: 'en',
          title: n.title.slice(0, 300),
          summary: null,
        });
        if (saved.inserted) report.added += 1;
        // Yahoo says which tickers the article is about; keep the listed ones.
        for (const s of new Set([symbol, ...n.relatedSymbols])) {
          if (s === symbol || known.has(s)) await link(db, saved.id, s, 'yahoo');
        }
      }
      report.sourcesOk += 1;
    } catch (err) {
      report.sourcesFailed += 1;
      log.warn(`Yahoo news for ${symbol} unavailable: ${err.message}`);
    }
  }
  if (rows.length) log.info(`Yahoo Finance: news for ${rows.length} held symbols`);
}

async function enrichPending(db, { comprehend, log, report }) {
  const { rows: pending } = await db.query(
    `SELECT id, language, title, summary FROM news_items
      WHERE enriched_at IS NULL ORDER BY published_at DESC LIMIT ${MAX_ENRICH_PER_RUN}`);
  if (!pending.length) return;
  const companies = (await db.query(
    "SELECT DISTINCT ON (symbol) symbol, name FROM company_profiles WHERE name <> '' ORDER BY symbol, fetched_at DESC")).rows;
  const match = createMatcher(companies);

  let analysis;
  try {
    analysis = await analyze(comprehend, pending);
  } catch (err) {
    log.warn(`Amazon Comprehend unavailable: ${err.message}`);
    report.enrichFailed += pending.length;
    return;
  }

  for (const item of pending) {
    const a = analysis.get(item.id);
    if (!a) { report.enrichFailed += 1; continue; }
    try {
      const links = match(a.organizations);
      await transaction(db, async (t) => {
        await t.query(
          `UPDATE news_items SET sentiment = $2, sentiment_score = $3, organizations = $4,
                  enriched_at = now() WHERE id = $1`,
          [item.id, a.sentiment, a.sentimentScore, a.organizations],
        );
        for (const l of links) await link(t, item.id, l.symbol, `comprehend:${l.organization}`);
      });
      report.enriched += 1;
      report.linked += links.length;
    } catch (err) {
      report.enrichFailed += 1;
      log.warn(`enrichment of news ${item.id} failed: ${err.message}`);
    }
  }
}

async function main(argv = process.argv.slice(2), {
  env = process.env, log = defaultLog, connectFn = connect, fetchFn = fetch, feeds = FEEDS,
  yahoo, comprehend, now = Date.now(),
} = {}) {
  if (!newsEnabled(env)) {
    log.info('NEWS_ENABLED is off: doing nothing');
    return 0;
  }
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION;
  if (!comprehend) {
    const { ComprehendClient } = require('@aws-sdk/client-comprehend');
    comprehend = new ComprehendClient({ region });
  }
  const report = { sourcesOk: 0, sourcesFailed: 0, added: 0, enriched: 0, linked: 0, enrichFailed: 0 };
  const db = await connectFn(env, { applicationName: 'marketdata-news-refresh' });
  try {
    await readFeeds(db, { feeds, fetchFn, now, log, report });
    await readYahoo(db, { yahoo: yahoo || newYahooClient(), now, log, report });
    await enrichPending(db, { comprehend, log, report });
    const { rowCount } = await db.query(
      `DELETE FROM news_items WHERE published_at < now() - interval '${RETENTION_DAYS} days'`);
    log.info(`finished: ${report.added} new articles from ${report.sourcesOk} sources (${report.sourcesFailed} failed), `
      + `${report.enriched} enriched (${report.linked} company links, ${report.enrichFailed} failed), ${rowCount} expired`);
    return report.sourcesOk === 0 && report.enriched === 0 ? 1 : 0;
  } finally {
    await db.end();
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (err) => { console.error(err); process.exitCode = 1; });
}

module.exports = { main, newsEnabled, RETENTION_DAYS, MAX_ENRICH_PER_RUN };
