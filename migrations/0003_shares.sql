-- 0003_shares.sql — share-card copy tracking.
-- One row per player per day they copied their share card. Public
-- POST /api/share writes here; no count is ever returned publicly —
-- only GET /api/admin/stats reads it back (sharesToday, sharesTotal).

CREATE TABLE IF NOT EXISTS shares (
  day TEXT NOT NULL,
  player_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (day, player_id)
);
