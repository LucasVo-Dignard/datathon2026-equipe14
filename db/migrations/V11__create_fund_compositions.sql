-- Composition of funds (ETFs, mutual funds), for the portfolio and the reports
-- (look-through exposure, app/reports.js). Same cache rules as V1: written on
-- demand by app/stocks.js and by the daily refresh, one row per (symbol, provider).
--
-- Every looked-up symbol gets a row, funds or not: quote_type says what it is
-- ('ETF', 'MUTUALFUND', 'EQUITY', ...), so a stock isn't fetched again just to
-- learn it has no composition. For non-funds the composition columns are empty.
--
-- Ratios are fractions (0.25 = 25 %). sector_weights: { "Technology": 0.24, ... },
-- with the same sector names as company_profiles.sector. top_holdings:
-- [{ "symbol": "AAPL", "name": "Apple Inc", "weight": 0.08 }], largest first.
--
-- IF NOT EXISTS: the lucas environment got this table from an earlier draft
-- numbered V10 (the number went to V10__create_news_feed.sql).

CREATE TABLE IF NOT EXISTS fund_compositions (
    symbol          text          NOT NULL,
    provider        text          NOT NULL,
    quote_type      text          NOT NULL,
    category        text,
    family          text,
    stock_position  numeric(8, 6),
    bond_position   numeric(8, 6),
    cash_position   numeric(8, 6),
    sector_weights  jsonb         NOT NULL DEFAULT '{}',
    top_holdings    jsonb         NOT NULL DEFAULT '[]',
    fetched_at      timestamptz   NOT NULL,
    PRIMARY KEY (symbol, provider)
);
