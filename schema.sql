-- Triptych analytics — D1 schema
-- Pseudonymous: clientId is a UUID generated client-side, never tied to PII.

CREATE TABLE IF NOT EXISTS plays (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id    TEXT    NOT NULL,                -- random UUID per device
  puzzle_date  TEXT    NOT NULL,                -- YYYY-MM-DD (Pacific) for daily; '' for free-play
  mode         TEXT    NOT NULL,                -- 'daily' | 'free' | 'custom'
  difficulty   TEXT,                            -- 'beginner' | 'normal' | 'hard' | 'expert' (free only)
  attempts     INTEGER NOT NULL,                -- attempts used (1..N)
  won          INTEGER NOT NULL,                -- 0/1
  time_seconds INTEGER NOT NULL,                -- elapsed time
  hints_used   INTEGER NOT NULL DEFAULT 0,
  client_ts    INTEGER NOT NULL,                -- ms epoch from client
  server_ts    INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  app_version  TEXT,
  ua_hash      TEXT                             -- hashed UA prefix (no raw UA stored)
);

-- One row per (client, puzzle_date) for daily — replaces on resubmit
CREATE UNIQUE INDEX IF NOT EXISTS idx_plays_daily_unique
  ON plays(client_id, puzzle_date)
  WHERE mode = 'daily' AND puzzle_date != '';

CREATE INDEX IF NOT EXISTS idx_plays_puzzle_date ON plays(puzzle_date);
CREATE INDEX IF NOT EXISTS idx_plays_server_ts   ON plays(server_ts);
CREATE INDEX IF NOT EXISTS idx_plays_mode        ON plays(mode);

-- Lightweight session pings — used for DAU even when a player doesn't finish
CREATE TABLE IF NOT EXISTS sessions (
  client_id   TEXT NOT NULL,
  day_pacific TEXT NOT NULL,                    -- YYYY-MM-DD
  first_ts    INTEGER NOT NULL,
  last_ts     INTEGER NOT NULL,
  PRIMARY KEY (client_id, day_pacific)
);

CREATE INDEX IF NOT EXISTS idx_sessions_day ON sessions(day_pacific);
