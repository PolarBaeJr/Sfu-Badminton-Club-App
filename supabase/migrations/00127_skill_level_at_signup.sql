-- ============================================================
-- 00127_skill_level_at_signup.sql — three skill tiers that seed a new member's
-- starting rating, and a switch that turns provisional K off
-- ============================================================
-- Every member has started at exactly the same rating since launch, so the
-- ladder's first job on club night is telling a national-level player apart
-- from somebody who picked up a racket last week — and it does that by making
-- the beginner lose eight matches. Onboarding now asks, and the answer seeds
-- the starting rating.
--
-- THE THREE TIERS AND THEIR NUMBERS (the club owner's, not derived):
--
--   beginner      400   — today's default_elo exactly, so this tier is a no-op
--   intermediate  800
--   advanced     1200
--
-- 400 APART IS NOT ARBITRARY ON THIS LADDER. ELO_SCALE is 800 here, not the
-- classic 400 (packages/shared/src/elo/engine.ts:11-14) — this ladder is a 2x
-- stretch, so a gap of 400 is HALF a scale, not a full one. Working it through
-- the logistic: one tier apart the stronger player is expected to win ~76% of
-- the time, and beginner-vs-advanced (800, a full scale) ~91%. Those are the
-- odds the seeding is claiming, and they are sane band separations — close
-- enough that a mis-set tier is correctable, far enough that the bands mean
-- something.
--
-- BEGINNER IS DELIBERATELY A NO-OP AND NOTHING IS BACKFILLED. rating_defaults
-- .default_elo is 400 on production today, so a member who picks Beginner gets
-- precisely what they would have got before this migration, and every existing
-- member already sits at that number. There is no data migration here and there
-- must not be one: back-filling a tier nobody chose would invent an answer, the
-- same reasoning 00121 gives for not back-filling passkey_setup to 'declined'.
--
-- WHY THE TIER IS SEEDED SERVER-SIDE FROM A NAME, NEVER A NUMBER. The seed
-- function below takes 'beginner' | 'intermediate' | 'advanced' and resolves
-- the rating itself out of platform_settings. A client that could pass an
-- INTEGER into a SECURITY DEFINER function running as the table owner is
-- exactly the self-insert escalation 00056 exists to close — it would let
-- anybody type themselves to the top of the ladder. Passing a name means the
-- worst a hostile client can do is claim a tier the screen already offers.
--
-- UNDER-CLAIMING IS THE HARMFUL DIRECTION, and provisional K is the answer.
-- A strong player who picks Beginner farms rating off real beginners; a weak
-- player who picks Advanced simply loses it back. Provisional K (64 on
-- production, ~8 placement matches) corrects either way in a handful of
-- matches, which is why the club owner kept it rather than replacing it with
-- the tiers. The tiers are a better STARTING GUESS; provisional K is still the
-- correction. They are complements, not alternatives.


-- ---- 1. The new settings -----------------------------------
-- Merged as `new || existing` so EXISTING KEYS WIN. Re-running this migration
-- cannot revert a value an admin has since tuned on /ratings, and a database
-- that already has the keys is untouched — which is the whole idempotency
-- requirement. Written as one UPDATE on the rating_defaults row rather than as
-- a new platform_settings key: /ratings already fetches this row for the form,
-- so a new key would mean a new section, a new platform-setting-sections entry
-- and a second query, all for four scalars that belong beside default_elo.
--
-- provisional_k_enabled DEFAULTS TRUE = today's behaviour exactly. The switch
-- is off-by-default in the sense that turning it OFF is the change; shipping it
-- false would silently halve every new member's convergence speed.
UPDATE platform_settings
   SET value = jsonb_build_object(
                 'tier_beginner_elo',     400,
                 'tier_intermediate_elo', 800,
                 'tier_advanced_elo',     1200,
                 'provisional_k_enabled', true
               ) || value,
       updated_at = NOW()
 WHERE key = 'rating_defaults';


-- ---- 2. What the member claimed ----------------------------
-- The tier NAME, kept even though the rating it produced is already in
-- ratings.singles_elo. The rating moves the moment they play; the claim does
-- not, and without it "did tiering work" is unanswerable — you cannot tell an
-- Advanced player who settled at 1150 from a Beginner who climbed there, which
-- is the only question this feature's success turns on. Same argument 00121
-- makes for passkey_setup, and the same NULL semantics: NULL means never asked,
-- i.e. every member who onboarded before this shipped, plus every admin-created
-- roster row.
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS skill_tier text;

-- Named, and added separately from the column so a re-run on a database that
-- already has both is still a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.players'::regclass
      AND conname = 'players_skill_tier_check'
  ) THEN
    ALTER TABLE public.players
      ADD CONSTRAINT players_skill_tier_check
      CHECK (skill_tier IN ('beginner', 'intermediate', 'advanced'));
  END IF;
END $$;

COMMENT ON COLUMN public.players.skill_tier IS
  'The skill level this member claimed at onboarding: beginner, intermediate '
  'or advanced. Seeds the starting rating via apply_skill_tier_seed (00127). '
  'NULL = never asked, i.e. onboarded before 00127 or added by an admin.';

-- NO GRANT ON skill_tier, DELIBERATELY — the lesson of 00092/00115 and the
-- reason 00121 says the same thing. A column granted to `authenticated` is
-- granted on every row, and a column NOT granted makes PostgREST refuse the
-- WHOLE request with a 403 that supabase-js resolves rather than rejects, so
-- the app renders it as empty data with no error anywhere. This repo has lost
-- four screens to exactly that. Nothing client-side selects skill_tier:
-- onboarding knows what it just sent, and the value is written by the
-- service-role client inside completeOnboarding. If an admin report ever needs
-- it, read it service-side like the rest of the console, or add
-- `GRANT SELECT (skill_tier) ON public.players TO authenticated` then, with its
-- own reasoning.
--
-- The TIER VALUES are a different matter and need no grant at all: they live in
-- platform_settings, which is already readable by any authenticated member
-- (settings_select, 00005_rls.sql) — the same row apps/player/src/lib/
-- challenge-settings.ts and checkin-settings.ts already read. So the onboarding
-- screen can print the rating each tier gives without a single new permission.


-- ---- 3. Seeding the rating ---------------------------------
-- Called by completeOnboarding AFTER the player and ratings rows exist. That
-- ordering is not a preference: there is no trigger on auth.users creating a
-- players row, so before completeOnboarding runs there is nothing to seed.
--
-- ONE FUNCTION FOR ALL THREE ONBOARDING PATHS. completeOnboarding can arrive
-- here having (a) inserted a new player via create_player_with_rating, (b)
-- CLAIMED an unclaimed roster row an admin pre-added, or (c) updated a players
-- row that already existed. Forking create_player_with_rating would only ever
-- have covered (a) — and (b) is the dangerous one, because that row may carry a
-- rating an admin set deliberately.
--
-- THE GUARD IS THE POINT OF THIS FUNCTION. A rating is seeded only if it has
-- NEVER MOVED, tested two ways:
--
--   * zero matches played in both disciplines, AND
--   * no season_final_ratings snapshot for this player.
--
-- The second test is not belt-and-braces. activate_season with p_elo_policy =
-- 'full' sets singles_matches_played = 0 and doubles_matches_played = 0 on
-- EVERY row (00068:98-104), so after a full season reset the match counts alone
-- would say "never played" about the entire club. The snapshot is the durable
-- record that a member has history, and it survives the reset that erases the
-- counters.
--
-- Without that guard this is a rating-laundering hole: an admin pre-rates a
-- strong player at 1200, the player signs up, claims the roster row, picks
-- Beginner, and lands at 400 with a season of results behind them. That is the
-- under-claiming exploit arriving through the back door, and no amount of
-- provisional K fixes it because their rating was already correct.
--
-- IT IS NOT GUARDED ON skill_tier BEING UNSET, and that is deliberate. If a
-- member ever runs onboarding a second time — only reachable if an admin clears
-- onboarding_completed, since the middleware sends everyone else straight past
-- it — re-answering the question SHOULD move the rating, because the new answer
-- is the better one. The invariant being protected is "a rating that has been
-- earned is never overwritten", not "this function runs once", and the two
-- clauses above are what enforce it: the moment they play a single rated match
-- the rating stops being seedable no matter how many times they re-answer.
--
-- Returns TRUE only when a rating was actually written, so the caller can tell
-- "seeded" from "declined to seed" rather than guessing.
CREATE OR REPLACE FUNCTION public.apply_skill_tier_seed(
  p_player_id uuid,
  p_tier text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_elo INTEGER;
  -- The fallback for the tier that was claimed, kept beside v_elo so the
  -- non-positive guard below can reach it without repeating the CASE.
  v_fallback INTEGER;
  v_min INTEGER := rating_setting_int('min_elo', 100);
  v_max INTEGER := rating_setting_int('max_elo', 1500);
  -- What an untouched rating looks like: create_player_with_rating seeds every
  -- new row at exactly this. Used below to tell "nobody has decided" apart from
  -- "an exec set this by hand", which no match counter can distinguish.
  v_default_elo INTEGER := rating_setting_int('default_elo', 400);
  v_seeded INTEGER := 0;
BEGIN
  -- An unrecognised tier is dropped rather than raised. This is the last step
  -- of onboarding and it must never be the thing that stops somebody finishing
  -- their account; the CHECK constraint on the column is the real guarantee.
  IF p_tier IS NULL OR p_tier NOT IN ('beginner', 'intermediate', 'advanced') THEN
    RETURN FALSE;
  END IF;

  -- Resolved through rating_setting_int (00041) so an absent, null or
  -- non-castable key falls back to the number this migration seeded, rather
  -- than to NULL — which would write a NULL rating into a NOT NULL column and
  -- fail the whole call.
  v_fallback := CASE p_tier
                  WHEN 'beginner'     THEN 400
                  WHEN 'intermediate' THEN 800
                  WHEN 'advanced'     THEN 1200
                END;
  v_elo := CASE p_tier
             WHEN 'beginner'     THEN rating_setting_int('tier_beginner_elo', 400)
             WHEN 'intermediate' THEN rating_setting_int('tier_intermediate_elo', 800)
             WHEN 'advanced'     THEN rating_setting_int('tier_advanced_elo', 1200)
           END;

  -- A NON-POSITIVE SETTING IS UNSET, NOT A RATING, AND THE TWO SIDES HAVE TO
  -- SAY SO IN THE SAME WORDS. skillTierElo() in packages/shared already reads
  -- it that way — `Number.isFinite(n) && n > 0 ? n : fallback`, matching num()
  -- in the engine — and it is what the onboarding screen PRINTS. Without the
  -- same rule here the two disagree on exactly the input the /ratings form
  -- allows: the tier fields are `min: 0`, so an admin can save
  -- tier_beginner_elo = 0, at which point rating_setting_int returns 0 (0 is
  -- perfectly castable, so none of its three fallbacks fire), the clamp below
  -- lifts it to min_elo, and a member is shown "you will start at 400" and
  -- written 100. Guarding here rather than in rating_setting_int because 0 is
  -- not obviously unset for every caller of that helper, and rather than in a
  -- CHECK because rating_defaults is a free-form jsonb blob with no per-key
  -- constraint and the form is not the only way a value reaches it.
  IF v_elo IS NULL OR v_elo <= 0 THEN
    v_elo := v_fallback;
  END IF;

  -- Clamped to the configured ladder, the same way every other rating write is.
  -- An admin who sets tier_advanced_elo above max_elo gets the ceiling, not a
  -- member sitting outside the ladder. An inverted pair is ignored rather than
  -- honoured — max <= min collapses every rating to one value and must not be
  -- reachable from a settings typo (resolveEloBounds says the same in TS).
  IF v_max > v_min THEN
    v_elo := LEAST(v_max, GREATEST(v_min, v_elo));
  END IF;

  -- The CLAIM is recorded even when the rating is not seeded. A member who
  -- claimed a pre-rated roster row still told us what they think they are, and
  -- that answer is exactly as interesting as one that moved a number — arguably
  -- more so, because it is the case where the two can be compared.
  UPDATE players SET skill_tier = p_tier WHERE id = p_player_id;

  UPDATE ratings
     SET singles_elo = v_elo,
         doubles_elo = v_elo,
         updated_at  = NOW()
   WHERE player_id = p_player_id
     AND singles_matches_played = 0
     AND doubles_matches_played = 0
     AND NOT EXISTS (
       SELECT 1 FROM season_final_ratings sfr WHERE sfr.player_id = p_player_id
     )
     -- AND STILL UNTOUCHED. The three conditions above only prove nobody has
     -- PLAYED; they say nothing about whether somebody has DECIDED. An exec can
     -- set a rating by hand when adding a known player to the roster
     -- (actions/players.ts:262 writes singles_elo directly), and such a row has
     -- zero matches and no season snapshot — so without this line, the moment
     -- that player claims their row and picks a tier at onboarding, a
     -- deliberate rating is silently replaced by a self-declared one. The
     -- onboarding copy promises the opposite.
     --
     -- Equality with default_elo is the test because that is what "nobody has
     -- decided" looks like: create_player_with_rating seeds every new row at
     -- exactly that value. A rating that differs from it, with no matches
     -- behind it, can only have been set by hand.
     -- EITHER the configured default OR the literal 400 that creation actually
     -- writes. create_player_with_rating and 00132's ensure_player_for_user both
     -- INSERT 400 outright rather than reading rating_defaults, so on a club
     -- that has tuned default_elo to anything else every fresh row would fail
     -- `= v_default_elo` and the tier seed would silently refuse every member
     -- while still recording their claimed tier — the screen promising one
     -- starting rating and the database keeping another. Accepting both values
     -- keeps "nobody has decided yet" true under either creation path; a rating
     -- that matches neither has been touched by hand and is still protected.
     AND singles_elo IN (v_default_elo, 400)
     AND doubles_elo IN (v_default_elo, 400);

  GET DIAGNOSTICS v_seeded = ROW_COUNT;
  RETURN v_seeded > 0;
END;
$$;

COMMENT ON FUNCTION public.apply_skill_tier_seed(uuid, text) IS
  'Records the skill tier a member claimed at onboarding and, only if their '
  'rating has never moved (no matches played and no season snapshot), seeds '
  'singles_elo and doubles_elo from platform_settings.rating_defaults. Returns '
  'TRUE when a rating was written.';

-- SERVICE ROLE ONLY. Deliberately NOT granted to `authenticated`, unlike
-- create_player_with_rating. The caller is completeOnboarding, which already
-- holds a service-role client for exactly this class of write (see
-- recordPasskeySetup), so nothing is lost — and a SECURITY DEFINER function
-- that takes an arbitrary p_player_id and rewrites their rating is not
-- something a member's own session should be able to reach. Granting it would
-- mean any authenticated member could reseed any OTHER member's unplayed
-- rating. The grant is the authorization here; there is no auth.uid() check
-- inside because there is no path by which a member reaches it.
-- PUBLIC IS NOT ENOUGH, and this file nearly shipped believing it was.
--
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon and authenticated
-- as EXPLICIT entries on every function created in this schema. REVOKE ... FROM
-- PUBLIC does not touch an explicit grant, so the two lines below, without the
-- roles named, would have left a SECURITY DEFINER function taking an ARBITRARY
-- p_player_id callable by anyone holding the anon key — which ships in the
-- browser bundle. Any visitor could have rewritten any unplayed member's rating
-- and set their skill_tier.
--
-- 00126 exists because of this exact trap and documents it at length; this
-- migration was written the same day and reproduced it anyway. That is how
-- quiet it is. Naming PUBLIC as well as the roles is also required — anon is a
-- member of PUBLIC, so revoking from the role alone leaves the PUBLIC grant.
REVOKE ALL ON FUNCTION public.apply_skill_tier_seed(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_skill_tier_seed(uuid, text) TO service_role;


-- ---- 4. The provisional-K switch ---------------------------
-- apply_match_result is redefined WHOLESALE because Postgres has no partial
-- body replace. The body below is the LIVE production definition, read back
-- with pg_get_functiondef on 2026-08-15 and diffed against 00041 — they are
-- identical, so there is no hand-applied hotfix being reverted here. Exactly
-- ONE thing changes, and it is marked <<< 00127 >>> below.
--
-- WHAT THE SWITCH DOES, AND WHAT IT DELIBERATELY DOES NOT.
-- It changes WHICH K IS SELECTED. It does not touch the provisional FLAGS or
-- the threshold that clears them: singles_provisional / doubles_provisional are
-- still set and cleared exactly as before. That is not squeamishness — /ratings
-- counts heads off `flag OR matches_played < threshold` (loadLadder, and
-- KFactorPanel beside it), so suppressing the flag would make those figures lie
-- about a club whose members are still, factually, in their placement window.
-- The switch says "stop giving them a bigger K", not "pretend they are
-- established".
--
-- WHY THIS IS NOT "CHANGING THE ELO MATHS". calculate_elo_update is untouched,
-- as are apply_rating_delta and apply_tournament_match_rating. The arithmetic
-- that turns a K into a delta is byte-identical. What moves is which of two
-- ALREADY-CONFIGURABLE numbers gets handed to it — the same choice getKFactor()
-- makes in TS, which is the settings-driven seam this feature was always going
-- to land on.
--
-- WHY BOTH ENGINES MUST CHANGE TOGETHER. Challenges rate through this function;
-- tournaments rate through the TypeScript getKFactor (see
-- apps/admin/src/lib/tournament-actions/_internal.ts:1200,1281-1282). Honouring
-- the switch in only one of them would apply DIFFERENT K to the same player
-- depending on where they played. That precise failure has bitten this codebase
-- twice already and both scars are still in the source: the JS-vs-Postgres
-- rounding disagreement (engine.ts:76-84) and the sweep multiplier defaulting
-- to 1.0 in TS while SQL applied 1.15 to the identical scoreline
-- (engine.ts:129-135). The matching TS change ships in the same commit.
--
-- TURNING THIS OFF REMOVES THE CORRECTION FOR AN UNDER-CLAIMED TIER. That is
-- the one consequence worth stating out loud, because this migration also ships
-- the tiers: with provisional K off, a strong player who picks Beginner
-- converges at the established K instead, which on production is 36 rather than
-- 64 — most of twice as long spent farming rating off real beginners. The
-- /ratings screen says so where the switch is.
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
  -- qualifies, via 00053's section-aware helper — no new helper needed.
  v_provisional_k BOOLEAN := platform_setting_bool('rating_defaults', 'provisional_k_enabled', TRUE);
  v_participant RECORD;
  v_opponent_rating INTEGER;
  v_k_factor INTEGER;
  v_format_weight NUMERIC;
  v_event_mult NUMERIC;
  v_won BOOLEAN;
  v_new_rating INTEGER;
  v_delta INTEGER;
  v_games_a INTEGER;
  v_games_b INTEGER;
  v_derived_winner team_side;
  v_elo_field TEXT;
  v_matches_field TEXT;
  v_wins_field TEXT;
  v_losses_field TEXT;
  v_prov_field TEXT;
  v_streak_field TEXT;
  v_best_streak_field TEXT;
  v_pts_scored_field TEXT;
  v_pts_allowed_field TEXT;
  v_games_won_field TEXT;
  v_games_lost_field TEXT;
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
  -- The submitter must NOT confirm their own result — confirmation is the
  -- opponent's attestation. This also shuts the match-forgery path: fabricating
  -- a match + self-enrolling a victim requires being the submitter (mp_insert),
  -- and applying it requires confirming, so submitter=confirmer is blocked here.
  IF auth.uid() IS NOT NULL
     AND NOT is_admin(auth.uid())
     AND get_player_id(auth.uid()) = v_match.submitted_by
  THEN RAISE EXCEPTION 'The submitter cannot confirm their own result'; END IF;
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

  -- Set field names based on match type
  IF v_match.match_type = 'singles' THEN
    v_elo_field := 'singles_elo'; v_matches_field := 'singles_matches_played';
    v_wins_field := 'singles_wins'; v_losses_field := 'singles_losses';
    v_prov_field := 'singles_provisional'; v_streak_field := 'current_singles_streak';
    v_best_streak_field := 'best_singles_streak';
    v_pts_scored_field := 'singles_points_scored'; v_pts_allowed_field := 'singles_points_allowed';
    v_games_won_field := 'singles_games_won'; v_games_lost_field := 'singles_games_lost';
  ELSE
    v_elo_field := 'doubles_elo'; v_matches_field := 'doubles_matches_played';
    v_wins_field := 'doubles_wins'; v_losses_field := 'doubles_losses';
    v_prov_field := 'doubles_provisional'; v_streak_field := 'current_doubles_streak';
    v_best_streak_field := 'best_doubles_streak';
    v_pts_scored_field := 'doubles_points_scored'; v_pts_allowed_field := 'doubles_points_allowed';
    v_games_won_field := 'doubles_games_won'; v_games_lost_field := 'doubles_games_lost';
  END IF;

  v_format_weight := v_match.format_weight;
  -- elo_weight_override carries the reduced walkover weighting
  -- (0.50 withdrawal < 24h, 0.75 no-show); NULL for normal matches.
  v_event_mult := v_match.event_multiplier * COALESCE(v_match.elo_weight_override, 1.0);

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
    -- below — see the header for why.
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

    -- Update match_participants
    UPDATE match_participants SET
      post_rating = v_new_rating,
      rating_delta = v_delta,
      win_flag = v_won
    WHERE id = v_participant.id;

    -- Update ratings table using dynamic SQL
    EXECUTE format(
      'UPDATE ratings SET %I = $1, %I = %I + 1, %I = CASE WHEN $2 THEN %I + 1 ELSE %I END, %I = CASE WHEN NOT $2 THEN %I + 1 ELSE %I END, %I = $3 + COALESCE(%I, 0), %I = $4 + COALESCE(%I, 0), %I = $5 + COALESCE(%I, 0), %I = $6 + COALESCE(%I, 0), %I = CASE WHEN $2 THEN GREATEST(COALESCE(%I, 0) + 1, 1) ELSE LEAST(COALESCE(%I, 0) - 1, -1) END, %I = CASE WHEN %I + 1 >= $8 THEN FALSE ELSE %I END, updated_at = NOW() WHERE player_id = $7',
      v_elo_field,
      v_matches_field, v_matches_field,
      v_wins_field, v_wins_field, v_wins_field,
      v_losses_field, v_losses_field, v_losses_field,
      v_pts_scored_field, v_pts_scored_field,
      v_pts_allowed_field, v_pts_allowed_field,
      v_games_won_field, v_games_won_field,
      v_games_lost_field, v_games_lost_field,
      v_streak_field, v_streak_field, v_streak_field,
      v_prov_field, v_matches_field, v_prov_field
    ) USING v_new_rating, v_won, v_participant.points_scored, v_participant.points_allowed, v_participant.games_won, v_participant.games_lost, v_participant.player_id, v_threshold;

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
