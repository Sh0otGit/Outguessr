-- 0001_init.sql — Phase 2 schema.
-- answers is the source of truth (raw, append-only). results is derived
-- and can always be rebuilt from answers by re-running the tally.

CREATE TABLE IF NOT EXISTS answers (
  day TEXT NOT NULL,
  player_id TEXT NOT NULL,
  answer TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (day, player_id)
);

CREATE TABLE IF NOT EXISTS results (
  day TEXT PRIMARY KEY,
  blob TEXT NOT NULL,
  computed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cron_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT,
  ran_at INTEGER,
  duration_ms INTEGER,
  players INTEGER,
  bots INTEGER,
  ok INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
);

INSERT OR IGNORE INTO config (key, value) VALUES ('bot_floor', '300');
INSERT OR IGNORE INTO config (key, value) VALUES ('bots_enabled', '1');
