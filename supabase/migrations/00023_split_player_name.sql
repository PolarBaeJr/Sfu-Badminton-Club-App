-- ============================================================
-- 00023 - Split players.full_name into first_name / last_name
-- ============================================================
-- Every reader in the apps and in 00003/00004/00021 selects full_name, so
-- it stays — as a GENERATED ALWAYS ... STORED column derived from the two
-- new parts. Readers need no change; writers do, because Postgres rejects
-- any write to a generated column ("can only be updated to DEFAULT").
--
-- Notes:
--   * The generation expression must be IMMUTABLE. concat_ws() is only
--     STABLE, so the concatenation is spelled out with || / COALESCE.
--   * The backfill splits on the FIRST whitespace run after collapsing
--     internal runs to a single space; a mononym ("Cher") leaves
--     last_name NULL and full_name unchanged. split_part() is not used —
--     it returns '' on a doubled space.
--   * full_name is dropped and re-added, so it moves to the end of the
--     column order. Nothing depends on ordinal position (no positional
--     INSERTs, no index, no policy, no view — the repo has none).
--   * Forward-only and destructive: apply as a single transaction
--     (psql --single-transaction), matching the runbook.
-- ============================================================

ALTER TABLE players ADD COLUMN first_name TEXT, ADD COLUMN last_name TEXT;

UPDATE players SET
  first_name = (regexp_match(btrim(regexp_replace(full_name,'\s+',' ','g')), '^(\S+)'))[1],
  last_name  = NULLIF(btrim(regexp_replace(btrim(regexp_replace(full_name,'\s+',' ','g')), '^\S+\s*','')),'');

-- Fail closed: a whitespace-only full_name would leave first_name NULL and
-- silently break the NOT NULL below, so abort the whole migration instead.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM players WHERE first_name IS NULL) THEN
    RAISE EXCEPTION 'backfill left NULL first_name — whitespace-only full_name present';
  END IF;
END $$;

ALTER TABLE players ALTER COLUMN first_name SET NOT NULL;
ALTER TABLE players DROP COLUMN full_name;
ALTER TABLE players ADD COLUMN full_name TEXT
  GENERATED ALWAYS AS (btrim(first_name || COALESCE(' ' || NULLIF(btrim(last_name),''),''))) STORED;
ALTER TABLE players ALTER COLUMN full_name SET NOT NULL;

-- ------------------------------------------------------------
-- create_player_with_rating: take the name parts, not full_name
-- ------------------------------------------------------------
-- The old 7-arg version INSERTs full_name, which now fails against the
-- generated column. CREATE OR REPLACE with a different argument list would
-- create an overload and leave that broken path callable, so drop it first.
-- The grants die with the dropped function and are re-issued below against
-- the new signature. Body is otherwise the 00003_functions.sql definition.
DROP FUNCTION IF EXISTS create_player_with_rating(uuid, text, text, text, text, player_status, user_role);

CREATE OR REPLACE FUNCTION create_player_with_rating(
  p_user_id uuid,
  p_email text,
  p_first_name text,
  p_last_name text DEFAULT NULL,
  p_display_name text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_status player_status DEFAULT 'pending_approval',
  p_role user_role DEFAULT 'player'
) RETURNS uuid AS $$
DECLARE
  v_player_id uuid;
BEGIN
  -- Mirror the self-onboarding RLS intent of players_self_insert
  -- (00005_rls.sql): a regular user may only create their own pending
  -- player row; anything else requires the service role.
  IF NOT (
    auth.role() = 'service_role'
    OR (
      p_user_id IS NOT NULL
      AND p_user_id = auth.uid()
      AND p_status = 'pending_approval'
      AND p_role = 'player'
    )
  ) THEN
    RAISE EXCEPTION 'Not authorized to create this player';
  END IF;

  INSERT INTO players (user_id, email, first_name, last_name, display_name, phone, status, role, onboarding_completed)
  VALUES (p_user_id, p_email, p_first_name, p_last_name, p_display_name, p_phone, p_status, p_role, p_user_id IS NOT NULL)
  RETURNING id INTO v_player_id;

  INSERT INTO ratings (
    player_id, singles_elo, doubles_elo,
    singles_provisional, doubles_provisional,
    singles_k_factor, doubles_k_factor
  ) VALUES (v_player_id, 400, 400, TRUE, TRUE, 80, 64);

  RETURN v_player_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION create_player_with_rating(uuid, text, text, text, text, text, player_status, user_role) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_player_with_rating(uuid, text, text, text, text, text, player_status, user_role) TO authenticated, service_role;
