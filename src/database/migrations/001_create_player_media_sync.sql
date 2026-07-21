-- Worker-owned sync-state table.
-- NOTE: The worker creates this automatically on startup (DbListenerService.initialize),
-- so running this by hand is optional. It never modifies the CMS Prisma tables
-- (media, media_types, ...) — it only tracks which media has been copied to the player.

CREATE TABLE IF NOT EXISTS player_media_sync (
  media_id      TEXT PRIMARY KEY,          -- references media.id (no FK to stay decoupled from Prisma migrations)
  local_path    TEXT,                      -- where the file was saved in the player
  sync_status   VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending | syncing | completed | failed
  sync_error    TEXT,
  sync_attempts INT NOT NULL DEFAULT 0,    -- failed >= 3 attempts = dead-lettered
  synced_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
