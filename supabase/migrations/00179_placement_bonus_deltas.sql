-- 00179_placement_bonus_deltas.sql
--
-- Tournament placement bonuses are the last place in the schema that still
-- moves a rating by writing an absolute computed outside the lock. 00082 fixed
-- the tournament ladder, 00177 fixed the challenge path, and this fixes the
-- podium.
--
-- THE BUG. finalizeEvent reads every winner's rating in one batched SELECT,
-- adds the bonus in TypeScript, and writes the sum back with
-- `UPDATE ratings SET singles_elo = <number> WHERE player_id = ...`. Anything
-- that moves the same player between that read and that write is erased —
-- another event finalising, a challenge confirming, an exec correction. The
-- read is batched across every medallist, so the window is the whole batch, not
-- one row.
--
-- Worse, a missing rating row read as 400 and the bonus was added to THAT, so
-- an unreadable rating silently reset a player to 400 + bonus. And because
-- `current + bonus` is not idempotent, the ledger that makes retries safe has
-- to be exactly right or a retry pays twice.
--
-- THE FIX. One locked read-add-clamp inside the database, returning what
-- actually landed. Deltas commute; absolutes do not.
--
-- WHY NOT apply_rating_delta (00082). That function also increments matches
-- played, wins or losses, points, games, the streak and the provisional flag —
-- correct for a match, wrong for a podium bonus, which is not a match. This is
-- the rating-only half of the same idea.
--
-- The applied delta is returned rather than the requested one because the clamp
-- absorbs part of a bonus at the ceiling, and the caller records what it paid.
-- A player already at max_elo gets applied_delta = 0, which is the honest
-- answer and lets the ledger mark them settled rather than retrying forever.

BEGIN;

CREATE OR REPLACE FUNCTION public.apply_placement_bonus(
  p_player_id  uuid,
  p_discipline text,
  p_bonus      integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_elo_field TEXT;
  v_lo INTEGER;
  v_hi INTEGER;
  v_old INTEGER;
  v_new INTEGER;
BEGIN
  IF p_discipline NOT IN ('singles', 'doubles') THEN
    RAISE EXCEPTION 'invalid discipline: %', p_discipline;
  END IF;
  v_elo_field := CASE WHEN p_discipline = 'singles' THEN 'singles_elo' ELSE 'doubles_elo' END;

  -- FOR UPDATE is the entire point of moving this into the database. The old
  -- path read every medallist's rating in one batch and wrote the sums back
  -- afterwards, so any rating change in between was overwritten.
  EXECUTE format('SELECT %I FROM ratings WHERE player_id = $1 FOR UPDATE', v_elo_field)
    INTO v_old USING p_player_id;

  -- NOT 400. A player with no ratings row is an integrity problem; inventing a
  -- starting rating for them and adding a podium bonus to it writes a number
  -- nobody can distinguish from a real one afterwards.
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'No ratings row for player % — cannot award a placement bonus', p_player_id;
  END IF;

  SELECT lo, hi INTO v_lo, v_hi FROM rating_bounds();
  v_new := LEAST(GREATEST(v_old + COALESCE(p_bonus, 0), v_lo), v_hi);

  EXECUTE format('UPDATE ratings SET %I = $1, updated_at = NOW() WHERE player_id = $2', v_elo_field)
    USING v_new, p_player_id;

  RETURN jsonb_build_object('new_elo', v_new, 'applied_delta', v_new - v_old);
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_placement_bonus(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_placement_bonus(uuid, text, integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
