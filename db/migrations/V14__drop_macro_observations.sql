-- The Macro tab and the World Bank data were removed from the app: drop their
-- table (created in V5, provenance columns in V6). Its index goes with it.

DROP TABLE IF EXISTS macro_observations;
