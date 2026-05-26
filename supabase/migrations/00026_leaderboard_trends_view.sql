-- Leaderboard Trend column data source.
-- Per (player, match_type), sums rating_delta over the player's most recent
-- 5 completed rated matches. Played-time ordered (not insert-time) so
-- retroactive entries don't skew the window.

CREATE OR REPLACE VIEW leaderboard_trends AS
WITH ranked AS (
  SELECT
    mp.player_id,
    m.match_type,
    mp.rating_delta,
    ROW_NUMBER() OVER (
      PARTITION BY mp.player_id, m.match_type
      ORDER BY m.played_at DESC, m.id DESC
    ) AS rn
  FROM match_participants mp
  JOIN matches m ON m.id = mp.match_id
  WHERE m.completed_flag = TRUE
    AND m.rated_flag = TRUE
    AND m.played_at IS NOT NULL
    AND mp.rating_delta IS NOT NULL
)
SELECT
  player_id,
  match_type,
  COUNT(*)::int AS sample_size,
  COALESCE(SUM(rating_delta), 0)::int AS trend_sum
FROM ranked
WHERE rn <= 5
GROUP BY player_id, match_type;

GRANT SELECT ON leaderboard_trends TO authenticated;
