-- Simulated portfolios (app/portfolio-store.js). One row per user in
-- portfolios, created when the user picks how to start: a random selection of
-- stored tickers, or an empty portfolio they fill themselves.
--
-- avg_cost is in the listing currency of the symbol; the app converts to CAD
-- when it values the portfolio.
--
-- Users and sessions are still in the app's JSON file (prototype login).
-- When a users table exists, add a foreign key on username in a new migration.

CREATE TABLE portfolios (
    username    text           PRIMARY KEY,
    source      text           NOT NULL CHECK (source IN ('random', 'custom')),
    cash        numeric(20, 2) NOT NULL DEFAULT 0 CHECK (cash >= 0),
    created_at  timestamptz    NOT NULL DEFAULT now()
);

CREATE TABLE portfolio_holdings (
    username    text           NOT NULL REFERENCES portfolios (username) ON DELETE CASCADE,
    symbol      text           NOT NULL,
    quantity    numeric(20, 6) NOT NULL CHECK (quantity > 0),
    avg_cost    numeric(20, 6) NOT NULL CHECK (avg_cost >= 0),
    added_at    timestamptz    NOT NULL DEFAULT now(),
    updated_at  timestamptz    NOT NULL DEFAULT now(),
    PRIMARY KEY (username, symbol)
);
