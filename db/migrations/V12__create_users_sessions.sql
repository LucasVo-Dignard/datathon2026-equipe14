-- Users and login sessions (app/session-store.js). Until now they were only in
-- the app's JSON file; on its first start with Postgres, the app copies that
-- file into the database (app/json-import.js).
--
-- Login is still username-only (prototype): users has no password.
--
-- Also adds the foreign keys on username that V4, V7, V8 and V9 left for when
-- a users table exists. Users that only appear in those tables are created first.

CREATE TABLE users (
    username    text        PRIMARY KEY,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- token is the value of the sid cookie (32 random bytes, hex).
CREATE TABLE sessions (
    token       text        PRIMARY KEY,
    username    text        NOT NULL REFERENCES users (username) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL
);

CREATE INDEX sessions_username_idx ON sessions (username);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

INSERT INTO users (username)
SELECT username FROM investor_profiles
UNION SELECT username FROM portfolios
UNION SELECT username FROM notification_subscriptions
UNION SELECT owner FROM chats
ON CONFLICT (username) DO NOTHING;

ALTER TABLE investor_profiles
    ADD CONSTRAINT investor_profiles_username_fkey
    FOREIGN KEY (username) REFERENCES users (username) ON DELETE CASCADE;

ALTER TABLE portfolios
    ADD CONSTRAINT portfolios_username_fkey
    FOREIGN KEY (username) REFERENCES users (username) ON DELETE CASCADE;

ALTER TABLE notification_subscriptions
    ADD CONSTRAINT notification_subscriptions_username_fkey
    FOREIGN KEY (username) REFERENCES users (username) ON DELETE CASCADE;

ALTER TABLE chats
    ADD CONSTRAINT chats_owner_fkey
    FOREIGN KEY (owner) REFERENCES users (username) ON DELETE CASCADE;
