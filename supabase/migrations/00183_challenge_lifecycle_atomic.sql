-- ============================================================
-- 00183 — creating and answering a challenge each become one statement
--
-- Audit F-014 and F-008. Both are the same shape: a server action reads state,
-- decides, and then writes in two or more round trips with nothing holding the
-- decision still in between.
--
-- F-014 — CREATION. createChallenge inserts the `challenges` row, then inserts
-- `challenge_participants` with a second client. If that second insert fails —
-- a transient PostgREST error, a redeploy, the request being abandoned — the
-- challenge row survives with NO participants. It is 'proposed', it counts
-- against the creator's max_active_challenges forever (nothing can accept,
-- reject or cancel a challenge with no participants: every one of those paths
-- looks the actor up in the participant list first), and the creator is locked
-- out of challenging anybody after three of them.
--
-- The validation is also outside the write. validate_challenge_creation counts
-- the creator's active challenges and then the insert happens some
-- milliseconds later, so two tabs submitted together both pass a cap of 3 at 2
-- and both insert.
--
-- F-008 — ANSWERING. acceptChallenge already carries the confession:
-- "Recompute aggregate status from latest snapshot (still racy across
-- concurrent accepts; canonical fix is a SECURITY DEFINER RPC)". Two partners
-- accepting a doubles challenge in the same second both read a snapshot where
-- the other is still 'pending', both write their own row, and both then compute
-- allAccepted = false. The challenge stays 'partially_confirmed' with every
-- participant accepted — stranded, because nothing ever recomputes it again.
-- Neither member can play the match and neither did anything wrong.
--
-- Both functions below resolve the actor from auth.uid() and take NO player id.
-- That is deliberate and it is 00126's lesson: a SECURITY DEFINER function that
-- accepts the player it should act as is an impersonation primitive the moment
-- it is reachable over PostgREST. These are granted to `authenticated` and
-- called with the member's own client.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- create_challenge_atomic — validate, insert, enrol, in one transaction
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_challenge_atomic(
  p_type                 TEXT,
  p_rated_flag           BOOLEAN,
  p_format               TEXT,
  p_opponent_id          UUID,
  p_partner_id           UUID DEFAULT NULL,
  p_opponent_partner_id  UUID DEFAULT NULL,
  p_games_per_match      SMALLINT DEFAULT NULL,
  p_points_per_game      SMALLINT DEFAULT NULL,
  p_session_id           UUID DEFAULT NULL,
  p_scheduled_date       DATE DEFAULT NULL,
  p_scheduled_time       TIME DEFAULT NULL,
  p_note                 TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_creator    UUID;
  v_validation JSONB;
  v_challenge  UUID;
BEGIN
  v_creator := get_player_id(auth.uid());
  IF v_creator IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  -- Serialise a single member's own concurrent creations. Without it the cap
  -- check below is a read that another transaction can invalidate before the
  -- insert lands. Transaction-scoped, so it is released by the COMMIT or the
  -- ROLLBACK either way, and it is keyed on the creator so two different
  -- members never wait on each other.
  PERFORM pg_advisory_xact_lock(hashtext('challenge_create:' || v_creator::TEXT));

  -- THE SAME FUNCTION THE APP USED TO CALL, unchanged and called from inside
  -- the transaction that writes. Its rules are the club's, and re-implementing
  -- them here would be a second copy free to disagree with the first.
  v_validation := validate_challenge_creation(
    v_creator, p_opponent_id, p_type, p_partner_id, p_opponent_partner_id
  );
  IF NOT COALESCE((v_validation->>'valid')::BOOLEAN, FALSE) THEN
    RETURN jsonb_build_object('valid', FALSE, 'errors', v_validation->'errors');
  END IF;

  INSERT INTO challenges (
    type, rated_flag, format, games_per_match, points_per_game,
    event_type, session_id, scheduled_date, scheduled_time,
    created_by, status, note
  ) VALUES (
    p_type::match_type_enum,
    p_rated_flag,
    p_format::match_format,
    p_games_per_match,
    p_points_per_game,
    -- Mirrors the app's `input.rated_flag ? 'rated_challenge' : 'casual'`. It
    -- moves here so the two can never disagree about what a rated flag means.
    CASE WHEN p_rated_flag THEN 'rated_challenge' ELSE 'casual' END::event_type_enum,
    p_session_id, p_scheduled_date, p_scheduled_time,
    v_creator, 'proposed'::challenge_status, p_note
  )
  RETURNING id INTO v_challenge;

  -- The creator is 'accepted' by construction; everyone else is asked.
  INSERT INTO challenge_participants (challenge_id, player_id, role, team_side, confirmation_status)
  VALUES
    (v_challenge, v_creator,      'challenger'::participant_role, 'a'::team_side, 'accepted'::confirmation_status),
    (v_challenge, p_opponent_id,  'opponent'::participant_role,   'b'::team_side, 'pending'::confirmation_status);

  IF p_type = 'doubles' THEN
    IF p_partner_id IS NOT NULL THEN
      INSERT INTO challenge_participants (challenge_id, player_id, role, team_side, confirmation_status)
      VALUES (v_challenge, p_partner_id, 'partner'::participant_role, 'a'::team_side, 'pending'::confirmation_status);
    END IF;
    IF p_opponent_partner_id IS NOT NULL THEN
      INSERT INTO challenge_participants (challenge_id, player_id, role, team_side, confirmation_status)
      VALUES (v_challenge, p_opponent_partner_id, 'opponent_partner'::participant_role, 'b'::team_side, 'pending'::confirmation_status);
    END IF;
  END IF;

  RETURN jsonb_build_object('valid', TRUE, 'challenge_id', v_challenge);
END;
$function$;

REVOKE ALL ON FUNCTION public.create_challenge_atomic(
  TEXT, BOOLEAN, TEXT, UUID, UUID, UUID, SMALLINT, SMALLINT, UUID, DATE, TIME, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_challenge_atomic(
  TEXT, BOOLEAN, TEXT, UUID, UUID, UUID, SMALLINT, SMALLINT, UUID, DATE, TIME, TEXT
) TO authenticated, service_role;

-- ------------------------------------------------------------
-- respond_to_challenge — answer, then recompute under the same lock
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.respond_to_challenge(
  p_challenge_id UUID,
  p_response     TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_player     UUID;
  v_created_by UUID;
  v_status     challenge_status;
  v_mine       confirmation_status;
  v_new_status challenge_status;
BEGIN
  IF p_response NOT IN ('accepted', 'rejected') THEN
    RAISE EXCEPTION 'respond_to_challenge: p_response must be accepted or rejected, got %', p_response;
  END IF;

  v_player := get_player_id(auth.uid());
  IF v_player IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  -- The challenge row is the lock for the whole answer. Every concurrent
  -- responder queues here, so the recompute at the bottom always runs on a
  -- participant list nobody else is midway through changing.
  SELECT created_by, status INTO v_created_by, v_status
    FROM challenges WHERE id = p_challenge_id FOR UPDATE;

  IF v_created_by IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_found');
  END IF;
  IF v_created_by = v_player THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'own_challenge');
  END IF;
  -- A challenge that has been cancelled, has expired, or has already been
  -- rejected by somebody else takes no further answers. Checked under the lock
  -- so a cancel racing an accept resolves one way rather than both.
  IF v_status NOT IN ('proposed', 'partially_confirmed') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_open', 'status', v_status);
  END IF;

  SELECT confirmation_status INTO v_mine
    FROM challenge_participants
   WHERE challenge_id = p_challenge_id AND player_id = v_player;

  IF v_mine IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_participant');
  END IF;
  IF v_mine <> 'pending' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_responded');
  END IF;

  UPDATE challenge_participants
     SET confirmation_status = p_response::confirmation_status,
         responded_at = NOW()
   WHERE challenge_id = p_challenge_id AND player_id = v_player;

  -- ONE REJECTION ENDS IT, including in doubles — a partner declining means the
  -- matchup cannot go ahead as proposed. Otherwise the aggregate is read back
  -- from the rows as they now stand, which is the fix: the previous code
  -- computed it from a snapshot taken before its own write, so two simultaneous
  -- accepts each concluded the other was still pending.
  IF p_response = 'rejected' THEN
    v_new_status := 'rejected';
  ELSIF EXISTS (
    SELECT 1 FROM challenge_participants
     WHERE challenge_id = p_challenge_id AND confirmation_status = 'pending'
  ) THEN
    v_new_status := 'partially_confirmed';
  ELSE
    v_new_status := 'accepted';
  END IF;

  UPDATE challenges SET status = v_new_status, updated_at = NOW() WHERE id = p_challenge_id;

  RETURN jsonb_build_object(
    'ok', TRUE, 'status', v_new_status, 'created_by', v_created_by
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.respond_to_challenge(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.respond_to_challenge(UUID, TEXT) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
