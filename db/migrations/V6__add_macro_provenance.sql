-- Provenance of each macro observation (see models.macroObservation):
--   provider             the API we called ("worldbank"), already in V5
--   dataset              the provider's database ("World Development Indicators")
--   source_organization  who originally produced the numbers (e.g. the IMF)
--   source_updated_on    when the provider last updated the data
--   source_url           a page where a person can check the value
-- NULL for rows saved before this migration; the app reloads them.
ALTER TABLE macro_observations
    ADD COLUMN dataset              text,
    ADD COLUMN source_organization  text,
    ADD COLUMN source_updated_on    date,
    ADD COLUMN source_url           text;
