-- ============================================================
-- 00021 - Add avatar_url to get_leaderboard()
-- ============================================================
-- The leaderboard list renders AvatarChip from this RPC's rows, but the
-- function didn't return avatar_url, so those avatars could only ever show
-- initials. Add it. RETURNS TABLE signature changes, so DROP + recreate
-- (CREATE OR REPLACE can't change the return type). Body is otherwise the
-- exact current definition.
-- ============================================================
DROP FUNCTION IF EXISTS get_leaderboard();

CREATE FUNCTION public.get_leaderboard()
 RETURNS TABLE(
   id uuid, name text, status player_status, avatar_url text,
   singles_elo integer, doubles_elo integer,
   singles_wins integer, singles_losses integer,
   doubles_wins integer, doubles_losses integer,
   singles_provisional boolean, doubles_provisional boolean,
   current_singles_streak integer, current_doubles_streak integer,
   tournament_points integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    p.id, COALESCE(p.display_name, p.full_name) AS name, p.status, p.avatar_url,
    r.singles_elo, r.doubles_elo,
    r.singles_wins, r.singles_losses, r.doubles_wins, r.doubles_losses,
    r.singles_provisional, r.doubles_provisional,
    r.current_singles_streak, r.current_doubles_streak,
    COALESCE(tp.pts, 0)::int AS tournament_points
  FROM players p
  JOIN ratings r ON r.player_id = p.id
  LEFT JOIN (
    SELECT tpa.player_id, SUM(tpa.points)::int AS pts
    FROM tournament_participants tpa
    WHERE tpa.status NOT IN ('withdrawn', 'disqualified') AND tpa.points > 0
    GROUP BY tpa.player_id
  ) tp ON tp.player_id = p.id
  WHERE p.active_flag = TRUE
    AND p.hide_from_leaderboard = FALSE
    AND p.status NOT IN ('pending_approval', 'suspended');
$function$;

GRANT EXECUTE ON FUNCTION get_leaderboard() TO authenticated, anon, service_role;
