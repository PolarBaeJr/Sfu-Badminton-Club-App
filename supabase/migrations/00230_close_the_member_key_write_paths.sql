-- ============================================================
-- 00230: CLOSE THE MEMBER-KEY WRITE PATHS
--
-- APPLY AFTER 00229. Nothing here depends on it; the ordering is only so that
-- schema_migrations stays a straight line.
--
-- ------------------------------------------------------------
-- WHAT THIS IS
-- ------------------------------------------------------------
-- Five closures and one honest refusal, all of the same shape: a table or a
-- function that `authenticated` can reach with the browser key, whose RLS
-- policy pins ONE column and therefore decides less than it looks like it
-- decides. A policy that checks `created_by = self` authorises the ROW, never
-- the COLUMNS, and every gap below is the distance between those two things.
--
--   1. challenges          a member could rewrite every column of their own
--                          challenge, including the Elo stake
--   2. three INSERT grants  a member could enrol themselves in somebody else's
--                          challenge, walkover or dispute
--   3. respond_to_challenge accepted a challenge from a banned or suspended
--                          account
--   4. apply_match_result   a doubles partner could confirm their own team's
--                          result
--   5. is_admin_or_coach    executable by `anon` for no reason left standing
--   6. self-approval        NOT CLOSED HERE, and section 6 says why at length
--
-- ------------------------------------------------------------
-- ON THE CARRIED-FORWARD COMMENTS
-- ------------------------------------------------------------
-- Sections 3 and 4 restate two function bodies in full, because CREATE OR
-- REPLACE drops any attribute it does not name and both are SECURITY DEFINER
-- with a pinned search_path. The bodies were read off PRODUCTION rather than
-- off the migration files and diffed against them: live `respond_to_challenge`
-- is byte-identical to 00183:138-223 and live `apply_match_result` is
-- byte-identical to 00177:66-291, so the files are the live truth and each
-- section below is that text plus exactly the guard it advertises.
--
-- The one difference: em dashes in the carried comments are recast as colons or
-- full stops, per house rule. No code changed, only punctuation inside
-- comments. Somebody diffing prosrc against 00177 or 00183 will see those
-- recasts alongside the new guard; they are not an edit to the logic.
--
-- ------------------------------------------------------------
-- AN ACCEPTED RESIDUAL, RECORDED RATHER THAN FIXED
-- ------------------------------------------------------------
-- session_checkin_open() does not read sessions.require_scan_to_check_in, so a
-- member posting straight at PostgREST with their own key can check in to a
-- scan-only session without presenting a token. That is left exactly as it is,
-- and it is a decision rather than an oversight.
--
-- performCheckIn (apps/player/src/lib/actions/sessions.ts:66-131) is SHARED.
-- Both the tokenless path and checkInWithTokenImpl (:146-171) call it, and both
-- insert through the same attendance_insert policy, whose gate is
-- session_checkin_open(). The insert carries no evidence of how the member got
-- there. So a scan requirement enforced inside session_checkin_open() could not
-- tell a scan from a tap and would refuse BOTH: it would close the QR path on
-- precisely the sessions the QR exists for, which is the opposite of the
-- policy's intent.
--
-- 00116 states this in its own header and chose the app layer deliberately:
-- "It is enforced in the server action, not in RLS ... a policy predicate could
-- not tell a scan from a tap and would have to refuse both." Closing it needs
-- the token to become visible to the insert (an attendance column, or a
-- SECURITY DEFINER check-in RPC that takes the token), which is a schema and
-- app change, not a predicate. Out of scope for a security batch; written down
-- here so the next reader finds a decision instead of a hole.
-- ============================================================


-- ============================================================
-- 1. A MEMBER MAY CANCEL THEIR CHALLENGE, NOT REWRITE IT
-- ============================================================
--
-- THE GAP. `challenges` carries relacl `authenticated=arwdm`, and the only
-- member-facing write policy is challenges_update_own (00005_rls.sql:133-135):
--
--     USING       (created_by = get_player_id(auth.uid()))
--     WITH CHECK  (created_by = get_player_id(auth.uid()))
--
-- Both halves name one column. The policy therefore says "this is your row" and
-- says NOTHING about which columns of it you may move. With the table grant in
-- hand that is a PATCH away from rewriting every column of a challenge you
-- created, at any point in its life.
--
-- WHY IT IS THE ELO STAKE AND NOT A COSMETIC EDIT. submit_match_result copies
-- v_challenge.event_type and v_challenge.rated_flag into the match it creates
-- (00003:539-542, carried through 00053:367 and 00125:485-488). apply_match_result
-- then branches on the match's event_type: 'casual' confirms with no rating
-- movement at all, and get_event_multiplier scales the delta by event, with a
-- tournament worth 1.15x. So a member who flips those two columns on their own
-- challenge JUST BEFORE reporting the score chooses the stake after the fact:
-- casual to erase a loss, tournament to inflate a win. create_challenge_atomic
-- derives event_type from rated_flag precisely so the two cannot disagree
-- (00183:99-101), and an unguarded UPDATE walks around that derivation.
--
-- WHAT STAYS. The UPDATE grant and challenges_update_own are BOTH load-bearing
-- and both keep working. cancelChallengeImpl
-- (apps/player/src/lib/actions/challenges.ts:248-306) cancels with the member's
-- OWN session client, as a compare-and-swap on status, and that is the only
-- write to `challenges` the player app makes with a member key: verified by
-- grep, the other three call sites are selects. Revoking the grant would break
-- cancel; this guards the columns instead and leaves the row rule alone.

CREATE OR REPLACE FUNCTION public.guard_challenge_member_columns()
RETURNS trigger
LANGUAGE plpgsql
-- NOT SECURITY DEFINER, and the omission is load-bearing. 00220's header gives
-- the rule for the guard beside it: a guard whose first branch tests
-- current_user must not be definer, because an owner-resolved current_user
-- returns early for EVERY caller and the trigger never fires once, with every
-- gate green. Same first branch here, same requirement.
SET search_path TO 'public'
AS $function$
BEGIN
  -- THE EARLY RETURN IS DELIBERATELY *NOT* THE PLAYERS GUARD'S.
  --
  -- guard_player_privileged_columns (00225:143-146) reads
  --     IF (current_user = 'service_role' OR current_user NOT IN ('anon','authenticated'))
  --        AND auth.uid() IS NULL THEN
  -- and that `AND auth.uid() IS NULL` conjunct MUST NOT be copied here.
  --
  -- Inside a member-invoked SECURITY DEFINER function, current_user is the
  -- function's owner while auth.uid() is still the member's id: the JWT claim
  -- does not stop being set just because the executing role changed. So the
  -- players form would fail its own first branch and fall through to the
  -- column check for every write made on a member's behalf by an owner-owned
  -- function. Every legitimate status write to `challenges` is exactly that:
  --
  --     respond_to_challenge     00183:214  accept / reject
  --     apply_match_result       00177:113 and :267  status -> completed
  --     report_walkover_atomic   00184:134  status -> walkover_pending
  --
  -- plus reject_walkover_atomic, apply_walkover_result and merge_players. All
  -- six were confirmed SECURITY DEFINER on production, so current_user resolves
  -- to the owner for all six and this branch returns before the check. Copying
  -- 00225 verbatim would have started raising inside the three member-callable
  -- ones the moment a member answered a challenge.
  --
  -- The players guard needs its extra conjunct because `anon` also has a NULL
  -- auth.uid(); here `anon` holds no UPDATE on this table at all, so the
  -- current_user test alone is the whole question.
  IF current_user NOT IN ('anon', 'authenticated') THEN RETURN NEW; END IF;

  -- An admin editing a challenge from a browser key.
  IF public.is_admin(auth.uid()) THEN RETURN NEW; END IF;

  -- A CANCEL, AND NOTHING ELSE.
  --
  -- THE COMPARISON IS A JSONB DIFFERENCE, NOT A COLUMN LIST, AND THAT IS THE
  -- POINT. A list of the columns a member may not touch is a list somebody has
  -- to remember to extend: `challenges` has 16 columns today and the next one
  -- added is unguarded by default, silently, exactly the way 00225 describes
  -- the players guard needing an answer for every new column. Subtracting the
  -- two keys a cancel is allowed to move and demanding the REST be identical
  -- inverts that default: a column added tomorrow is closed the moment it
  -- exists, and opening it is a deliberate edit to this line.
  --
  -- `status` is subtracted because a cancel is a status change. `updated_at` is
  -- subtracted because the row's own bookkeeping moves with it.
  IF NOT (
    to_jsonb(NEW) - 'status' - 'updated_at' = to_jsonb(OLD) - 'status' - 'updated_at'
    AND OLD.status IN ('proposed', 'partially_confirmed')
    AND NEW.status = 'cancelled'
  ) THEN
    RAISE EXCEPTION 'Not authorized to modify this challenge';
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.guard_challenge_member_columns() IS
  'A member holding UPDATE on challenges via challenges_update_own may only cancel a proposed or partially_confirmed challenge. Every other column is compared by jsonb difference so a future column is closed by default. Owner-owned SECURITY DEFINER writers return early on current_user; see 00230.';

-- THE NAME IS CHOSEN TO SORT FIRST, and that is why comparing updated_at above
-- is safe. PostgreSQL fires BEFORE row triggers in alphabetical order by
-- trigger name, and `challenges` already carries `set_updated_at` from
-- 00004_triggers.sql:24 (confirmed live: BEFORE ... FOR EACH ROW). 'g' sorts
-- before 's', so this guard sees NEW.updated_at exactly as the STATEMENT left
-- it, before trigger_set_updated_at() stamps NOW() over it. Renamed to sort
-- after, the guard would compare a value another trigger had just changed and
-- would refuse every cancel. The jsonb difference excludes the column anyway,
-- so this is belt and braces rather than the only thing holding it up.
DROP TRIGGER IF EXISTS guard_challenge_member_columns_trg ON public.challenges;
CREATE TRIGGER guard_challenge_member_columns_trg
  BEFORE UPDATE ON public.challenges
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_challenge_member_columns();

-- A trigger function is invoked by the trigger machinery, not by the caller, so
-- nobody needs EXECUTE on it and PUBLIC/anon/authenticated holding it is a call
-- surface with no reason to exist. All three named, for the 00126/00187 reason:
-- Supabase's default privileges create EXPLICIT anon and authenticated entries
-- that a REVOKE FROM PUBLIC does not touch.
REVOKE ALL ON FUNCTION public.guard_challenge_member_columns() FROM PUBLIC, anon, authenticated;


-- ============================================================
-- 2. NOBODY ENROLS THEMSELVES IN SOMEBODY ELSE'S MATCH
-- ============================================================
--
-- THE GAP, three times over. Each of these INSERT policies pins the caller's
-- own id column and nothing else:
--
--     cp_insert        00005:147-150   player_id = self OR is_admin(...)
--     walkovers_insert 00005:229-230   reported_by = self
--     disputes_insert  00005:261-262   opened_by = self
--
-- None of them says anything about the challenge_id, match_id or challenge the
-- row attaches to. So a member who learns an id: from a shared link, from the
-- feed, from challenge_participants which every authenticated user may SELECT
-- (cp_select is `USING (TRUE)`): can insert THEMSELVES into a challenge or a
-- match they were never part of. The row passes the policy because the one
-- column the policy checks is honestly their own id. That is not a nuisance:
-- match_participants and challenge_participants are what apply_match_result
-- loops over to move ratings, so a self-inserted row shifts BOTH players' Elo.
--
-- WHY A REVOKE COSTS NOTHING. Every legitimate creation path is already a
-- SECURITY DEFINER function that executes as the owner and therefore needs no
-- grant on the caller's side:
--
--     create_challenge_atomic   00183:108-121  enrols all participants
--     respond_to_challenge      00183:193      answers as a participant
--     submit_match_result                      creates match + participants
--     report_walkover_atomic    00184:127-129  inserts the walkover
--     dispute_match_result                     opens the dispute
--
-- and the admin console inserts with the service role, which is unaffected by a
-- revoke on `authenticated`: apps/admin/src/lib/actions/matches.ts:622 is the
-- only INSERT into any of the three anywhere in the repo and it runs on
-- adminClient. Grepped across apps/, packages/ and scripts/: no session-client
-- insert into any of the three tables exists.
--
-- THE POLICIES ARE LEFT IN PLACE for a smaller diff and because a policy
-- without a grant refuses just as firmly: the grant is the outer gate and it is
-- now shut. One consequence worth naming rather than leaving to be discovered:
-- cp_insert's `OR is_admin(auth.uid())` arm is now UNREACHABLE for
-- `authenticated`, by design. An admin on a browser key can no longer insert a
-- participant row directly, and nothing asks them to: the console's path is
-- the service role.

REVOKE INSERT ON public.challenge_participants FROM authenticated;
REVOKE INSERT ON public.walkovers FROM authenticated;
REVOKE INSERT ON public.disputes FROM authenticated;


-- ============================================================
-- 3. A SUSPENDED ACCOUNT CANNOT ACCEPT A CHALLENGE
-- ============================================================
--
-- THE ASYMMETRY. validate_challenge_creation checks the eligibility of the
-- creator, the opponent AND both doubles partners before a challenge may be
-- created (00025:62-83 and :119-146). respond_to_challenge checks that the
-- responder is authenticated, is not the creator and holds a pending
-- participant row, and checks NOTHING about their standing. So a member
-- suspended, banned or deactivated AFTER a challenge was proposed to them can
-- still accept it, and the accepted challenge goes on to produce a rated match.
-- The gate at creation is worth less than it looks if the answer is ungated.
--
-- THE PREDICATE IS THE ONE ALREADY CANONICAL IN THIS SCHEMA, copied in shape
-- from 00025:78-83 rather than invented: a missing row (NULL status) is
-- ineligible, and the IS DISTINCT FROM tests fail closed on NULL.
--
-- status IS READ INTO A **TEXT** VARIABLE, which is not incidental. The status
-- list carries 'inactive', which is NOT a player_status label (the enum is
-- competitive / recreational / pending_approval / suspended). Comparing the
-- enum directly against it raises "invalid input value for enum player_status".
-- 00025:132-139 documents this exact trap; the cast keeps the stray value
-- inert, as it has always been, instead of turning it into a runtime error.
--
-- IT RETURNS, IT DOES NOT RAISE. Every other refusal in this function returns
-- jsonb_build_object('ok', FALSE, 'reason', ...), and the caller is written
-- around that shape; a RAISE here would route an ordinary refusal through the
-- error path. An unrecognised reason degrades to a generic message, which is
-- the safe direction.
--
-- CHECKED BEFORE THE ROW LOCK, so an ineligible caller cannot take a FOR UPDATE
-- on the challenge row on their way to being refused: the same reasoning
-- 00126:158-165 gives for dispute_match_result.
--
-- CREATE OR REPLACE PRESERVES THE ACL, so there is deliberately no re-grant
-- below. 00187 locked this function to `authenticated` and `service_role` and
-- asserts that end state; re-granting here would be a second opinion about a
-- decision that file owns.

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
  -- ADDED BY 00230. TEXT, not player_status: see the section header.
  v_me_status  TEXT;
  v_me_banned  BOOLEAN;
  v_me_active  BOOLEAN;
BEGIN
  IF p_response NOT IN ('accepted', 'rejected') THEN
    RAISE EXCEPTION 'respond_to_challenge: p_response must be accepted or rejected, got %', p_response;
  END IF;

  v_player := get_player_id(auth.uid());
  IF v_player IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  -- ADDED BY 00230. The eligibility gate this function never had. Same shape as
  -- validate_challenge_creation applies to the creator and the opponent at
  -- creation time, applied here to whoever is answering.
  SELECT status::TEXT, is_banned, active_flag
    INTO v_me_status, v_me_banned, v_me_active
    FROM players WHERE id = v_player;
  IF v_me_status IS NULL
     OR v_me_status IN ('suspended', 'inactive', 'pending_approval')
     OR v_me_banned IS DISTINCT FROM FALSE
     OR v_me_active IS DISTINCT FROM TRUE THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_eligible');
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

  -- ONE REJECTION ENDS IT, including in doubles: a partner declining means the
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


-- ============================================================
-- 4. A TEAM-MATE IS NOT AN OPPONENT
-- ============================================================
--
-- THE GAP. apply_match_result already refuses two things: a confirmer who is
-- not a participant (00177:98-102) and a confirmer who IS the submitter
-- (:107-110). The second one's own comment explains what it is for:
-- "confirmation is the opponent's attestation". In singles those two checks
-- together achieve that, because the only other participant is the opponent.
--
-- IN DOUBLES THEY DO NOT. A doubles match has two players on the submitter's
-- own side, and the submitter's PARTNER is a participant who is not the
-- submitter. So one pair can submit a result and confirm it between
-- themselves, and the opposing pair never attests anything. The Elo moves for
-- all four.
--
-- THE FIX is a third guard in the same shape as the two above it, on the axis
-- those two do not test: which SIDE the confirmer is on.
-- match_participants.team_side (00001_schema.sql:412) is the column, and it is
-- the same column the function's own loop already uses to decide who won.
--
-- WHY IT IS A JOIN AND NOT A SCALAR. The check must be SKIPPED, not failed,
-- when submitted_by has no match_participants row at all. Admin-created matches
-- are exactly that: the console submits as an admin who is not playing, and a
-- scalar "the submitter's side" would be NULL there and a naive comparison
-- would either raise or, worse, quietly compare NULL and let everything
-- through. Written as a join, a submitter with no participant row produces no
-- matching pair, the EXISTS is false, and the guard does not fire. A NULL
-- submitted_by behaves the same way.
--
-- WHAT IS DELIBERATELY UNTOUCHED. confirmed_by = p_confirmed_by at :113 and
-- :267, and the audit actor at :288-289, are left exactly as they were. This
-- guard runs only for member callers, because its first conjunct is
-- `auth.uid() IS NOT NULL` and the service role's auth.uid() is NULL: so the
-- console path keeps passing a real actor into those three places and keeps
-- writing a real actor into the audit row. Changing them would have been a
-- second, unrelated change riding along inside a security fix.
--
-- Everything else below is 00177's body verbatim, for the CREATE OR REPLACE
-- reason in this file's header.

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
    v_applied := apply_rating_delta(
      v_participant.player_id, v_match.match_type, v_delta, v_won,
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
-- 5. is_admin_or_coach LOSES A GRANT NOTHING USES
-- ============================================================
--
-- Written in the per-function style of 00126:150-209: name the callers, say
-- what each role is for, then revoke exactly what is left over.
--
-- is_admin_or_coach(uuid) is SECURITY DEFINER and answers "is this user id an
-- admin?" about ANY user id, past the caller's own RLS. 00126:507 already
-- listed it under WHAT AN ATTACKER CAN STILL DO: with nothing but the anon key
-- from the bundle it is a yes/no oracle over arbitrary auth user ids.
--
-- WHY THE anon GRANT WAS KEPT UNTIL NOW, and why that reason does not hold.
-- Both 00217:24-27 and the drift test's header argue that revoking it would
-- break an RLS policy rather than merely a direct call, because RLS is
-- evaluated against the CALLER. That is the right rule and the wrong
-- conclusion for THIS function. The policies naming it are three, they are the
-- varsity_notes policies (00005:318-327), and all three are declared
-- `TO authenticated`. A policy restricted to a role is never evaluated for a
-- different one: the `anon` role never reaches vn_select, vn_insert or
-- vn_update, so it never evaluates this function on their behalf. Confirmed
-- against production: exactly three policies reference it, all with
-- roles = {authenticated}. The argument still holds for session_checkin_open,
-- whose policy is not so restricted, and that grant is untouched here.
--
-- authenticated KEEPS ITS GRANT, and it is load-bearing: it is the role those
-- three policies ARE evaluated for. Only anon and PUBLIC go.
--
-- BOTH NAMES, which is the whole lesson of 00126:10-18 and 00217's THE TRAP.
-- Supabase runs ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO
-- anon, authenticated, service_role, so the live ACL carries an EXPLICIT
-- `anon=X/postgres` entry. Production reads
--   {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
-- and a REVOKE FROM PUBLIC alone would strip only the leading `=X/postgres`
-- and leave anon holding it, while the migration read as though it had dealt
-- with the problem.
--
-- ON REPLAYING THIS SCHEMA FROM SCRATCH, so it is not a mystery later:
-- 00140:270-288 contains a DO block that RAISES if either is_admin or
-- is_admin_or_coach has lost its anon EXECUTE, and 00126 and the drift test
-- both record the anon grant as deliberate. That assertion was true when it was
-- written and it still passes on a forward replay, because 00140 runs long
-- before this file does. It is THIS migration that supersedes it, for
-- is_admin_or_coach only, on the roles evidence above. A future reader finding
-- 00140 asserting the opposite of what the database holds has found this
-- paragraph, not a drift.
--
-- No app code calls it: grepped across apps/, packages/ and scripts/, the only
-- hits are a comment, the generated type and two test comments. There is no
-- .rpc('is_admin_or_coach') anywhere, from any client.

REVOKE EXECUTE ON FUNCTION public.is_admin_or_coach(uuid) FROM PUBLIC, anon;


-- ============================================================
-- 6. SELF-APPROVAL: NOT CLOSED HERE, AND THIS IS WHY
-- ============================================================
--
-- NO SQL IN THIS SECTION. It was scoped as a change and the change does not
-- work; the finding is worth more than a broken guard, so here it is in full.
--
-- ---- THE GAP IS REAL ----------------------------------------------
--
-- players.onboarding_completed is member-writable: 00182:115-126 hands
-- `authenticated` a column-level UPDATE grant on it, which is correct, because
-- completeOnboarding() writes it with the member's own client. 00220's
-- self_serve_auto_approve trigger then fires on exactly the transition
-- FALSE -> TRUE while status = 'pending_approval', and approves the row: status
-- to the configured division, the four roster-restore columns, a member_code
-- and a 'player_approved' audit row.
--
-- So a pending signup can send ONE PATCH setting onboarding_completed = true
-- and be approved, having skipped the onboarding FORM: no age attestation, no
-- claimed skill tier, no legal acceptance. The guard does not stop it because
-- nothing here is privileged in the guard's sense: 00220's header explains at
-- length that guard_player_privileged_columns runs FIRST, sees a member asking
-- only to set onboarding_completed, and correctly passes.
--
-- ---- THE PROPOSED FIX CANNOT BE WRITTEN AS A DATABASE PREDICATE ----
--
-- The intended repair was to require, in the auto-approval path, at least one
-- waiver_acceptances row for the player (00010:98, the table
-- insertAcceptances writes; NOT event_waiver_acceptances from 00015, which is
-- the tournament-scoped one), and to refuse the AUTO-APPROVAL while leaving the
-- row pending rather than raising, so a genuine signup is never hard-failed.
--
-- IT WOULD HAVE REFUSED EVERY GENUINE SIGNUP. The ordering in
-- completeOnboardingImpl (apps/player/src/lib/actions/profile.ts) is:
--
--     1. the players UPDATE carrying onboarding_completed: true   (~:491-515)
--        ...which is the statement the trigger fires inside...
--     2. insertAcceptances(supabase, playerId, ...)               (~:565)
--
-- The acceptance rows are written AFTER the transaction that approves. At
-- trigger time waiver_acceptances is empty for a first-time signup, so the
-- predicate is false for the honest path and the ordinary member is left
-- pending. The INSERT arm is worse and cannot be fixed by reordering at all:
-- create_player_with_rating() inserts the player row with onboarding_completed
-- already TRUE, and waiver_acceptances.player_id is a FK to players, so an
-- acceptance row for that member CANNOT exist yet. That arm could never
-- satisfy the check.
--
-- The result would not have been a residual, it would have been 00220 switched
-- off club-wide days before the release window, silently, with members left in
-- pending_approval and no error anywhere. Worse, it would have been switched
-- off INCONSISTENTLY: a member who had previously met the layout's waiver gate
-- would still auto-approve, so the club would see some signups approved and
-- some not, with nothing to distinguish them.
--
-- WHAT THE FIX ACTUALLY NEEDS, for whoever picks this up: move
-- insertAcceptances ABOVE the players update in completeOnboardingImpl, and
-- give the INSERT arm a path that inserts the acceptances after the row exists
-- but before onboarding_completed is set. That is an app change plus a
-- coordinated deploy, not a predicate, and it is out of scope for a migration
-- that is meant to change nothing but the database.
--
-- ---- TWO THINGS RECORDED HONESTLY -------------------------------
--
-- (a) THE RESIDUAL THAT WOULD HAVE SURVIVED THE FIX ANYWAY. Requiring a waiver
--     acceptance is a weak predicate even when it works. Somebody can accept
--     the legal documents for real, through the ordinary gate, and THEN PATCH
--     onboarding_completed: they satisfy the check and still skip the age
--     attestation and the skill tier. The waiver requirement raises the cost of
--     the shortcut; it does not close it. The full predicate is a
--     post-release follow-up and needs to state positively what a finished
--     onboarding IS, rather than naming one of its side effects.
--
-- (b) last_active_at IS DELIBERATELY NOT ADDED TO THE PLAYERS GUARD. The
--     standing rule from the 2026-08-20 privilege audit is that every new or
--     reconsidered `players` column gets an answer in
--     guard_player_privileged_columns rather than an omission, and this is the
--     answer for that one: it must stay member-writable.
--     apps/player/src/lib/actions/sessions.ts:125 writes it on the MEMBER'S OWN
--     client at every check-in, immediately after the attendance insert. Adding
--     it to the guard's UPDATE arm would raise 'Not authorized to modify
--     privileged player fields' on every check-in in the club. It is a
--     freshness timestamp, it is one of the twelve columns 00182 deliberately
--     granted, and the escalation it offers is keeping yourself off the
--     inactivity sweep, which the sweep's own roster-restore columns already
--     treat as reversible.


-- PostgREST caches both the schema and the function signatures. Without this,
-- the replaced functions and the revoked INSERT privileges are served from the
-- definitions the API already knows, and a failed PostgREST read arrives as an
-- EMPTY LIST rather than an error, so the symptom would be silence.
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- AFTER THE MIGRATION
--
-- APPLY IT WITH --single-transaction. There is no top-level COMMIT in this
-- file, by house convention, so the runner supplies the transaction:
--
--   psql --single-transaction -f 00230_close_the_member_key_write_paths.sql
--
-- THEN REGENERATE THE GENERATED TYPES AND READ THE DIFF. `database.gen.ts` has
-- gone stale before and made a guard test vacuous. Nothing here adds a table or
-- a column, so the expected diff is small or empty: that is the point of
-- looking. A diff larger than expected means something else has drifted and
-- this is the moment it is visible.
--
-- AND REGENERATE THE RELEASE MANIFEST, BEFORE PROMOTING:
--
--   ./scripts/gen-migration-manifest.sh
--
-- Commit the resulting supabase/migrations/.manifest.json alongside this file.
-- It is deliberately NOT updated in the same change that added this migration,
-- because the rollup is a hash OVER THIS FILE'S BYTES, so any further edit here
-- invalidates it: regenerate once the content is final. Two things depend on
-- it. `db-migrate.sh` preflight (:321-349) compares the checkout's manifest
-- against public.schema_migrations, so leaving it at count 220 / latest 00229
-- makes preflight report a version mismatch against a database that is
-- correctly at 00230, and refuse the promotion. And migration-manifest.test.ts
-- recomputes it from the directory, so CI stays red until it is regenerated.
--
-- ---- VERIFYING IT ------------------------------------------------
--
-- 1. The challenge guard refuses a rewrite and allows a cancel. Run as
--    `authenticated`, NEVER as postgres: superuser bypasses RLS and grants, so
--    a psql check as postgres proves nothing here.
--
--      SET ROLE authenticated;
--      -- expect: ERROR  Not authorized to modify this challenge
--      UPDATE challenges SET rated_flag = FALSE WHERE id = '<your own proposed challenge>';
--      -- expect: UPDATE 1
--      UPDATE challenges SET status = 'cancelled' WHERE id = '<the same challenge>';
--      RESET ROLE;
--
-- 2. The three INSERT grants are gone, and nothing else went with them:
--
--      SELECT relname, relacl FROM pg_class
--       WHERE relname IN ('challenge_participants','walkovers','disputes');
--      -- expect authenticated=rwdm (no leading 'a') on all three,
--      -- service_role still arwdDxtm
--
-- 3. anon no longer executes is_admin_or_coach, authenticated still does:
--
--      SELECT has_function_privilege('anon', 'public.is_admin_or_coach(uuid)', 'EXECUTE'),
--             has_function_privilege('authenticated', 'public.is_admin_or_coach(uuid)', 'EXECUTE');
--      -- expect f | t
--
-- 4. The two replaced functions kept their ACLs (CREATE OR REPLACE preserves
--    them, and 00187 asserts this end state):
--
--      SELECT proname, proacl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--       WHERE n.nspname = 'public' AND proname IN ('respond_to_challenge','apply_match_result');
--      -- expect authenticated=X and service_role=X on both, anon on neither
--
-- 5. The trigger sorts before set_updated_at, which is what makes the
--    updated_at comparison safe:
--
--      SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.challenges'::regclass
--        AND NOT tgisinternal ORDER BY tgname;
--      -- expect guard_challenge_member_columns_trg BEFORE set_updated_at
--
-- ---- WHAT IS LEFT OPEN, DELIBERATELY -----------------------------
--
--   * Self-approval by PATCHing onboarding_completed. Section 6 in full.
--   * The scan requirement on session_checkin_open(). The file header in full.
--   * challenges_insert (00005:128-129) pins only created_by, so a member can
--     still INSERT a challenge row directly at PostgREST carrying
--     event_type = 'tournament', bypassing create_challenge_atomic's derivation.
--     Section 1 guards UPDATE and does not touch that. What defangs it is
--     section 2: the forged challenge can never be enrolled, because
--     challenge_participants no longer takes a member-key insert, and every
--     path that reads a challenge into a match reads the participant list
--     first. Closing the INSERT side properly means a column guard on the
--     insert arm, and it wants its own migration.
-- ============================================================================
