-- Chat conversations and their messages (app/server.js, through app/chat-store.js).
-- One row per conversation in chats, one row per message in chat_messages.
--
-- Users and sessions are still in the app's JSON file (prototype login), so
-- owner is a plain username. When a users table exists, add a foreign key on
-- owner in a new migration.
--
-- Idempotent (IF NOT EXISTS): this migration was first numbered V5, and the
-- andre environment already has these tables from it.

CREATE TABLE IF NOT EXISTS chats (
    id          uuid        PRIMARY KEY,
    owner       text        NOT NULL,
    title       text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Sidebar listing: a user's chats, most recent first.
CREATE INDEX IF NOT EXISTS chats_owner_updated_at_idx ON chats (owner, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    chat_id     uuid        NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
    role        text        NOT NULL CHECK (role IN ('user', 'assistant')),
    content     text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Loading a conversation in order.
CREATE INDEX IF NOT EXISTS chat_messages_chat_id_idx ON chat_messages (chat_id, id);
