-- Analyst price targets. Same conventions as V1 (amounts in the listing
-- currency, rows written on demand, provider recorded on each row).

-- Snapshots, not upserts (like financial_metrics): comparing consecutive
-- fetches detects consensus moves ("mean target up 8%", "Buy -> Hold").
-- Targets are NULL when no analyst covers the symbol; the row still records
-- that we checked, so the cache doesn't refetch it on every request.
CREATE TABLE price_target_consensus (
    id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    symbol               text             NOT NULL,
    provider             text             NOT NULL,
    currency             text,
    current_price        numeric(20, 6),
    target_mean          numeric(20, 6),
    target_median        numeric(20, 6),
    target_high          numeric(20, 6),
    target_low           numeric(20, 6),
    analyst_count        integer,
    recommendation_mean  double precision,
    recommendation_key   text,
    fetched_at           timestamptz      NOT NULL
);

CREATE INDEX price_target_consensus_latest_idx
    ON price_target_consensus (symbol, provider, fetched_at DESC);

-- One row per firm action. Refetching the same window upserts on the key.
-- action: "up", "down", "init", "main" or "reit" for Yahoo; no CHECK
-- constraint because providers use different codes.
CREATE TABLE analyst_rating_actions (
    symbol               text        NOT NULL,
    provider             text        NOT NULL,
    graded_at            timestamptz NOT NULL,
    firm                 text        NOT NULL,
    action               text,
    from_grade           text,
    to_grade             text,
    price_target_action  text,
    price_target         numeric(20, 6),
    prior_price_target   numeric(20, 6),
    fetched_at           timestamptz NOT NULL,
    PRIMARY KEY (symbol, provider, graded_at, firm)
);

CREATE INDEX analyst_rating_actions_symbol_graded_idx
    ON analyst_rating_actions (symbol, graded_at DESC);
