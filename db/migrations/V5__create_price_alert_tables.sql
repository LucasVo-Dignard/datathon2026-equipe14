-- Price-move alerts by email (Amazon SNS).
--
-- The web app (app/notifications.js) writes notification_subscriptions when a
-- user subscribes; the daily job (src/marketdata/jobs/price_alerts.py) reads
-- it after the refresh, finds large daily moves on the user's symbols and
-- publishes one email per user to the environment's SNS topic.
--
-- Users are still in the app's JSON file (prototype login), so username is
-- not a foreign key yet, like investor_profiles.

CREATE TABLE notification_subscriptions (
    username          text          PRIMARY KEY,
    email             text          NOT NULL,
    subscription_arn  text          NOT NULL,  -- SNS email subscription, filtered on username
    threshold_pct     numeric(5, 2) NOT NULL CHECK (threshold_pct > 0 AND threshold_pct <= 50),
                                                -- alert when |daily change| >= this (%), set from the risk level
    symbols           text[]        NOT NULL DEFAULT '{}',  -- Yahoo tickers of the user's holdings
    created_at        timestamptz   NOT NULL DEFAULT now(),
    updated_at        timestamptz   NOT NULL DEFAULT now()
);

-- One row per alert already sent, so a rerun or a retry never sends twice.
CREATE TABLE price_alerts_sent (
    username    text          NOT NULL REFERENCES notification_subscriptions (username) ON DELETE CASCADE,
    symbol      text          NOT NULL,
    bar_date    date          NOT NULL,          -- trading day of the move
    change_pct  numeric(8, 3) NOT NULL,
    sent_at     timestamptz   NOT NULL DEFAULT now(),
    PRIMARY KEY (username, symbol, bar_date)
);
