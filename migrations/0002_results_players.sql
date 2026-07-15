-- 0002_results_players.sql — per-player Split or Steal outcomes.
-- One row per real player per day they played a splitsteal challenge.
-- Rewritten wholesale (delete + reinsert) by every tally run, same
-- idempotency contract as `results`: never hand-edited, always
-- rebuilt fresh from `answers` + the deterministic pairing seed.

CREATE TABLE IF NOT EXISTS results_players (
  day TEXT NOT NULL,
  player_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  PRIMARY KEY (day, player_id)
);
