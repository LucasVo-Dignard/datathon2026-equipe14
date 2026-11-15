-- Price-move alerts by email (Amazon SES).
--
-- The web app (app/notifications.js) writes notification_subscriptions when a
-- user subscribes on the profile page. After each refresh, the daily job
-- (src/marketdata/jobs/price-alerts.js) compares the two latest closes of the
-- user's holdings (portfolio_holdings, V7) and emails one summary per user.
--
-- Users are still in the app's JSON file (prototype login), so username is
-- not a foreign key yet, like investor_profiles and portfolios.

CREATE TABLE notification_subscriptions (
    username           text          PRIMARY KEY,
    email              text          NOT NULL,
    -- alert when |daily change| >= this (%), set from the investor profile's risk level
    threshold_pct      numeric(5, 2) NOT NULL CHECK (threshold_pct > 0 AND threshold_pct <= 50),
    -- secret of the one-click unsubscribe link in every email
    -- (GET /desabonnement?u=<username>&t=<token>, no login), new for each new address
    unsubscribe_token  uuid          NOT NULL DEFAULT gen_random_uuid(),
    created_at         timestamptz   NOT NULL DEFAULT now(),
    updated_at         timestamptz   NOT NULL DEFAULT now()
);

-- One row per alert already sent, so a rerun or an AWS Batch retry never sends twice.
CREATE TABLE price_alerts_sent (
    username    text          NOT NULL REFERENCES notification_subscriptions (username) ON DELETE CASCADE,
    symbol      text          NOT NULL,
    bar_date    date          NOT NULL,   -- trading day of the move
    change_pct  numeric(8, 3) NOT NULL,
    sent_at     timestamptz   NOT NULL DEFAULT now(),
    PRIMARY KEY (username, symbol, bar_date)
);
