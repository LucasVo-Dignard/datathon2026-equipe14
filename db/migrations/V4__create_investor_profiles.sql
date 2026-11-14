-- Investor profiles from the guided questionnaire (app/profile.js).
-- Read and written by app/profile-store.js; one row per user.
--
-- answers and result are JSONB because the questionnaire still evolves:
-- adding a question must not need a migration. risk_level and score are
-- copied out of result so they can be filtered and indexed.
--
-- Users and sessions are still in the app's JSON file (prototype login).
-- When a users table exists, add a foreign key on username in a new migration.

CREATE TABLE investor_profiles (
    username    text        PRIMARY KEY,
    answers     jsonb       NOT NULL,   -- raw questionnaire answers
    result      jsonb       NOT NULL,   -- computed profile: score, guardrails, tensions...
    risk_level  text        NOT NULL,   -- result.level.id, e.g. 'faible-modere'
    score       smallint    NOT NULL CHECK (score BETWEEN 0 AND 100),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX investor_profiles_risk_level_idx ON investor_profiles (risk_level);
