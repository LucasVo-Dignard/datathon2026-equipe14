-- Real news for the dashboard (src/marketdata/jobs/news-refresh.js, every 2 h).
--
-- Sources: RSS feeds of known media (CBC Business, Radio-Canada Économie,
-- The Globe and Mail, MarketWatch) and Yahoo Finance news per held symbol.
-- Only the title, a short summary and the link are kept, with the source
-- name: the app always links to the original article (terms of the feeds).
--
-- Enrichment, once per article, with Amazon Comprehend: dominant sentiment,
-- and the organizations named in the article, used to link RSS articles to
-- listed companies. Articles stay in their original language (en or fr).
--
-- news_articles (V1) stays the per-symbol cache of the Finnhub fetcher.

CREATE TABLE news_items (
    id               bigserial     PRIMARY KEY,
    source           text          NOT NULL,              -- feed id, e.g. 'cbc-business', 'yahoo'
    source_name      text          NOT NULL,              -- shown to the user, e.g. 'CBC Business'
    external_id      text          NOT NULL,              -- guid / uuid / link from the source
    url              text          NOT NULL CHECK (url ~ '^https?://'),
    published_at     timestamptz   NOT NULL,
    language         text          NOT NULL CHECK (language IN ('en', 'fr')),
    title            text          NOT NULL,
    summary          text,
    sentiment        text          CHECK (sentiment IN ('POSITIVE', 'NEGATIVE', 'NEUTRAL', 'MIXED')),
    sentiment_score  numeric(4, 3),                       -- Comprehend confidence of that sentiment
    organizations    text[]        NOT NULL DEFAULT '{}', -- Comprehend ORGANIZATION entities
    enriched_at      timestamptz,                         -- null = not processed by Comprehend yet
    fetched_at       timestamptz   NOT NULL DEFAULT now(),
    UNIQUE (source, external_id)
);

CREATE INDEX news_items_published_idx ON news_items (published_at DESC);
CREATE INDEX news_items_pending_idx ON news_items (fetched_at) WHERE enriched_at IS NULL;

-- Which listed companies an article is about, and why (shown to the user).
CREATE TABLE news_item_symbols (
    news_id  bigint  NOT NULL REFERENCES news_items (id) ON DELETE CASCADE,
    symbol   text    NOT NULL,
    reason   text    NOT NULL,  -- 'yahoo' (Yahoo related ticker) or 'comprehend:<organization>'
    PRIMARY KEY (news_id, symbol)
);

CREATE INDEX news_item_symbols_symbol_idx ON news_item_symbols (symbol);
