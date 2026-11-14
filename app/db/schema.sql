-- Schéma Postgres. Idempotent : exécuté au démarrage du serveur (voir profile-store.js).
-- Les utilisateurs et sessions sont encore dans le fichier JSON (login prototype) :
-- quand la table users existera, ajouter
--   REFERENCES users(username) ON DELETE CASCADE
-- sur investor_profiles.username.

CREATE TABLE IF NOT EXISTS investor_profiles (
  username    TEXT        PRIMARY KEY,
  answers     JSONB       NOT NULL,              -- réponses brutes au questionnaire
  result      JSONB       NOT NULL,              -- profil calculé par profile.js (score, garde-fous, tensions...)
  risk_level  TEXT        NOT NULL,              -- copie de result.level.id, pour filtrer facilement
  score       SMALLINT    NOT NULL CHECK (score BETWEEN 0 AND 100),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS investor_profiles_risk_level_idx ON investor_profiles (risk_level);
