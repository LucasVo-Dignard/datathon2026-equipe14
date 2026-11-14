-- Market data cache. One table per model in src/marketdata/models.py.
--
-- Rows are written on demand: when a user asks about a symbol, the app reads
-- these tables first and calls a fetcher only if data is missing or stale
-- (fetched_at). Each row records the provider it came from, so Yahoo and
-- Finnhub data for the same symbol can coexist.
--
-- Units (same as the models): amounts in the listing currency, in units (not
-- millions); ratios as fractions (0.25 = 25%).

CREATE TABLE company_profiles (
    symbol              text        NOT NULL,
    provider            text        NOT NULL,
    name                text        NOT NULL,
    exchange            text,
    currency            text,
    country             text,
    sector              text,
    industry            text,
    market_cap          numeric(24, 2),
    shares_outstanding  numeric(20, 0),
    website             text,
    logo_url            text,
    ipo_date            date,
    description         text,
    fetched_at          timestamptz NOT NULL,
    PRIMARY KEY (symbol, provider)
);

CREATE TABLE price_bars (
    symbol      text           NOT NULL,
    provider    text           NOT NULL,
    date        date           NOT NULL,
    open        numeric(20, 6) NOT NULL,
    high        numeric(20, 6) NOT NULL,
    low         numeric(20, 6) NOT NULL,
    close       numeric(20, 6) NOT NULL,
    adj_close   numeric(20, 6) NOT NULL,
    volume      bigint         NOT NULL,
    currency    text,
    fetched_at  timestamptz    NOT NULL,
    PRIMARY KEY (symbol, provider, date)
);

-- Snapshots, not upserts: keeping every fetch lets us detect changes
-- (P/E moved by more than 10%, new 52-week high, ...) for notifications.
CREATE TABLE financial_metrics (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    symbol            text             NOT NULL,
    provider          text             NOT NULL,
    market_cap        numeric(24, 2),
    pe_ttm            double precision,
    forward_pe        double precision,
    price_to_book     double precision,
    eps_ttm           double precision,
    dividend_yield    double precision,
    beta              double precision,
    week52_high       double precision,
    week52_low        double precision,
    net_margin        double precision,
    return_on_equity  double precision,
    raw               jsonb            NOT NULL DEFAULT '{}'::jsonb,
    fetched_at        timestamptz      NOT NULL
);

CREATE INDEX financial_metrics_latest_idx
    ON financial_metrics (symbol, provider, fetched_at DESC);

-- One article can mention several symbols, so the symbol is part of the key.
CREATE TABLE news_articles (
    provider      text        NOT NULL,
    external_id   text        NOT NULL,
    symbol        text        NOT NULL,
    published_at  timestamptz NOT NULL,
    headline      text        NOT NULL,
    url           text        NOT NULL,
    summary       text,
    publisher     text,
    image_url     text,
    category      text,
    fetched_at    timestamptz NOT NULL,
    PRIMARY KEY (provider, external_id, symbol)
);

CREATE INDEX news_articles_symbol_published_idx
    ON news_articles (symbol, published_at DESC);

CREATE TABLE earnings_events (
    symbol            text        NOT NULL,
    provider          text        NOT NULL,
    date              date        NOT NULL,
    fiscal_year       integer,
    fiscal_quarter    smallint,
    hour              text,
    eps_estimate      double precision,
    eps_actual        double precision,
    revenue_estimate  numeric(24, 2),
    revenue_actual    numeric(24, 2),
    fetched_at        timestamptz NOT NULL,
    PRIMARY KEY (symbol, provider, date),
    CONSTRAINT earnings_events_hour_check
        CHECK (hour IS NULL OR hour IN ('bmo', 'amc', 'dmh'))
);

CREATE INDEX earnings_events_date_idx ON earnings_events (date);

CREATE TABLE recommendation_trends (
    symbol       text        NOT NULL,
    provider     text        NOT NULL,
    period       date        NOT NULL,
    strong_buy   integer     NOT NULL DEFAULT 0,
    buy          integer     NOT NULL DEFAULT 0,
    hold         integer     NOT NULL DEFAULT 0,
    sell         integer     NOT NULL DEFAULT 0,
    strong_sell  integer     NOT NULL DEFAULT 0,
    fetched_at   timestamptz NOT NULL,
    PRIMARY KEY (symbol, provider, period)
);
