-- ============================================================
-- 00184 — a walkover is reported once, and answered once
--
-- Audit F-009. Two multi-step writes with no transaction around either.
--
-- REPORTING. reportWalkover checks the challenge status, checks that no match
-- result already exists, checks the reporter and the forfeiting player are on
-- the right sides — and then does two writes with two different clients:
-- INSERT INTO walkovers, then UPDATE challenges SET status='walkover_pending'.
-- If the second fails, the walkover exists and the challenge still reads
-- 'accepted', which means the member can file the same forfeit again and the
-- /walkovers queue shows an exec two rows for one match. If the request is
-- simply retried — a double-tap, a Next.js action replay — the same thing
-- happens with both writes succeeding twice.
--
-- Every one of the checks is also a read taken some milliseconds before the
-- insert. The sharpest is the existing-match check: a result submitted in that
-- window is buried under a walkover, which the code's own comment says is the
-- thing it exists to prevent.
--
-- ANSWERING. rejectWalkover reads the walkover, updates it to 'rejected'
-- unconditionally, and then reopens the challenge to 'accepted'. There is no
-- test that the walkover was still pending, so two execs clicking Reject both
-- succeed, and an exec rejecting one that a colleague confirmed a moment ago
-- reopens a challenge whose match has already been played and rated. The read
-- discards its error too, so a failed read reopens nothing and says nothing.
--
-- THE INDEX IS THE PART THAT CANNOT BE ARGUED WITH. Functions can be bypassed
-- and retries can arrive from anywhere; a partial unique index means the second
-- pending walkover for a challenge does not exist, whoever asks for it.
-- Confirmed and rejected rows are deliberately outside it — a rejected forfeit
-- SHOULD be re-reportable, and the history is worth keeping.
--
-- (apply_walkover_result, the confirm side, is already one SECURITY DEFINER
-- function and is left alone — 00118 explains at length why its ~150-line body
-- is not casually rewritten.)
-- ============================================================

BEGIN;

-- Verified empty on staging before writing this (0 walkovers, 0 duplicates), so
-- the index cannot fail on existing data. If it ever does on another database,
-- the duplicates are the bug and want resolving by hand, not by widening this.
CREATE UNIQUE INDEX IF NOT EXISTS walkovers_one_pending_per_challenge
  ON public.walkovers (challenge_id)
  WHERE status = 'pending';

-- ------------------------------------------------------------
-- report_walkover_atomic
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.report_walkover_atomic(
  p_challenge_id       UUID,
  p_forfeit_player_id  UUID,
  p_walkover_type      TEXT,
  p_notice_hours       INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_reporter        UUID;
  v_status          challenge_status;
  v_reporter_side   team_side;
  v_forfeit_side    team_side;
  v_existing_result TEXT;
  v_walkover        UUID;
BEGIN
  IF p_walkover_type NOT IN ('withdrawal', 'no_show') THEN
    RAISE EXCEPTION 'report_walkover_atomic: p_walkover_type must be withdrawal or no_show, got %', p_walkover_type;
  END IF;

  v_reporter := get_player_id(auth.uid());
  IF v_reporter IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  -- The challenge row is the lock for everything below, so the status, the
  -- absence of a result and the participant sides are all read from a state
  -- nobody else can move until this commits.
  SELECT status INTO v_status FROM challenges WHERE id = p_challenge_id FOR UPDATE;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_found');
  END IF;
  IF v_status NOT IN ('accepted', 'partially_confirmed') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_forfeitable', 'status', v_status);
  END IF;

  -- A challenge keeps status 'accepted' while a submitted result waits to be
  -- confirmed, so the status check above passes and a walkover could be filed
  -- on a match that had already been played and reported — burying the pending
  -- result. Someone who disagrees with a submitted result has the dispute flow;
  -- forfeiting is for a match that did not happen.
  SELECT result_status::TEXT INTO v_existing_result
    FROM matches WHERE challenge_id = p_challenge_id LIMIT 1;
  IF v_existing_result IS NOT NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'result_exists', 'result_status', v_existing_result);
  END IF;

  SELECT team_side INTO v_reporter_side
    FROM challenge_participants WHERE challenge_id = p_challenge_id AND player_id = v_reporter;
  IF v_reporter_side IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_participant');
  END IF;

  SELECT team_side INTO v_forfeit_side
    FROM challenge_participants WHERE challenge_id = p_challenge_id AND player_id = p_forfeit_player_id;
  IF v_forfeit_side IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'forfeit_not_in_challenge');
  END IF;

  -- For a withdrawal the reporter forfeits (their team); for a no-show the
  -- reporter accuses the opposing team. Either way the forfeiting player must
  -- be on the opposite side from whoever is staying in the match.
  IF p_walkover_type = 'withdrawal' AND v_forfeit_side <> v_reporter_side THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'withdrawal_wrong_side');
  END IF;
  IF p_walkover_type = 'no_show' AND v_forfeit_side = v_reporter_side THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'no_show_wrong_side');
  END IF;

  -- The index is what actually decides this; catching it here turns a retry
  -- into a sentence rather than a 500. Nothing is rolled back by taking this
  -- branch because the INSERT is the first write in the function.
  BEGIN
    INSERT INTO walkovers (challenge_id, reported_by, forfeit_player_id, walkover_type, notice_hours)
    VALUES (p_challenge_id, v_reporter, p_forfeit_player_id, p_walkover_type::walkover_type, p_notice_hours)
    RETURNING id INTO v_walkover;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_reported');
  END;

  UPDATE challenges SET status = 'walkover_pending', updated_at = NOW() WHERE id = p_challenge_id;

  RETURN jsonb_build_object('ok', TRUE, 'walkover_id', v_walkover);
END;
$function$;

REVOKE ALL ON FUNCTION public.report_walkover_atomic(UUID, UUID, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_walkover_atomic(UUID, UUID, TEXT, INTEGER) TO authenticated, service_role;

-- ------------------------------------------------------------
-- reject_walkover_atomic
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_walkover_atomic(
  p_walkover_id UUID,
  p_admin_id    UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_challenge UUID;
  v_status    walkover_status;
BEGIN
  SELECT challenge_id, status INTO v_challenge, v_status
    FROM walkovers WHERE id = p_walkover_id FOR UPDATE;

  IF v_challenge IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_found');
  END IF;
  -- The compare-and-swap. Two execs clicking Reject, or one rejecting a
  -- walkover a colleague confirmed a moment ago, both stop here — the second
  -- one used to reopen a challenge whose match had already been rated.
  IF v_status <> 'pending' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_settled', 'status', v_status);
  END IF;

  UPDATE walkovers
     SET status = 'rejected',
         admin_confirmed_by = p_admin_id,
         admin_confirmed_at = NOW(),
         updated_at = NOW()
   WHERE id = p_walkover_id;

  -- Reopen the challenge, but only from the state the walkover put it in. If
  -- something else moved it on in the meantime, leave it alone rather than drag
  -- it back to 'accepted'.
  UPDATE challenges
     SET status = 'accepted', updated_at = NOW()
   WHERE id = v_challenge AND status = 'walkover_pending';

  RETURN jsonb_build_object('ok', TRUE, 'challenge_id', v_challenge);
END;
$function$;

-- Admin-only, and it takes the acting admin as a parameter, so it stays off
-- `authenticated` entirely — the console calls it with the service key after
-- requireCapability('walkovers.reject.write').
REVOKE ALL ON FUNCTION public.reject_walkover_atomic(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reject_walkover_atomic(UUID, UUID) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
