-- Yearly macroeconomic indicators by country or region (World Bank for now).
--
-- value is as published, in the indicator's own unit: percentages stay
-- percentages (2.1 = 2.1%), unlike the ratios in V1. indicator_name says
-- which unit. Rows are upserted on the key, since providers revise past years.
CREATE TABLE macro_observations (
    country         text             NOT NULL,
    indicator       text             NOT NULL,
    provider        text             NOT NULL,
    year            smallint         NOT NULL,
    value           double precision NOT NULL,
    country_name    text,
    indicator_name  text,
    fetched_at      timestamptz      NOT NULL,
    PRIMARY KEY (country, indicator, provider, year)
);

-- "This indicator for every country", e.g. to compare inflation.
CREATE INDEX macro_observations_indicator_idx ON macro_observations (indicator, year DESC);
