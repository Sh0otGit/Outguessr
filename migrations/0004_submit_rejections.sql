-- 0004_submit_rejections.sql — rejected-submission counters for the
-- Players tab's "flagged activity" list. Without this table, a rejected
-- duplicate submission vanishes silently into POST /api/submit's
-- INSERT OR IGNORE — this is what makes rejection activity measurable
-- at all. One row per (day, player_id, reason); handleSubmit upserts
-- count += 1 on every rejection (duplicate/closed/invalid/blocked).

CREATE TABLE IF NOT EXISTS submit_rejections (
  day TEXT NOT NULL,
  player_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (day, player_id, reason)
);
