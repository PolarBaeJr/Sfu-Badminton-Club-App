-- ============================================================
-- 00268: REPEAT CHALLENGES DIMINISH, AND ONE MATCH CAN BE BOOSTED
--
-- Two rating changes that ride the same applied delta, in one file because
-- both touch what a confirmed challenge writes into `ratings`.
--
-- NOTHING IS RECOMPUTED. Both halves act only on matches confirmed (or
-- boosted) after this file is applied. Every match already on the ladder keeps
-- the delta it was given; nothing in this repository rebuilds ratings, and
-- this file does not start.
--
-- ------------------------------------------------------------
-- 1. REPEAT CHALLENGES DIMINISH
-- ------------------------------------------------------------
-- THE GAP. repeat_opponent_caps (00048) stops a member creating more than two
-- rated challenges against the same opponent in seven days, and that is all it
-- does. Two a week is still eight or nine a month against a friend who is
-- happy to lose, and every one of them moves both ratings by a full delta. The
-- cap slows the farm; it does not make it pointless.
--
-- THE RULE. When a rated challenge is confirmed, count the OTHER confirmed
-- rated challenges between exactly the same players played within the window
-- of it. Each
-- earlier one cuts this match's rating change by repeat_decay_pct percent,
-- compounding, down to a floor:
--
--   factor = GREATEST(repeat_min_factor, (1 - repeat_decay_pct / 100) ^ prior)
--
-- At the defaults (25 percent, 30 days, 0.10) the factors run 1, .75, .5625,
-- .4219, .3164, .2373, .1780, .1335, .1001, then the floor. Thirty days rather than
-- seven because the cap already allows two a week: a seven-day window would
-- bite on one match in three and leave the farm where it was. The floor keeps
-- a genuine rivalry moving a little. repeat_decay_pct = 0 turns the rule off.
--
-- EITHER DIRECTION, AND THE SAME TEAMS. "The same players" means every
-- cross-side pair of this match is also a cross-side pair of the earlier one,
-- with the same number of players. So A challenging B and B challenging A are
-- the same rivalry, and in doubles the same two teams count whichever side
-- each stood on, while the same four players split differently do not.
--
-- THE WINDOW RUNS BOTH WAYS from this match's played_at, so the order in
-- which results are CONFIRMED cannot matter. played_at is stamped at submit
-- time and a pair chooses when to confirm: with a window that only looked
-- back, two pending results confirmed latest-played first would each find
-- the other outside it and both take a full delta. Looking both ways, the
-- second to confirm always sees the first.
--
-- ONLY CHALLENGES. Casual, walkover, tournament and admin-entered matches
-- neither get a factor nor count toward one. A walkover already carries its
-- own reduced weight (elo_weight_override), and an admin-entered result is an
-- officer's deliberate act.
--
-- WHY IT RIDES v_event_mult. The factor is one multiplier shared by every
-- participant, so it scales the whole delta symmetrically and conserves
-- exactly as the match did before. It is stored on the match as repeat_index
-- (1 for the first in the window) and repeat_factor, so the console can show
-- why a delta is small.
--
-- WHY THE COUNT RUNS AFTER THE RATINGS LOCK. Two confirmations of two
-- different matches between the same pair both need the same ratings rows, so
-- the second blocks on the lock until the first commits. Under READ COMMITTED
-- its next statement then sees the first match confirmed and counts it.
-- Counted before the lock, both would see zero and both would take a full
-- delta.
--
-- ------------------------------------------------------------
-- 2. THE BOOST
-- ------------------------------------------------------------
-- An exec can scale the rating change of ONE confirmed match by more than 1
-- and at most 2, for the genuinely hard match the formula undersells.
--
-- IT SCALES THE APPLIED DELTA, AFTER THE FACT. Each participant's elo moves by
-- ROUND(rating_delta * (boost - 1)), clamped to rating_bounds(), and the
-- amount that actually landed is added to rating_delta and post_rating.
-- Recomputing the match would mean re-reading pre_rating snapshots that other
-- matches have since moved past.
--
-- ONLY THE ELO COLUMN MOVES. apply_rating_delta also bumps about ten counters,
-- a streak and the provisional flag; a boost is not a second match, so none of
-- those change and it is written directly.
--
-- VOID STILL UNWINDS IT. Every reversal path subtracts rating_delta, and
-- rating_delta now carries the boost, so voiding or converting a boosted match
-- takes both players back to where they started.
--
-- One boost per match: the same value again is a no-op, a different one is
-- refused. Active season only, no walkovers, no tournament matches.
-- service_role only, with the actor passed in and the audit row written here
-- in the same transaction, the 00203 shape.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. COLUMNS
-- ============================================================
-- Nullable, and no foreign key: none of these names a player, so none of them
-- involves merge_players or the data export registry.
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS repeat_index  SMALLINT;
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS repeat_factor NUMERIC(5,4);
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS elo_boost     NUMERIC(3,2);

ALTER TABLE public.matches DROP CONSTRAINT IF EXISTS matches_repeat_index_check;
ALTER TABLE public.matches ADD CONSTRAINT matches_repeat_index_check
  CHECK (repeat_index IS NULL OR repeat_index >= 1);
-- Zero is allowed: a floor of 0 with a steep decay rounds to 0.0000, and a
-- CHECK that refused it would make the confirm raise instead of moving nothing.
ALTER TABLE public.matches DROP CONSTRAINT IF EXISTS matches_repeat_factor_check;
ALTER TABLE public.matches ADD CONSTRAINT matches_repeat_factor_check
  CHECK (repeat_factor IS NULL OR (repeat_factor >= 0 AND repeat_factor <= 1));
ALTER TABLE public.matches DROP CONSTRAINT IF EXISTS matches_elo_boost_check;
ALTER TABLE public.matches ADD CONSTRAINT matches_elo_boost_check
  CHECK (elo_boost IS NULL OR (elo_boost > 1 AND elo_boost <= 2));

-- ============================================================
-- 2. SETTINGS
-- ============================================================
-- Each key only where it is absent, so a re-run never overwrites a value an
-- officer has already chosen (the 00041/00048 pattern).
UPDATE platform_settings SET value = value || jsonb_build_object('repeat_decay_pct', 25)
 WHERE key = 'rating_defaults' AND NOT (value ? 'repeat_decay_pct');
UPDATE platform_settings SET value = value || jsonb_build_object('repeat_window_days', 30)
 WHERE key = 'rating_defaults' AND NOT (value ? 'repeat_window_days');
UPDATE platform_settings SET value = value || jsonb_build_object('repeat_min_factor', 0.10)
 WHERE key = 'rating_defaults' AND NOT (value ? 'repeat_min_factor');

-- ============================================================
-- 3. apply_match_result, RESTATED
-- ============================================================
-- 00230's body verbatim, plus the blocks marked ADDED BY 00268: four
-- declarations, the repeat count after the ratings lock, a ::text cast on the
-- apply_rating_delta call, and two columns on the final UPDATE. CREATE OR REPLACE keeps the live ACL
-- (postgres, authenticated, service_role), so no grant is restated; the verify
-- block below asserts it instead.

CREATE OR REPLACE FUNCTION public.apply_match_result(p_match_id uuid, p_confirmed_by uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_match RECORD;
  v_threshold INTEGER := rating_setting_int('provisional_threshold', 8);
  -- <<< 00127 >>> The switch. Read once per call, beside the threshold it
  -- qualifies, via 00053's section-aware helper: no new helper needed.
  v_provisional_k BOOLEAN := platform_setting_bool('rating_defaults', 'provisional_k_enabled', TRUE);
  v_participant RECORD;
  v_opponent_rating INTEGER;
  v_k_factor INTEGER;
  v_format_weight NUMERIC;
  v_event_mult NUMERIC;
  v_won BOOLEAN;
  v_new_rating INTEGER;
  v_delta INTEGER;
  v_applied JSONB;
  v_games_a INTEGER;
  v_games_b INTEGER;
  v_derived_winner team_side;
  -- ADDED BY 00268.
  v_repeat_pct    NUMERIC;
  v_repeat_window INTEGER;
  v_repeat_floor  NUMERIC;
  v_prior         INTEGER;
  v_repeat_index  SMALLINT;
  v_repeat_factor NUMERIC(5,4) := 1;
BEGIN
  -- Lock and fetch match
  SELECT * INTO v_match FROM matches WHERE id = p_match_id FOR UPDATE;
  IF v_match IS NULL THEN RAISE EXCEPTION 'Match not found'; END IF;
  IF v_match.result_status != 'pending_confirmation' THEN RAISE EXCEPTION 'Match not pending confirmation'; END IF;
  -- M6: block force-confirming a match you are not part of. SECURITY DEFINER
  -- keeps auth.uid() = the caller, so a legit participant confirm passes; the
  -- admin service-role (auth.uid() NULL) and admins bypass.
  IF auth.uid() IS NOT NULL
     AND NOT is_admin(auth.uid())
     AND get_player_id(auth.uid()) NOT IN (
       SELECT player_id FROM match_participants WHERE match_id = p_match_id)
  THEN RAISE EXCEPTION 'Only a participant can confirm this match'; END IF;
  -- The submitter must NOT confirm their own result: confirmation is the
  -- opponent's attestation. This also shuts the match-forgery path: fabricating
  -- a match + self-enrolling a victim requires being the submitter (mp_insert),
  -- and applying it requires confirming, so submitter=confirmer is blocked here.
  IF auth.uid() IS NOT NULL
     AND NOT is_admin(auth.uid())
     AND get_player_id(auth.uid()) = v_match.submitted_by
  THEN RAISE EXCEPTION 'The submitter cannot confirm their own result'; END IF;
  -- ADDED BY 00230. The same attestation rule on the axis the guard above
  -- cannot see: in doubles the submitter's PARTNER is a participant and is not
  -- the submitter, so without this one pair confirms its own result. See the
  -- section header for why the side is resolved by a join rather than a scalar.
  IF auth.uid() IS NOT NULL
     AND NOT is_admin(auth.uid())
     AND EXISTS (
       SELECT 1
         FROM match_participants mp_conf
         JOIN match_participants mp_sub
           ON mp_sub.match_id = mp_conf.match_id
          AND mp_sub.player_id = v_match.submitted_by
        WHERE mp_conf.match_id = p_match_id
          AND mp_conf.player_id = get_player_id(auth.uid())
          AND mp_conf.team_side = mp_sub.team_side)
  THEN RAISE EXCEPTION 'A team-mate of the submitter cannot confirm this result'; END IF;
  IF v_match.event_type = 'casual' THEN
    -- Casual matches: just confirm, no Elo changes
    UPDATE matches SET result_status = 'confirmed', confirmed_by = p_confirmed_by, updated_at = NOW() WHERE id = p_match_id;
    UPDATE challenges SET status = 'completed', updated_at = NOW() WHERE id = v_match.challenge_id;
    RETURN;
  END IF;

  IF v_match.walkover_type IS NOT NULL THEN
    -- Walkover matches have no games; winner_side is derived server-side
    -- by apply_walkover_result (opposite the forfeiting player).
    IF v_match.winner_side IS NULL THEN
      RAISE EXCEPTION 'No winner set for walkover match';
    END IF;
    v_derived_winner := v_match.winner_side;
  ELSE
    -- Derive the winner from the recorded games rather than trusting the
    -- client-supplied winner_side. Tied games count for neither side.
    SELECT
      COUNT(*) FILTER (WHERE side_a_score > side_b_score),
      COUNT(*) FILTER (WHERE side_b_score > side_a_score)
    INTO v_games_a, v_games_b
    FROM match_games
    WHERE match_id = p_match_id;

    IF COALESCE(v_games_a, 0) + COALESCE(v_games_b, 0) = 0 THEN
      RAISE EXCEPTION 'No decisive games recorded for match';
    END IF;
    IF v_games_a = v_games_b THEN
      RAISE EXCEPTION 'Games won are tied; cannot derive winner';
    END IF;

    v_derived_winner := CASE WHEN v_games_a > v_games_b THEN 'a'::team_side ELSE 'b'::team_side END;

    IF v_match.winner_side IS DISTINCT FROM v_derived_winner THEN
      RAISE EXCEPTION 'winner_side does not match game scores';
    END IF;
  END IF;

  -- The per-discipline column names this function used to build dynamic SQL
  -- from now live in apply_rating_delta, which owns the ratings write.

  v_format_weight := v_match.format_weight;
  -- elo_weight_override carries the reduced walkover weighting
  -- (0.50 withdrawal < 24h, 0.75 no-show); NULL for normal matches.
  v_event_mult := v_match.event_multiplier * COALESCE(v_match.elo_weight_override, 1.0);

  -- LOCK EVERY PARTICIPANT'S RATING ROW FIRST, in player_id order.
  --
  -- apply_rating_delta reads the live rating and adds to it, and that read is
  -- only safe against a concurrent confirmation of a DIFFERENT match involving
  -- the same player if it happens through a lock. The `matches` row lock taken
  -- at the top of this function serialises two confirmations of THIS match and
  -- nothing else. Ordered by player_id so two matches sharing two players
  -- cannot take the two locks in opposite orders and deadlock.
  PERFORM 1
    FROM ratings r
   WHERE r.player_id IN (
           SELECT mp.player_id FROM match_participants mp WHERE mp.match_id = p_match_id)
   ORDER BY r.player_id
     FOR UPDATE;

  -- ADDED BY 00268. REPEAT CHALLENGES DIMINISH. After the ratings lock above
  -- on purpose: a concurrent confirmation between the same players waits on
  -- that lock, and so sees the other match confirmed when it counts. See the
  -- file header for the rule and the defaults.
  IF v_match.event_type = 'rated_challenge'
     AND v_match.challenge_id IS NOT NULL
     AND v_match.walkover_type IS NULL THEN
    v_repeat_pct    := LEAST(100, GREATEST(0, platform_setting_numeric('rating_defaults', 'repeat_decay_pct', 25)));
    v_repeat_window := GREATEST(1, platform_setting_int('rating_defaults', 'repeat_window_days', 30));
    v_repeat_floor  := LEAST(1, GREATEST(0, platform_setting_numeric('rating_defaults', 'repeat_min_factor', 0.10)));

    SELECT COUNT(*) INTO v_prior
      FROM matches m2
     WHERE m2.id <> p_match_id
       AND m2.result_status = 'confirmed'
       AND m2.event_type = 'rated_challenge'
       AND m2.challenge_id IS NOT NULL
       AND m2.walkover_type IS NULL
       AND m2.match_type = v_match.match_type
       AND m2.played_at <= COALESCE(v_match.played_at, NOW()) + make_interval(days => v_repeat_window)
       AND m2.played_at >= COALESCE(v_match.played_at, NOW()) - make_interval(days => v_repeat_window)
       AND (SELECT COUNT(*) FROM match_participants x WHERE x.match_id = m2.id)
         = (SELECT COUNT(*) FROM match_participants y WHERE y.match_id = p_match_id)
       AND NOT EXISTS (
             SELECT 1
               FROM match_participants a
               JOIN match_participants b
                 ON b.match_id = a.match_id AND b.team_side <> a.team_side
              WHERE a.match_id = p_match_id
                AND NOT EXISTS (
                      SELECT 1
                        FROM match_participants a2
                        JOIN match_participants b2
                          ON b2.match_id = a2.match_id AND b2.team_side <> a2.team_side
                       WHERE a2.match_id = m2.id
                         AND a2.player_id = a.player_id
                         AND b2.player_id = b.player_id));

    v_repeat_index  := v_prior + 1;
    v_repeat_factor := ROUND(GREATEST(v_repeat_floor, POWER(1 - v_repeat_pct / 100.0, v_prior)), 4);
    v_event_mult    := v_event_mult * v_repeat_factor;
  END IF;

  -- Process each participant
  FOR v_participant IN
    SELECT mp.*, r.singles_elo, r.doubles_elo, r.singles_provisional, r.doubles_provisional,
           r.singles_matches_played, r.doubles_matches_played
    FROM match_participants mp
    JOIN ratings r ON r.player_id = mp.player_id
    WHERE mp.match_id = p_match_id
  LOOP
    v_won := (v_participant.team_side = v_derived_winner);

    -- Get opponent average rating from the PRE-match snapshot
    -- (match_participants.pre_rating), NOT the live ratings table.
    -- Reading live ratings here is order-dependent: this loop writes
    -- each participant's new rating in-place, so whichever participant
    -- is processed second would see the opponent's ALREADY-UPDATED
    -- rating, producing asymmetric deltas (e.g. winner +20 / loser -19).
    -- pre_rating already encodes the correct field (singles_elo vs
    -- doubles_elo) chosen at participant-insert time by match_type, so
    -- no match_type branch is needed. Singles: the other player's
    -- pre_rating; doubles: AVG of the two opposing players' pre_ratings.
    SELECT AVG(mp2.pre_rating)
    INTO v_opponent_rating
    FROM match_participants mp2
    WHERE mp2.match_id = p_match_id AND mp2.team_side != v_participant.team_side;

    -- K-factor
    --
    -- <<< 00127 >>> `v_provisional_k AND (...)` is the ONLY change to this
    -- function. With the switch on (the default, and every club's behaviour
    -- before 00127) the condition is exactly what it always was. With it off,
    -- every player takes the established K regardless of how few matches they
    -- have played. The provisional FLAGS are still maintained by the UPDATE
    -- below: see the header for why.
    IF v_match.match_type = 'singles' THEN
      v_k_factor := CASE WHEN v_provisional_k AND (v_participant.singles_provisional OR v_participant.singles_matches_played < v_threshold)
                         THEN rating_setting_int('singles_k_provisional', 80)
                         ELSE rating_setting_int('singles_k_established', 48) END;
    ELSE
      v_k_factor := CASE WHEN v_provisional_k AND (v_participant.doubles_provisional OR v_participant.doubles_matches_played < v_threshold)
                         THEN rating_setting_int('doubles_k_provisional', 64)
                         ELSE rating_setting_int('doubles_k_established', 36) END;
    END IF;

    -- Calculate Elo delta
    SELECT cu.new_rating, cu.delta INTO v_new_rating, v_delta
    FROM calculate_elo_update(v_participant.pre_rating, v_opponent_rating, v_k_factor, v_format_weight, v_event_mult, v_won,
                              get_margin_multiplier(v_participant.games_won, v_participant.games_lost)) cu;

    -- A DELTA, NOT AN ABSOLUTE. This is the bug 00082 fixed for the
    -- tournament ladder and explicitly left open here.
    --
    -- calculate_elo_update above derives v_new_rating from
    -- match_participants.pre_rating, a snapshot taken when the result was
    -- SUBMITTED. Writing that absolute back into ratings erases anything that
    -- moved the player between submission and confirmation: a tournament
    -- result, another challenge, an exec correction. The player is silently
    -- rolled back to a rating that was current at submission time, and the
    -- other match's own snapshot still claims its delta was applied, so
    -- reversing THAT match later subtracts a delta from a number it was never
    -- added to.
    --
    -- Deltas commute; absolutes do not. apply_rating_delta re-reads the
    -- current rating through the lock taken above, adds v_delta, and clamps.
    -- pre_rating stays the basis of the ARITHMETIC (it has to: the opponent
    -- average is a pre-match snapshot too, and rating both sides off live
    -- values would make the loop order-dependent and the deltas asymmetric).
    -- Only the WRITE changes.
    -- ADDED BY 00268: the ::text. match_type is match_type_enum and
    -- apply_rating_delta takes text; an enum has no implicit cast to text, so
    -- every rated challenge confirm has failed to resolve this call.
    v_applied := apply_rating_delta(
      v_participant.player_id, v_match.match_type::text, v_delta, v_won,
      v_participant.points_scored, v_participant.points_allowed,
      v_participant.games_won, v_participant.games_lost);

    -- What actually landed, which differs from what was asked for whenever the
    -- clamp absorbed part of it. Every reversal path subtracts rating_delta, so
    -- recording the request instead would walk a clamped player past where they
    -- started each time a result was corrected.
    v_new_rating := (v_applied->>'new_elo')::INTEGER;
    v_delta      := (v_applied->>'applied_delta')::INTEGER;

    UPDATE match_participants SET
      post_rating = v_new_rating,
      rating_delta = v_delta,
      win_flag = v_won
    WHERE id = v_participant.id;

    -- Update reliability
    UPDATE reliability_metrics SET
      matches_completed = matches_completed + 1,
      updated_at = NOW()
    WHERE player_id = v_participant.player_id;
  END LOOP;

  -- Update match status
  UPDATE matches SET
    result_status = 'confirmed',
    confirmed_by = p_confirmed_by,
    completed_flag = TRUE,
    -- ADDED BY 00268. NULL on every match the rule does not apply to.
    repeat_index = v_repeat_index,
    repeat_factor = CASE WHEN v_repeat_index IS NULL THEN NULL ELSE v_repeat_factor END,
    updated_at = NOW()
  WHERE id = p_match_id;

  -- Update challenge status
  UPDATE challenges SET status = 'completed', updated_at = NOW() WHERE id = v_match.challenge_id;

  -- NOTE: head_to_head_stats is intentionally NOT updated here.
  -- The UPDATE ... SET result_status = 'confirmed' above fires the
  -- on_match_confirmed AFTER UPDATE trigger (00004_triggers.sql), which
  -- is the single owner of both update_head_to_head() and
  -- update_partnership_stats(). Every confirmation path that applies Elo
  -- (normal player confirm, apply_walkover_result, adminCreateMatch,
  -- resolveDispute accepted/edited) routes through this function and
  -- therefore through that UPDATE, so the trigger fires exactly once per
  -- confirmed rated match. Calling update_head_to_head() explicitly here
  -- as well would double-count every match (partnership_stats is already
  -- trigger-only and correct; this keeps h2h consistent with it).

  -- Audit
  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, reason)
  VALUES (p_confirmed_by, 'match_confirmed', 'match', p_match_id, 'Match result confirmed and Elo applied');
END;
$function$;


-- ============================================================
-- 4. boost_match_rating
-- ============================================================
-- The authorisation boundary is the console action (matches.void.write), as
-- it is for void_club_match: this takes the actor as a parameter and trusts
-- it, which is exactly why no role but service_role may call it.
CREATE OR REPLACE FUNCTION public.boost_match_rating(
  p_match_id uuid,
  p_actor_id uuid,
  p_boost    numeric,
  p_reason   text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_match   matches;
  v_active  BOOLEAN;
  v_p       RECORD;
  v_lo      INTEGER;
  v_hi      INTEGER;
  v_old     INTEGER;
  v_new     INTEGER;
  v_extra   INTEGER;
  v_applied INTEGER;
  v_before  JSONB := '[]'::jsonb;
  v_after   JSONB := '[]'::jsonb;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'An actor is required';
  END IF;
  IF p_boost IS NULL OR p_boost <= 1 OR p_boost > 2 OR p_boost <> ROUND(p_boost, 2) THEN
    RAISE EXCEPTION 'A boost must be above 1 and at most 2, to two decimals, got %', p_boost;
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'A reason of at least 5 characters is required';
  END IF;

  SELECT * INTO v_match FROM matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Match not found';
  END IF;

  -- The same boost again is a retry, not a second boost: a double click or a
  -- resubmitted form must not multiply the change twice.
  IF v_match.elo_boost IS NOT NULL THEN
    IF v_match.elo_boost = p_boost THEN
      RETURN jsonb_build_object('applied', FALSE, 'already_boosted', TRUE);
    END IF;
    RAISE EXCEPTION 'This match is already boosted by %', v_match.elo_boost;
  END IF;

  IF v_match.result_status <> 'confirmed' THEN
    RAISE EXCEPTION 'Only a confirmed match can be boosted';
  END IF;
  IF v_match.event_type = 'casual' OR NOT v_match.rated_flag THEN
    RAISE EXCEPTION 'A casual or unrated match has no rating change to boost';
  END IF;
  IF v_match.walkover_type IS NOT NULL THEN
    RAISE EXCEPTION 'A walkover cannot be boosted';
  END IF;
  IF v_match.tournament_id IS NOT NULL THEN
    RAISE EXCEPTION 'A tournament match cannot be boosted here';
  END IF;
  SELECT s.active_flag INTO v_active FROM seasons s WHERE s.id = v_match.season_id;
  IF NOT COALESCE(v_active, FALSE) THEN
    RAISE EXCEPTION 'Only a match in the active season can be boosted';
  END IF;

  SELECT lo, hi INTO v_lo, v_hi FROM rating_bounds();

  -- Same lock order as apply_match_result, so a boost and a confirmation that
  -- share players cannot deadlock.
  PERFORM 1
    FROM ratings r
   WHERE r.player_id IN (
           SELECT mp.player_id FROM match_participants mp WHERE mp.match_id = p_match_id)
   ORDER BY r.player_id
     FOR UPDATE;

  FOR v_p IN
    SELECT mp.id, mp.player_id, mp.pre_rating, mp.post_rating, mp.rating_delta
      FROM match_participants mp
     WHERE mp.match_id = p_match_id
       AND mp.rating_delta IS NOT NULL
     ORDER BY mp.player_id
  LOOP
    v_extra := ROUND(v_p.rating_delta * (p_boost - 1))::INTEGER;

    IF v_match.match_type = 'singles' THEN
      SELECT singles_elo INTO v_old FROM ratings WHERE player_id = v_p.player_id;
    ELSE
      SELECT doubles_elo INTO v_old FROM ratings WHERE player_id = v_p.player_id;
    END IF;
    IF v_old IS NULL THEN
      RAISE EXCEPTION 'No ratings row for player %', v_p.player_id;
    END IF;

    -- What lands, not what was asked for: the clamp can absorb part of it, and
    -- every reversal subtracts rating_delta, so recording the request would
    -- walk a clamped player past where they started when the match is voided.
    v_new     := LEAST(GREATEST(v_old + v_extra, v_lo), v_hi);
    v_applied := v_new - v_old;

    IF v_match.match_type = 'singles' THEN
      UPDATE ratings SET singles_elo = v_new, updated_at = NOW() WHERE player_id = v_p.player_id;
    ELSE
      UPDATE ratings SET doubles_elo = v_new, updated_at = NOW() WHERE player_id = v_p.player_id;
    END IF;

    UPDATE match_participants
       SET rating_delta = v_p.rating_delta + v_applied,
           post_rating  = COALESCE(v_p.post_rating, v_p.pre_rating) + v_applied
     WHERE id = v_p.id;

    v_before := v_before || jsonb_build_object(
      'player_id', v_p.player_id, 'rating_delta', v_p.rating_delta, 'elo', v_old);
    v_after  := v_after || jsonb_build_object(
      'player_id', v_p.player_id, 'rating_delta', v_p.rating_delta + v_applied,
      'elo', v_new, 'applied', v_applied);
  END LOOP;

  -- result_status is not touched, so on_match_confirmed does not fire again.
  UPDATE matches SET elo_boost = p_boost, updated_at = NOW() WHERE id = p_match_id;

  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, old_value, new_value, reason)
  VALUES (p_actor_id, 'match_rating_boosted', 'match', p_match_id,
          jsonb_build_object('elo_boost', NULL, 'participants', v_before),
          jsonb_build_object('elo_boost', p_boost, 'repeat_factor', v_match.repeat_factor,
                             'participants', v_after),
          btrim(p_reason));

  RETURN jsonb_build_object('applied', TRUE, 'already_boosted', FALSE, 'participants', v_after);
END;
$function$;

REVOKE ALL ON FUNCTION public.boost_match_rating(uuid, uuid, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.boost_match_rating(uuid, uuid, numeric, text) TO service_role;

-- ============================================================
-- 5. VERIFY
-- ============================================================
DO $verify$
DECLARE
  v_src TEXT;
  v_row JSONB;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.apply_match_result(uuid, uuid)'::regprocedure;
  IF position('v_event_mult    := v_event_mult * v_repeat_factor' IN v_src) = 0 THEN
    RAISE EXCEPTION '00268: apply_match_result lacks the repeat block';
  END IF;
  IF position('A team-mate of the submitter cannot confirm this result' IN v_src) = 0 THEN
    RAISE EXCEPTION '00268: the 00230 team-mate guard was lost in the restatement';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.apply_match_result(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '00268: members lost the confirm RPC';
  END IF;
  IF has_function_privilege('anon', 'public.apply_match_result(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '00268: anon can confirm matches';
  END IF;
  IF has_function_privilege('authenticated', 'public.boost_match_rating(uuid, uuid, numeric, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.boost_match_rating(uuid, uuid, numeric, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '00268: boost_match_rating is callable beyond service_role';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.boost_match_rating(uuid, uuid, numeric, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '00268: service_role cannot boost';
  END IF;
  IF has_column_privilege('authenticated', 'public.matches', 'elo_boost', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.matches', 'repeat_factor', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.matches', 'repeat_index', 'UPDATE') THEN
    RAISE EXCEPTION '00268: members can write the new match columns';
  END IF;
  SELECT value INTO v_row FROM platform_settings WHERE key = 'rating_defaults';
  IF v_row IS NOT NULL
     AND NOT (v_row ? 'repeat_decay_pct' AND v_row ? 'repeat_window_days' AND v_row ? 'repeat_min_factor') THEN
    RAISE EXCEPTION '00268: rating_defaults is missing a repeat key';
  END IF;
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
