-- ============================================================
-- 00048_configurable_challenge_caps.sql — make the challenge
-- caps in the admin panel actually take effect
--
-- platform_settings has offered repeat_opponent_caps and
-- challenge_rules.max_active_challenges since the settings UI
-- was built, but validate_challenge_creation hardcoded every
-- one of them. Prod currently holds
-- max_rated_singles_vs_same_7days = 4 while the function
-- refuses at 2, so raising the limit in the admin panel did
-- nothing at all and the member just saw
-- "Maximum 2 rated matches vs same opponent in 7 days".
--
-- Same class of bug as 00041 (settings offered, never read).
-- ============================================================

-- ============================================================
-- GENERALISED SETTINGS READER
-- ============================================================

-- rating_setting_int (00041) is hardwired to the rating_defaults row. The caps
-- below live in other sections, so this takes the section as an argument.
-- Same defensive contract: a missing row, missing key, NULL, or a value that
-- will not cast falls back to the supplied default rather than erroring or —
-- far worse — silently resolving to 0 and refusing every challenge.
CREATE OR REPLACE FUNCTION platform_setting_int(p_section TEXT, p_key TEXT, p_default INTEGER)
RETURNS INTEGER AS $$
DECLARE
  v_raw TEXT;
BEGIN
  SELECT value->>p_key INTO v_raw FROM platform_settings WHERE key = p_section;
  IF v_raw IS NULL OR v_raw = '' THEN
    RETURN p_default;
  END IF;
  RETURN v_raw::INTEGER;
EXCEPTION WHEN OTHERS THEN
  RETURN p_default;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

COMMENT ON FUNCTION platform_setting_int(TEXT, TEXT, INTEGER) IS
  'Reads an integer from platform_settings.<section>, falling back to the supplied default when the section, key, or value is absent, null, or not castable.';

GRANT EXECUTE ON FUNCTION platform_setting_int(TEXT, TEXT, INTEGER) TO authenticated;

-- A rolling window was always implied by the key names but never configurable.
-- Seeded to 7 so behaviour is unchanged until someone edits it.
UPDATE platform_settings
   SET value = value || jsonb_build_object('window_days', 7)
 WHERE key = 'repeat_opponent_caps'
   AND NOT value ? 'window_days';

-- ============================================================
-- validate_challenge_creation — caps from settings
--
-- Replacing the whole function rather than patching: plpgsql has no way to
-- redefine part of a body. Everything outside the two cap blocks is carried
-- over verbatim from the live definition.
-- ============================================================

CREATE OR REPLACE FUNCTION public.validate_challenge_creation(
  p_creator_id uuid,
  p_opponent_id uuid,
  p_type text,
  p_partner_id uuid DEFAULT NULL::uuid,
  p_opponent_partner_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_errors TEXT[] := '{}';
  v_active_count INTEGER;
  v_repeat_count INTEGER;
  v_creator_status TEXT;
  v_creator_banned BOOLEAN;
  v_creator_active BOOLEAN;
  v_opponent_status TEXT;
  v_opponent_banned BOOLEAN;
  v_opponent_active BOOLEAN;
  v_partner_expected INTEGER;
  v_partner_eligible INTEGER;
  v_max_active INTEGER;
  v_max_repeat INTEGER;
  v_window_days INTEGER;
BEGIN
  -- Read once per call. These are cheap single-row lookups and reading them
  -- up front keeps the cap value used in the test identical to the one quoted
  -- back in the error message.
  v_max_active := platform_setting_int('challenge_rules', 'max_active_challenges', 3);
  v_window_days := platform_setting_int('repeat_opponent_caps', 'window_days', 7);
  v_max_repeat := CASE
    WHEN p_type = 'doubles'
      THEN platform_setting_int('repeat_opponent_caps', 'max_rated_doubles_same_combo_7days', 2)
    ELSE platform_setting_int('repeat_opponent_caps', 'max_rated_singles_vs_same_7days', 2)
  END;

  -- Check creator eligibility. A missing row (NULL status) is treated as
  -- ineligible: the IS DISTINCT FROM TRUE tests below fail closed on NULL.
  SELECT status, is_banned, active_flag
    INTO v_creator_status, v_creator_banned, v_creator_active
    FROM players WHERE id = p_creator_id;
  IF v_creator_status IS NULL
     OR v_creator_status IN ('suspended', 'inactive', 'pending_approval')
     OR v_creator_banned IS DISTINCT FROM FALSE
     OR v_creator_active IS DISTINCT FROM TRUE THEN
    v_errors := array_append(v_errors, 'Your account cannot create challenges');
  END IF;

  -- Check opponent eligibility (status + ban + deactivation).
  SELECT status, is_banned, active_flag
    INTO v_opponent_status, v_opponent_banned, v_opponent_active
    FROM players WHERE id = p_opponent_id;
  IF v_opponent_status IS NULL
     OR v_opponent_status IN ('suspended', 'inactive', 'pending_approval')
     OR v_opponent_banned IS DISTINCT FROM FALSE
     OR v_opponent_active IS DISTINCT FROM TRUE THEN
    v_errors := array_append(v_errors, 'Opponent cannot accept challenges');
  END IF;

  -- Self-challenge check
  IF p_creator_id = p_opponent_id THEN
    v_errors := array_append(v_errors, 'Cannot challenge yourself');
  END IF;

  -- Active challenge cap — challenge_rules.max_active_challenges
  SELECT COUNT(*) INTO v_active_count FROM challenges
  WHERE created_by = p_creator_id AND status IN ('proposed', 'partially_confirmed', 'accepted');
  IF v_active_count >= v_max_active THEN
    v_errors := array_append(v_errors,
      format('Maximum %s active challenges reached', v_max_active));
  END IF;

  -- Repeat opponent — repeat_opponent_caps, per match type, over a
  -- configurable window. The message quotes the live numbers so an admin who
  -- changes the cap sees the change reflected back instead of stale copy.
  SELECT COUNT(*) INTO v_repeat_count FROM matches m
  JOIN match_participants mp1 ON mp1.match_id = m.id AND mp1.player_id = p_creator_id
  JOIN match_participants mp2 ON mp2.match_id = m.id AND mp2.player_id = p_opponent_id AND mp2.team_side != mp1.team_side
  WHERE m.played_at > NOW() - make_interval(days => v_window_days)
    AND m.match_type = p_type::match_type_enum;
  IF v_repeat_count >= v_max_repeat THEN
    v_errors := array_append(v_errors,
      format('Maximum %s rated matches vs same opponent in %s days', v_max_repeat, v_window_days));
  END IF;

  -- Doubles partner checks
  IF p_type = 'doubles' THEN
    IF p_partner_id IS NULL OR p_opponent_partner_id IS NULL THEN
      v_errors := array_append(v_errors, 'Doubles requires a partner for each side');
    END IF;
    IF p_partner_id = p_creator_id OR p_partner_id = p_opponent_id OR p_opponent_partner_id = p_creator_id THEN
      v_errors := array_append(v_errors, 'Duplicate player in challenge');
    END IF;
    -- The opponent's partner was never compared against the opponent, so the
    -- same member could fill both slots on side B.
    IF p_opponent_partner_id = p_opponent_id OR p_opponent_partner_id = p_partner_id THEN
      v_errors := array_append(v_errors, 'Duplicate player in challenge');
    END IF;

    v_partner_expected := (
      SELECT COUNT(*) FROM (VALUES (p_partner_id), (p_opponent_partner_id)) AS t(id)
      WHERE t.id IS NOT NULL
    );

    SELECT COUNT(*) INTO v_partner_eligible
      FROM players
      WHERE id IN (p_partner_id, p_opponent_partner_id)
        -- status::TEXT, not a bare enum comparison: the status list below is
        -- carried over verbatim from the original function and contains
        -- 'inactive', which is NOT a player_status label (the enum is
        -- competitive/recreational/pending_approval/suspended). The creator and
        -- opponent checks only ever compared it through a TEXT variable, so the
        -- stray value was inert; comparing the enum directly would raise
        -- "invalid input value for enum player_status". Keeping the cast keeps
        -- the semantics identical and tolerates the label being added later.
        AND status::TEXT NOT IN ('suspended', 'inactive', 'pending_approval')
        AND is_banned = FALSE
        AND active_flag = TRUE;

    IF v_partner_eligible <> v_partner_expected THEN
      v_errors := array_append(v_errors, 'A selected partner cannot join challenges');
    END IF;
  END IF;

  RETURN jsonb_build_object('valid', array_length(v_errors, 1) IS NULL, 'errors', to_jsonb(v_errors));
END;
$function$;
