-- ============================================================
-- 00021_create_player_with_rating.sql
--
-- Atomic player + initial ratings creation. Replaces the two-step
-- inserts in player onboarding (apps/player/src/lib/actions/profile.ts)
-- and admin createPlayer (apps/admin/src/lib/actions.ts), where a failed
-- second insert could leave a player without a ratings row.
--
-- Note: trigger_init_player_records (00004) only fires on UPDATE OF
-- status (pending_approval -> active), never on INSERT, so this function
-- must insert the ratings row itself. The trigger's later insert uses
-- ON CONFLICT (player_id) DO NOTHING, so no double-insert occurs.
--
-- The ratings defaults (1200/1200, provisional, K 40/40) mirror what both
-- call sites inserted before this migration. onboarding_completed is TRUE
-- only for self-onboarding (p_user_id present): admin-created placeholder
-- players have no auth user and have not onboarded.
-- ============================================================

CREATE OR REPLACE FUNCTION create_player_with_rating(
  p_user_id uuid,
  p_email text,
  p_full_name text,
  p_display_name text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_status player_status DEFAULT 'pending_approval',
  p_role user_role DEFAULT 'player'
) RETURNS uuid AS $$
DECLARE
  v_player_id uuid;
BEGIN
  -- Mirror the self-onboarding RLS intent of 00018 (players_self_insert):
  -- a regular user may only create their own pending player row; anything
  -- else requires the service role.
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

  INSERT INTO players (user_id, email, full_name, display_name, phone, status, role, onboarding_completed)
  VALUES (p_user_id, p_email, p_full_name, p_display_name, p_phone, p_status, p_role, p_user_id IS NOT NULL)
  RETURNING id INTO v_player_id;

  INSERT INTO ratings (
    player_id, singles_elo, doubles_elo,
    singles_provisional, doubles_provisional,
    singles_k_factor, doubles_k_factor
  ) VALUES (v_player_id, 1200, 1200, TRUE, TRUE, 40, 40);

  RETURN v_player_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION create_player_with_rating(uuid, text, text, text, text, player_status, user_role) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_player_with_rating(uuid, text, text, text, text, player_status, user_role) TO authenticated, service_role;
