-- ============================================================
-- 00123_stats_gaps_closed.sql — the three things 00119 wrote down under FOUND
-- AND NOT FIXED, answered
-- ============================================================
-- 00119 turned head_to_head_stats and partnership_stats from running totals
-- into a RECOMPUTE from `matches` + `match_participants`, and then listed three
-- things it had deliberately left alone (00119:286-316). This file closes all
-- three. It does not touch the shape of the fix: every number below is still
-- produced by counting rows that exist, never by adding one to a number that
-- was already there, and a second run of this file still reports 0 changed.
--
--   WALKOVERS       — settled below, and the answer is NO, none of them count.
--   merge_players   — 00119's description of it is FACTUALLY WRONG, and the
--                     real problem is a different, worse one. See ARGUMENT D.
--   player_a_points — POPULATED, not dropped. See ARGUMENT C.
--
-- TWO OF 00119'S STATEMENTS OF FACT ARE WRONG and are corrected here rather
-- than left to mislead the next reader:
--
--   1. 00119:300-307 says merge_players "REASSIGNS match_participants.player_id
--      and re-points head_to_head_stats / partnership_stats rows at the
--      surviving player". IT DOES NOT, and never has. Neither 00026, 00079 nor
--      00095 contains a single statement that moves any of those three tables.
--      merge_players_preview counts them and merge_players REFUSES the merge
--      when the count is non-zero. The corruption 00119 describes is not
--      reachable — but something else is, and ARGUMENT D is about that.
--
--   2. 00119:311-313 says "nothing reads them (/my-stats and
--      /leaderboard/[playerId] both select only the win counts and
--      total_matches)". That is true of /my-stats, which enumerates its columns
--      (my-stats/page.tsx:120). It is FALSE of /leaderboard/[playerId], which
--      does `.select('*')` (page.tsx:31) and therefore pulls both points
--      columns down on every profile view. It renders only `total_matches`, so
--      nothing is displayed wrong today — but "no reader" was the entire
--      argument for leaving the columns unwritten, and it does not hold.
--
-- ------------------------------------------------------------
-- ARGUMENT A. DO WALKOVERS COUNT? NO — AND THE CURRENT LINE IS DRAWN
--             SOMEWHERE NOBODY CHOSE
-- ------------------------------------------------------------
-- 00119 recorded this as "UNRATED WALKOVERS NEVER COUNT, RATED ONES DO". That
-- is not quite what the code does, and the difference is the whole argument.
--
-- apply_walkover_result (00003:485, live body 00049:77) computes:
--
--     v_elo_weight := 0.00  -- withdrawal with notice_hours >= threshold
--                     0.50  -- withdrawal with less notice
--                     0.75  -- no_show
--     v_apply_elo  := v_elo_weight > 0 AND v_challenge.rated_flag;
--
-- and then inserts the match at 'pending_confirmation' when v_apply_elo, which
-- apply_match_result flips to 'confirmed' — or straight at
-- result_status = 'walkover' when it does not.
--
-- SO THE SPLIT IS NOT rated_flag. IT IS notice_hours. A RATED challenge
-- withdrawn with 25 hours' notice gets weight 0.00, lands at 'walkover', and
-- has never counted. The SAME rated challenge withdrawn with 23 hours' notice
-- gets weight 0.50, lands at 'confirmed', and counts. Two identical forfeits
-- between the same two members appear differently in their head-to-head record
-- because of how far in advance one of them sent a message. Nobody decided
-- that; it is what falls out of reusing the Elo-weight branch to pick a status.
--
-- Once that is visible, "leave it alone" stops being an option: whichever
-- answer is right, the line has to move. The two coherent answers are ALL
-- walkovers count, or NONE do.
--
-- THE RULING: NONE DO. The argument is 00119's own, applied one step further.
--
--   00119 settled the unrated question by asking what these tables ARE, and
--   answered: they are DESCRIPTIVE. "You have played Bob 8 times, 5-3" is a
--   fact about the evenings; `ratings` is where rating state lives (00119:69-73).
--   That is exactly the distinction that decides this one. A walkover has
--   consequences but no evening. Nobody served, nobody rallied, there is no
--   score — apply_walkover_result never writes points_scored, so both sides sit
--   at the column default of 0 (00001:416). Counting it puts a row in "we have
--   played 8 times" for a night one of them did not turn up to.
--
--   THE CONSEQUENCES ARE ALREADY RECORDED, TWICE, IN THE PLACES BUILT FOR THEM.
--   The forfeiter takes the Elo hit (unchanged by this file — nothing here goes
--   near apply_match_result or the rating engine). reliability_metrics gets
--   no_shows / late_cancellations / early_withdrawals / walkovers_received /
--   walkover_flag, a whole table whose job is "this member forfeits". And
--   `walkovers` keeps the incident itself. A forfeit is not being forgotten; it
--   is being kept out of the one table that claims to describe play.
--
--   THE SCHEMA ALREADY SAYS SO. result_status has its own terminal value
--   'walkover' (00001:78-86) alongside 'confirmed', and `matches` carries
--   walkover_type and forfeit_player_id. Whoever wrote that did not think a
--   forfeit was a confirmed result; they gave it its own word.
--
--   IT MATTERS ON A SCREEN. /my-stats ranks the Best Partners card by
--   win_rate. A doubles pair awarded a walkover would carry a win they did not
--   play, on a card that exists to say who you play well with. And the points
--   columns this file starts writing (ARGUMENT C) would gain a 0-0 "match" that
--   drags a real points record toward nothing.
--
-- WHAT IT COSTS, STATED PLAINLY: THIS REWRITES LIVE ROWS DOWNWARD. Every rated
-- late-notice walkover sitting at 'confirmed' is counted TODAY and stops being
-- counted when this runs. Somebody's head-to-head total will go from 8 to 7.
-- The backfill counts those matches and RAISEs NOTICE with the figure before it
-- changes anything, because the owner has already been burned once by a silent
-- numeric change on these screens (the win_rate ×100 renderer, 00119:229-235)
-- and a second one arriving unannounced would be worse than the bug.
--
-- IF THE OWNER WANTS THE OTHER ANSWER it is one line: delete the
-- `AND p_walkover_type IS NULL` from the predicate in STEP 1 below and
-- re-run this file. The backfill carries it through every historical row, in either
-- direction, because the predicate has exactly one definition. That is the
-- property 00119 built and this file preserves — the ruling is a line of SQL,
-- not a rule scattered across four call sites.
--
-- ------------------------------------------------------------
-- ARGUMENT B. WHY THE PREDICATE GAINS AN ARGUMENT INSTEAD OF READING A ROW
-- ------------------------------------------------------------
-- Excluding walkovers CANNOT be done from result_status alone, and that is the
-- point of the finding above: the rated ones are indistinguishable from any
-- other confirmed match by status. They are distinguishable by
-- matches.walkover_type, which apply_walkover_result is the only writer of —
-- verified across every migration and both apps. (The `'walkover'` strings all
-- over apps/admin/src/lib/tournament-actions/* are tournament_matches.status, a
-- different table that never touches these counters at all.) walkovers.
-- walkover_type is NOT NULL (00001:441), so the column is set on every walkover
-- match and NULL on every other match. `result_status = 'confirmed' AND
-- walkover_type IS NULL` is therefore exact in both directions.
--
-- 00119 gave the predicate a result_status parameter rather than a `matches`
-- rowtype so it would not be pinned to the shape of that table (00119:344-346).
-- Taking a SECOND SCALAR COLUMN keeps that property exactly — this is still not
-- a rowtype parameter, and a column added to or dropped from `matches` still
-- cannot break it.
--
-- IT HAS TO BE A DROP AND RE-CREATE, NOT A CREATE OR REPLACE. Postgres keys
-- functions on the argument list: `CREATE OR REPLACE FUNCTION
-- match_counts_toward_stats(result_status, walkover_type)` would MINT A SECOND
-- OVERLOAD and leave the one-argument body live. Nothing would error; the old
-- call sites would keep calling the old body and the ruling would apply to
-- none of them. So the one-argument form is dropped, and EVERY ONE OF ITS FIVE
-- CONSUMERS is re-created below — recompute_head_to_head_pair,
-- recompute_partnership_pair, trigger_match_confirmed,
-- trigger_match_participants_inserted, and the backfill. Miss one and the next
-- confirmation raises "function does not exist" at runtime. The DROP is safe:
-- Postgres records no dependency from a plpgsql body to a function it calls,
-- and the predicate appears in no view, index, constraint or policy.
--
-- update_head_to_head and update_partnership_stats are NOT re-created. They
-- find a match's pairs and delegate; they never ask the predicate (00119
-- explains why — on the reversal path the match has already been voided and its
-- pairs must still be found). Their bodies are correct as 00119 left them.
--
-- TWO CONSEQUENCES OF THE NEW ARGUMENT, BOTH BENIGN:
--
--   trigger_match_confirmed is AFTER UPDATE **OF result_status**, so an UPDATE
--   that touches only walkover_type does not fire it. That is fine, and it is
--   fine for a reason rather than by luck: apply_walkover_result sets
--   walkover_type in the INSERT and nothing anywhere ever updates it. NEW and
--   OLD always agree on it, so for a walkover match the predicate is FALSE on
--   both sides of every transition and the trigger correctly never counts it —
--   including on the pending_confirmation -> confirmed flip that used to.
--
--   RE-RUNNING 00119 AFTER THIS FILE WOULD REVERT THE RULING. It would
--   CREATE OR REPLACE the one-argument predicate back into existence and
--   restore all five consumers to one-argument calls. Migrations are applied in
--   order, once, so this is a caveat for anyone hand-replaying an old file, not
--   a bug. Replay 00123 after any replay of 00119.
--
-- ------------------------------------------------------------
-- ARGUMENT C. player_a_points / player_b_points: POPULATED
-- ------------------------------------------------------------
-- 00119 left them unwritten on the argument that no reader would benefit. That
-- argument rested on a fact that is not true (/leaderboard/[playerId] does
-- `.select('*')`), and the brief said not to leave a column that looks
-- meaningful and is always zero. So: populate.
--
-- POPULATE RATHER THAN DROP, and the deciding reason is the house rule for a
-- drop itself — nothing may select the column first. `.select('*')` selects it.
-- Removing that requires enumerating every column of head_to_head_stats at the
-- call site, deploying that, regenerating database.gen.ts, and only then
-- dropping — a three-step deploy dance across two apps to delete a column whose
-- data is sitting in match_participants.points_scored waiting to be summed.
-- Populating is one statement, needs no code change, no deploy ordering and no
-- regenerated types, and it is a strict improvement in what the row says.
--
-- It also finishes 00119's own thesis. 00119's recompute deliberately omitted
-- these two columns from both the INSERT and the SET list, which meant the row
-- was NOT wholly a view of the matches — two of its columns were still whatever
-- happened to be stored. After this file every non-identity column of
-- head_to_head_stats is derived, and "is this column stale?" stops being a
-- question anyone can ask about this table.
--
-- THE ARITHMETIC IS SUM(pa.points_scored) AND SUM(pb.points_scored) — ONE ROW
-- PER SIDE. Each participant row carries the TEAM's score, so in doubles the
-- one row already is the pair's points and there is nothing to add. This is
-- DELIBERATELY NOT the shape recompute_partnership_pair uses
-- (SUM(pa.points_scored + pb.points_scored)); that one sums both partners and
-- therefore doubles the team score, which 00119 kept as a faithful port of the
-- old running total rather than a decision (00119:490-498). Copying it here by
-- analogy would double every head-to-head points figure in a way that looks
-- right. The columns are INTEGER NOT NULL (00001:504-505), so the zero case
-- writes 0 rather than NULL.
--
-- THE WRITE GUARD HAD TO GROW WITH THE SET LIST, and this is the failure mode
-- that would have made the whole section inert. 00119's ON CONFLICT arm only
-- writes when the stored tuple IS DISTINCT FROM the computed one. Adding the
-- points to the SET list without adding them to BOTH SIDES of that tuple would
-- mean every pair whose counts are already right evaluates the guard as false,
-- writes nothing, keeps 0 forever — and the backfill honestly reports "0 rows
-- changed" while the column it claims to have fixed is untouched. Both columns
-- are in the SET list, in both sides of the guard tuple, and in the zero
-- branch's UPDATE and ITS guard tuple. A pair whose matches were all voided
-- must not keep stale points next to total_matches = 0; that half-truth is
-- precisely what 00119 exists to remove.
--
-- ------------------------------------------------------------
-- ARGUMENT D. merge_players: THE REAL PROBLEM IS THE OPPOSITE OF THE ONE
--             00119 DESCRIBED
-- ------------------------------------------------------------
-- merge_players cannot corrupt these counters, because merge_players_preview
-- (00026:41, live body 00095:41) counts match_participants, head_to_head_stats
-- and partnership_stats for the account being removed and merge_players REFUSES
-- the merge if any of them is non-zero. A loser with match history is not
-- merged badly; it is not merged at all.
--
-- WHAT 00119 ACTUALLY DID TO THE MERGE TOOL — AND IT IS A REGRESSION NOBODY
-- NOTICED. 00119 made two choices that are individually right and jointly
-- block a merge that used to work:
--
--   * a pair with no counted matches is ZEROED IN PLACE, NOT DELETED
--     (00119:244-253), and
--   * NO DELETE TRIGGER WAS ADDED (00119:708-718), so deleting a match does not
--     recompute anything.
--
-- Put those together with the guard, which counts ROWS and not history:
--
--     count(*) FROM head_to_head_stats WHERE player_a_id = p_remove OR ...
--
-- A member whose matches were DELETED rather than voided has no
-- match_participants rows left — the FK cascade took them — but still has a
-- head_to_head_stats row, which 00119's backfill has now dutifully zeroed. The
-- guard counts that zeroed row, and merge_players refuses with
-- "the account being removed has history — head_to_head_stats (1)". The account
-- has no history. It has a tombstone. And there is no console control anywhere
-- that can clear it, so the merge is refused permanently.
--
-- THAT IS THE CASE IN FRONT OF US: production has `wui KI Cheng` and
-- `Wui ki Cheng` waiting to be merged. If either carries such a row, the merge
-- fails with a message that accuses the account of history it does not have.
--
-- THE FIX IS TO COUNT WHAT THE GUARD MEANT: rows with an actual count, not rows
-- that exist. `AND total_matches > 0` / `AND matches_played > 0`. A zeroed row
-- is not history by any reading of 00079's intent, and the loser's row cascades
-- away with the DELETE regardless. THE GUARD IS NOT WIDENED ANY FURTHER — a
-- loser with real matches still refuses, on match_participants and on these two
-- tables alike, because refusing that is what the tool is for.
--
-- (previewPlayerMerge already filters to `row_count > 0` before rendering
-- (players.ts:431), so the console's blockers list loses the phantom row at the
-- same time and for the same reason.)
--
-- AND THE RECOMPUTE IS ADDED ANYWAY, in STEPS 5 and 7. It is insurance, not a
-- repair: with the guard in place it finds nothing to change and returns 0.
-- 00079 set exactly this precedent — its reliability-metric merge rules are
-- "written for correctness if that guard ever widens" (00079:33-34) — and the
-- day somebody does widen it, the counters will already be correct instead of
-- being the thing that was forgotten.
--
-- HOW IT HANDLES THE PAIR-KEY COLLISION, which is the thing that would go wrong:
--
--   * BOTH TABLES ARE UNIQUE ON A NORMALISED PAIR KEY with CHECK (player_a_id <
--     player_b_id) (00001:508-509, 526-527). If the loser had a row for
--     (loser, X) and the survivor a row for (survivor, X), REPOINTING the
--     loser's row would collide on that key and abort the whole merge. THIS
--     FUNCTION NEVER REPOINTS A ROW. The loser's rows are already gone —
--     CASCADE took them with `DELETE FROM players` — and the survivor's row is
--     then rebuilt from `matches`. One key is computed, one row is written per
--     pair, and there is no second row left to collide with it.
--
--   * THE (survivor, loser) PAIR COLLAPSES TO A SELF-PAIR. Any match the two
--     identities both played would, after a widened merge, name the survivor on
--     both sides. recompute_head_to_head_pair and recompute_partnership_pair
--     both return FALSE immediately when p_player_a = p_player_b (00119:376,
--     513) so nothing is written, and the stored (survivor, loser) row is gone
--     by CASCADE, so nothing is left behind claiming a member played themselves.
--
--   * RUNNING AFTER THE DELETE RATHER THAN BEFORE IS WHAT MAKES BOTH OF THOSE
--     TRUE. Before the delete, the loser's rows are still present and the sweep
--     would recompute pairs that are about to vanish.
--
-- ------------------------------------------------------------
-- FOUND AND NOT FIXED
-- ------------------------------------------------------------
--   * IF THE GUARD IS EVER WIDENED to let a loser with matches through, the
--     first thing it will hit is not these counters — it is
--     UNIQUE (match_id, player_id) on match_participants. Repointing the
--     loser's participant rows onto the survivor raises a unique violation for
--     any match BOTH identities played, and silently creates a self-pair for
--     any it does not catch. Whoever widens it has to decide what a match two
--     halves of the same person played even means. The recompute added here is
--     ready for that day; the repointing is not written, and should not be
--     written speculatively.
--
--   * 00119's ZERO-INSTEAD-OF-DELETE ROWS ARE STILL TOMBSTONES. Narrowing the
--     merge guard stops them blocking a merge, but a zeroed row still occupies
--     head_to_head_stats and still comes back on the leaderboard's
--     `.select('*')` (it sorts last and renders "0 matches", so nothing is
--     shown wrong). Reaping them would need the DELETE trigger 00119 declined
--     to write without being able to run SQL, and that reasoning has not
--     changed — this file runs none either.
--
--   * win_flag IS STILL NULL on the participants of an unrated admin-entered
--     match, exactly as 00119 recorded. Nothing here reads it.
--
--   * database.gen.ts IS GENERATED FROM THE LIVE DATABASE and will not show the
--     predicate's new argument list or recompute_player_stats until it is
--     regenerated after this file is applied. Nothing calls any of them through
--     .rpc() — they are reached by triggers and by merge_players — so both apps
--     type-check and build unchanged. A follow-up, not a prerequisite.
--
--   * THIS FILE DEPENDS ON matches.walkover_type CONTINUING TO EXIST. A
--     parallel migration (00122) drops columns and is not visible from here. If
--     it drops walkover_type, STEP 1's predicate stops compiling and the
--     walkover ruling has to be re-expressed on forfeit_player_id, which
--     apply_walkover_result sets on the same rows.
--
-- IDEMPOTENT throughout: DROP FUNCTION IF EXISTS, CREATE OR REPLACE FUNCTION,
-- and a backfill that is a recompute. No triggers are created — 00119's two
-- trigger OBJECTS are unchanged and keep pointing at the function names whose
-- bodies are replaced below. Running the whole file twice changes nothing the
-- second time and the notices say so.

-- 1. THE PREDICATE, STILL WRITTEN ONCE ---------------------------------------
-- DROP first: a second argument would otherwise be a second overload, leaving
-- the old body live for every existing caller. See the header.
DROP FUNCTION IF EXISTS public.match_counts_toward_stats(result_status);

CREATE OR REPLACE FUNCTION public.match_counts_toward_stats(
  p_result_status result_status,
  p_walkover_type walkover_type
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  -- 'confirmed' is unchanged from 00119. `walkover_type IS NULL` is the ruling:
  -- a forfeit is not an evening played. It excludes the rated walkovers that
  -- reach 'confirmed' through apply_match_result; the unrated ones sit at
  -- result_status = 'walkover' and were already excluded by the first test.
  SELECT p_result_status = 'confirmed'::result_status
     AND p_walkover_type IS NULL
$$;

COMMENT ON FUNCTION public.match_counts_toward_stats(result_status, walkover_type) IS
  'The single definition of "this match is in the head-to-head and partnership counters". Independent of rated_flag: an unrated match counts, exactly as it always has through apply_match_result''s casual branch (00119). Excludes every walkover, rated or not: a forfeit is a real result with real Elo and reliability consequences, but it is not a match anybody played, and these two tables describe play. See 00123.';

-- 2. HEAD-TO-HEAD ------------------------------------------------------------

-- Re-created from 00119 with two changes and nothing else:
--   * the predicate call carries m.walkover_type;
--   * player_a_points / player_b_points are DERIVED rather than left alone —
--     in the SELECT, the INSERT list, the VALUES, the SET list, BOTH SIDES of
--     the write guard, and the zero branch and its guard. All six, or the
--     column silently stays 0 while the backfill reports success.
CREATE OR REPLACE FUNCTION public.recompute_head_to_head_pair(
  p_player_a  UUID,
  p_player_b  UUID,
  p_match_type match_type_enum
) RETURNS BOOLEAN AS $$
DECLARE
  v_total    INTEGER;
  v_a_wins   INTEGER;
  v_b_wins   INTEGER;
  v_a_points INTEGER;
  v_b_points INTEGER;
  v_last     TIMESTAMPTZ;
  v_rows     INTEGER;
BEGIN
  IF p_player_a IS NULL OR p_player_b IS NULL OR p_player_a = p_player_b THEN
    RETURN FALSE;
  END IF;

  -- The table's CHECK is player_a_id < player_b_id (00001:509), so normalise
  -- rather than trust the caller. One level of recursion, never two.
  IF p_player_a > p_player_b THEN
    RETURN public.recompute_head_to_head_pair(p_player_b, p_player_a, p_match_type);
  END IF;

  -- Both players in the same match on OPPOSITE sides. In doubles that is the
  -- same set of (a-side x b-side) pairings the old FOREACH loop built, and it
  -- correctly excludes two players who were partners rather than opponents.
  --
  -- winner_side is nullable, and a confirmed match with no winner counts as a
  -- match played and a win for nobody.
  --
  -- ONE ROW PER SIDE FOR THE POINTS. pa is p_player_a's participant row and it
  -- already carries their TEAM's score, so this is the pair's points on each
  -- side. Not SUM(pa + pb) — that is the partnership function's deliberately
  -- double-counting port, and it would be wrong here. See the header.
  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE m.winner_side = pa.team_side),
         COUNT(*) FILTER (WHERE m.winner_side = pb.team_side),
         SUM(pa.points_scored),
         SUM(pb.points_scored),
         MAX(COALESCE(m.played_at, m.created_at))
    INTO v_total, v_a_wins, v_b_wins, v_a_points, v_b_points, v_last
    FROM public.matches m
    JOIN public.match_participants pa
      ON pa.match_id = m.id AND pa.player_id = p_player_a
    JOIN public.match_participants pb
      ON pb.match_id = m.id AND pb.player_id = p_player_b
   WHERE m.match_type = p_match_type
     AND pa.team_side <> pb.team_side
     AND public.match_counts_toward_stats(m.result_status, m.walkover_type);

  IF COALESCE(v_total, 0) = 0 THEN
    -- Nothing counted for this pair any more. Zero the row in place if it
    -- exists; never insert one. The points go to 0 with the counts — a row
    -- reading "0 matches, 231 points" is the half-truth 00119 exists to remove.
    UPDATE public.head_to_head_stats
       SET total_matches   = 0,
           player_a_wins   = 0,
           player_b_wins   = 0,
           player_a_points = 0,
           player_b_points = 0,
           last_played_at  = NULL,
           updated_at      = NOW()
     WHERE player_a_id = p_player_a
       AND player_b_id = p_player_b
       AND match_type  = p_match_type
       AND (total_matches, player_a_wins, player_b_wins,
            player_a_points, player_b_points, last_played_at)
           IS DISTINCT FROM (0, 0, 0, 0, 0, NULL::timestamptz);
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows > 0;
  END IF;

  INSERT INTO public.head_to_head_stats (
    player_a_id, player_b_id, match_type,
    total_matches, player_a_wins, player_b_wins,
    player_a_points, player_b_points, last_played_at
  )
  VALUES (
    p_player_a, p_player_b, p_match_type,
    v_total, v_a_wins, v_b_wins,
    COALESCE(v_a_points, 0), COALESCE(v_b_points, 0), v_last
  )
  ON CONFLICT (player_a_id, player_b_id, match_type) DO UPDATE
    SET total_matches   = EXCLUDED.total_matches,
        player_a_wins   = EXCLUDED.player_a_wins,
        player_b_wins   = EXCLUDED.player_b_wins,
        player_a_points = EXCLUDED.player_a_points,
        player_b_points = EXCLUDED.player_b_points,
        last_played_at  = EXCLUDED.last_played_at,
        updated_at      = NOW()
    -- A row that is already right is not written, so updated_at does not move
    -- and the backfill's notice counts changes rather than visits. THE POINTS
    -- ARE IN THIS TUPLE ON PURPOSE: without them a pair whose counts are
    -- already correct would never be written and the new columns would stay 0.
    WHERE (head_to_head_stats.total_matches,
           head_to_head_stats.player_a_wins,
           head_to_head_stats.player_b_wins,
           head_to_head_stats.player_a_points,
           head_to_head_stats.player_b_points,
           head_to_head_stats.last_played_at)
      IS DISTINCT FROM
          (EXCLUDED.total_matches,
           EXCLUDED.player_a_wins,
           EXCLUDED.player_b_wins,
           EXCLUDED.player_a_points,
           EXCLUDED.player_b_points,
           EXCLUDED.last_played_at);

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

-- 3. PARTNERSHIPS ------------------------------------------------------------

-- Re-created from 00119 with exactly ONE change: the predicate call carries
-- m.walkover_type. The arithmetic is untouched, including the two things 00119
-- kept as faithful ports rather than improvements — total_points_scored sums
-- BOTH partners and therefore doubles the team score, and losses is
-- matches - wins so a confirmed match with no winner_side is a loss. Changing
-- either here would smuggle a third semantic shift into a ruling about
-- walkovers.
--
-- win_rate stays 0-100 to two decimal places. Not 0-1. The renderer was fixed
-- on 2026-08-14 to stop multiplying by a hundred a second time
-- (apps/player/src/app/my-stats/page.tsx:852) and this is the convention it was
-- fixed to match.
CREATE OR REPLACE FUNCTION public.recompute_partnership_pair(
  p_player_a UUID,
  p_player_b UUID
) RETURNS BOOLEAN AS $$
DECLARE
  v_total     INTEGER;
  v_wins      INTEGER;
  v_scored    INTEGER;
  v_conceded  INTEGER;
  v_avg_delta NUMERIC;
  v_last      TIMESTAMPTZ;
  v_win_rate  NUMERIC;
  v_rows      INTEGER;
BEGIN
  IF p_player_a IS NULL OR p_player_b IS NULL OR p_player_a = p_player_b THEN
    RETURN FALSE;
  END IF;

  IF p_player_a > p_player_b THEN
    RETURN public.recompute_partnership_pair(p_player_b, p_player_a);
  END IF;

  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE m.winner_side = pa.team_side),
         SUM(pa.points_scored  + pb.points_scored),
         SUM(pa.points_allowed + pb.points_allowed),
         AVG((COALESCE(pa.rating_delta, 0) + COALESCE(pb.rating_delta, 0)) / 2.0),
         MAX(COALESCE(m.played_at, m.created_at))
    INTO v_total, v_wins, v_scored, v_conceded, v_avg_delta, v_last
    FROM public.matches m
    JOIN public.match_participants pa
      ON pa.match_id = m.id AND pa.player_id = p_player_a
    JOIN public.match_participants pb
      ON pb.match_id = m.id AND pb.player_id = p_player_b
   WHERE m.match_type = 'doubles'
     AND pa.team_side = pb.team_side
     AND public.match_counts_toward_stats(m.result_status, m.walkover_type);

  IF COALESCE(v_total, 0) = 0 THEN
    UPDATE public.partnership_stats
       SET matches_played        = 0,
           wins                  = 0,
           losses                = 0,
           win_rate              = 0,
           total_points_scored   = 0,
           total_points_conceded = 0,
           avg_elo_delta         = 0,
           last_played_at        = NULL,
           updated_at            = NOW()
     WHERE player_a_id = p_player_a
       AND player_b_id = p_player_b
       AND (matches_played, wins, losses, win_rate,
            total_points_scored, total_points_conceded, avg_elo_delta, last_played_at)
           IS DISTINCT FROM
           (0, 0, 0, 0::numeric, 0, 0, 0::numeric, NULL::timestamptz);
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows > 0;
  END IF;

  v_win_rate := ROUND(v_wins::NUMERIC / v_total * 100, 2);

  INSERT INTO public.partnership_stats (
    player_a_id, player_b_id,
    matches_played, wins, losses, win_rate,
    total_points_scored, total_points_conceded, avg_elo_delta, last_played_at
  )
  VALUES (
    p_player_a, p_player_b,
    v_total, v_wins, v_total - v_wins, v_win_rate,
    COALESCE(v_scored, 0), COALESCE(v_conceded, 0),
    ROUND(COALESCE(v_avg_delta, 0), 2), v_last
  )
  ON CONFLICT (player_a_id, player_b_id) DO UPDATE
    SET matches_played        = EXCLUDED.matches_played,
        wins                  = EXCLUDED.wins,
        losses                = EXCLUDED.losses,
        win_rate              = EXCLUDED.win_rate,
        total_points_scored   = EXCLUDED.total_points_scored,
        total_points_conceded = EXCLUDED.total_points_conceded,
        avg_elo_delta         = EXCLUDED.avg_elo_delta,
        last_played_at        = EXCLUDED.last_played_at,
        updated_at            = NOW()
    WHERE (partnership_stats.matches_played,
           partnership_stats.wins,
           partnership_stats.losses,
           partnership_stats.win_rate,
           partnership_stats.total_points_scored,
           partnership_stats.total_points_conceded,
           partnership_stats.avg_elo_delta,
           partnership_stats.last_played_at)
      IS DISTINCT FROM
          (EXCLUDED.matches_played,
           EXCLUDED.wins,
           EXCLUDED.losses,
           EXCLUDED.win_rate,
           EXCLUDED.total_points_scored,
           EXCLUDED.total_points_conceded,
           EXCLUDED.avg_elo_delta,
           EXCLUDED.last_played_at);

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

-- 4. THE TWO TRIGGER BODIES --------------------------------------------------
-- The trigger OBJECTS are 00119's and are not touched: on_match_confirmed
-- (00004) and on_match_participants_inserted (00119:741) both name these
-- functions, and replacing a function body is enough. Re-creating the triggers
-- would only risk dropping one and failing before the CREATE.

-- Unchanged from 00119 except that both sides of the comparison now pass
-- walkover_type. It still fires whenever the match CROSSES the predicate,
-- whichever way — that symmetry is what closes 00119's gaps 2 and 3 and is not
-- disturbed here.
--
-- For a walkover match the predicate is now FALSE on both sides of every
-- transition, so the trigger correctly never counts it. NEW.walkover_type and
-- OLD.walkover_type always agree, because apply_walkover_result sets the column
-- in its INSERT and nothing ever updates it.
CREATE OR REPLACE FUNCTION public.trigger_match_confirmed()
RETURNS TRIGGER AS $$
BEGIN
  IF public.match_counts_toward_stats(NEW.result_status, NEW.walkover_type)
     IS DISTINCT FROM public.match_counts_toward_stats(OLD.result_status, OLD.walkover_type) THEN
    PERFORM public.update_head_to_head(NEW.id);
    PERFORM public.update_partnership_stats(NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- Unchanged from 00119 except for the predicate call. Statement-level with a
-- transition table, because a doubles match sends four participant rows in one
-- statement and a row trigger would recompute four times against a half-built
-- team. It only ever acts on a match that is ALREADY counted, which is what
-- keeps it a no-op on every path that already works — and now also means
-- apply_walkover_result's participant INSERT no longer wakes it for the
-- 'walkover' rows it creates.
CREATE OR REPLACE FUNCTION public.trigger_match_participants_inserted()
RETURNS TRIGGER AS $$
DECLARE
  v_match_id UUID;
BEGIN
  FOR v_match_id IN
    SELECT DISTINCT n.match_id
      FROM new_participants n
      JOIN public.matches m ON m.id = n.match_id
     WHERE public.match_counts_toward_stats(m.result_status, m.walkover_type)
  LOOP
    PERFORM public.update_head_to_head(v_match_id);
    PERFORM public.update_partnership_stats(v_match_id);
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- 5. EVERY PAIR ONE PLAYER IS IN ---------------------------------------------
-- The player-scoped form of the backfill, so merge_players has one call to make
-- rather than a loop of its own. Returns the number of rows that actually
-- moved, so the merge can report it honestly instead of claiming work it did
-- not do.
--
-- IT DOES NOT FILTER THE FIRST ARM ON THE PREDICATE, and that is the one place
-- it differs from the backfill below. A pair whose matches no longer count
-- still needs visiting — to be zeroed, or to have stale points cleared — and a
-- pair with no row and no counted match is a cheap no-op, because the zero
-- branch only ever UPDATEs an existing row and never inserts one. A merge is a
-- rare manual operation; breadth costs nothing and missing a pair is silent.
CREATE OR REPLACE FUNCTION public.recompute_player_stats(p_player UUID)
RETURNS INTEGER AS $$
DECLARE
  v_pair    RECORD;
  v_changed INTEGER := 0;
BEGIN
  IF p_player IS NULL THEN
    RETURN 0;
  END IF;

  FOR v_pair IN
      SELECT LEAST(a.player_id, b.player_id)    AS player_a_id,
             GREATEST(a.player_id, b.player_id) AS player_b_id,
             m.match_type
        FROM public.matches m
        JOIN public.match_participants a ON a.match_id = m.id AND a.team_side = 'a'
        JOIN public.match_participants b ON b.match_id = m.id AND b.team_side = 'b'
       WHERE p_player IN (a.player_id, b.player_id)
    UNION
      SELECT h.player_a_id, h.player_b_id, h.match_type
        FROM public.head_to_head_stats h
       WHERE p_player IN (h.player_a_id, h.player_b_id)
  LOOP
    IF public.recompute_head_to_head_pair(
         v_pair.player_a_id, v_pair.player_b_id, v_pair.match_type) THEN
      v_changed := v_changed + 1;
    END IF;
  END LOOP;

  FOR v_pair IN
      SELECT LEAST(p1.player_id, p2.player_id)    AS player_a_id,
             GREATEST(p1.player_id, p2.player_id) AS player_b_id
        FROM public.match_participants p1
        JOIN public.match_participants p2
          ON p2.match_id = p1.match_id
         AND p2.team_side = p1.team_side
         AND p2.player_id <> p1.player_id
       WHERE p_player IN (p1.player_id, p2.player_id)
    UNION
      SELECT s.player_a_id, s.player_b_id
        FROM public.partnership_stats s
       WHERE p_player IN (s.player_a_id, s.player_b_id)
  LOOP
    IF public.recompute_partnership_pair(v_pair.player_a_id, v_pair.player_b_id) THEN
      v_changed := v_changed + 1;
    END IF;
  END LOOP;

  RETURN v_changed;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.recompute_player_stats(uuid) IS
  'Recomputes every head-to-head and partnership pair one player appears in, from matches + match_participants. Same functions the confirm trigger calls, so there is no separate repair logic to drift. Returns the number of rows that changed. Called by merge_players after the loser is deleted; safe to call by hand for one player.';

REVOKE ALL ON FUNCTION public.recompute_player_stats(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_player_stats(uuid) TO service_role;

-- 6. THE MERGE GUARD COUNTS HISTORY, NOT TOMBSTONES --------------------------
-- Reproduced from 00095:41 — the live definition, NOT 00079's, which still
-- named tournament_fees and reinstatement_fees before 00095 dropped those
-- tables. Two predicates added, nothing else changed.
--
-- Without this, 00119's zero-instead-of-delete rows are indistinguishable from
-- real history to a guard that counts rows, and a member whose matches were
-- deleted can never be merged. See the header.
CREATE OR REPLACE FUNCTION merge_players_preview(p_keep UUID, p_remove UUID)
RETURNS TABLE (table_name TEXT, row_count BIGINT, effect TEXT) AS $$
BEGIN
  RETURN QUERY
  SELECT t.tbl, t.n, CASE WHEN t.n > 0 THEN 'BLOCKS MERGE' ELSE 'ok' END
  FROM (
    SELECT 'match_participants'::TEXT AS tbl, count(*) AS n FROM match_participants WHERE player_id = p_remove
    UNION ALL SELECT 'challenge_participants', count(*) FROM challenge_participants WHERE player_id = p_remove
    UNION ALL SELECT 'challenges (created)',   count(*) FROM challenges WHERE created_by = p_remove
    UNION ALL SELECT 'session_attendance',     count(*) FROM session_attendance WHERE player_id = p_remove
    UNION ALL SELECT 'session_rsvp',           count(*) FROM session_rsvp WHERE player_id = p_remove
    UNION ALL SELECT 'tournament_participants',count(*) FROM tournament_participants WHERE player_id = p_remove
    UNION ALL SELECT 'tournament_pairs',       count(*) FROM tournament_pairs WHERE player1_id = p_remove OR player2_id = p_remove
    UNION ALL SELECT 'club_fees',              count(*) FROM club_fees WHERE player_id = p_remove
    -- total_matches > 0 / matches_played > 0: a ZEROED row is a tombstone, not
    -- history. 00119 zeroes rather than deletes and adds no DELETE trigger, so
    -- a member whose matches were deleted keeps a row here with nothing in it.
    -- A loser with real matches is still refused — by this line and by
    -- match_participants above.
    UNION ALL SELECT 'head_to_head_stats',     count(*) FROM head_to_head_stats WHERE (player_a_id = p_remove OR player_b_id = p_remove) AND total_matches > 0
    UNION ALL SELECT 'partnership_stats',      count(*) FROM partnership_stats WHERE (player_a_id = p_remove OR player_b_id = p_remove) AND matches_played > 0
    UNION ALL SELECT 'season_snapshots',       count(*) FROM season_snapshots WHERE player_id = p_remove
    UNION ALL SELECT 'season_final_ratings',   count(*) FROM season_final_ratings WHERE player_id = p_remove
    UNION ALL SELECT 'disputes (opened)',      count(*) FROM disputes WHERE opened_by = p_remove
    UNION ALL SELECT 'walkovers',              count(*) FROM walkovers WHERE forfeit_player_id = p_remove OR reported_by = p_remove
    UNION ALL SELECT 'event_feedback',         count(*) FROM event_feedback WHERE player_id = p_remove
    UNION ALL SELECT 'varsity_notes',          count(*) FROM varsity_notes WHERE player_id = p_remove OR author_id = p_remove
    UNION ALL SELECT 'legacy_tournament_participants', count(*) FROM legacy_tournament_participants WHERE player_id = p_remove OR partner_id = p_remove
  ) t
  ORDER BY t.n DESC, t.tbl;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- 7. THE MERGE SWEEPS THE SURVIVOR'S PAIRS -----------------------------------
-- Reproduced from 00095:77 — the live definition — with ONE statement added
-- after the delete and its count carried into the return value and the audit
-- log. plpgsql has no way to redefine part of a body; 00049 replaced the whole
-- of apply_walkover_result for the same reason. Everything else below is
-- verbatim.
--
-- WHY AFTER THE DELETE and how the pair-key collision is handled: see the
-- header. Short version — the loser's rows are gone by CASCADE before this
-- runs, so nothing is repointed, nothing can collide on the UNIQUE pair key,
-- and the (survivor, loser) self-pair is refused by the recompute functions'
-- own p_player_a = p_player_b guard.
--
-- WITH THE GUARD IN PLACE THIS RETURNS 0 TODAY. It is here for the day somebody
-- widens the guard, which is exactly the standard 00079 set for its own
-- reliability-metric rules (00079:33-34).
CREATE OR REPLACE FUNCTION public.merge_players(p_keep uuid, p_remove uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_blocking   TEXT;
  v_unhandled  TEXT;
  v_keep       players%ROWTYPE;
  v_remove     players%ROWTYPE;
  v_moved_user BOOLEAN := FALSE;
  v_kept       JSONB   := '{}'::jsonb;
  v_n          BIGINT;
  v_recomputed INTEGER := 0;
BEGIN
  IF p_keep = p_remove THEN
    RAISE EXCEPTION 'Cannot merge a player into themselves';
  END IF;

  SELECT * INTO v_keep   FROM players WHERE id = p_keep;
  SELECT * INTO v_remove FROM players WHERE id = p_remove;
  IF v_keep.id IS NULL  THEN RAISE EXCEPTION 'Surviving player % not found', p_keep; END IF;
  IF v_remove.id IS NULL THEN RAISE EXCEPTION 'Player to remove % not found', p_remove; END IF;

  -- Guard: a CASCADE column nobody has classified would be deleted silently.
  SELECT string_agg(format('%s.%s', tbl, col), ', ') INTO v_unhandled
    FROM merge_players_unhandled();
  IF v_unhandled IS NOT NULL THEN
    RAISE EXCEPTION
      'Refusing to merge: % has a CASCADE reference to players that merge_players does not handle. Classify it in 00079 (blocked, repointed, or disposable) before merging.',
      v_unhandled;
  END IF;

  -- Guard: refuse if the removed account carries real history.
  SELECT string_agg(format('%s (%s)', table_name, row_count), ', ')
    INTO v_blocking
    FROM merge_players_preview(p_keep, p_remove)
   WHERE row_count > 0;

  IF v_blocking IS NOT NULL THEN
    RAISE EXCEPTION
      'Refusing to merge: the account being removed has history — %. Merge the other direction, or clear these first.',
      v_blocking;
  END IF;

  -- Guard: two logins cannot be merged (see header — orphaned auth.users would
  -- re-onboard into a third player row).
  IF v_keep.user_id IS NOT NULL AND v_remove.user_id IS NOT NULL THEN
    RAISE EXCEPTION 'Both accounts have a login. Delete one auth user first, then merge.';
  END IF;

  -- ---- Repoint NO ACTION columns (DELETE would otherwise throw) ----
  UPDATE players                SET banned_by         = p_keep WHERE banned_by         = p_remove;
  UPDATE announcements          SET author_id         = p_keep WHERE author_id         = p_remove;
  UPDATE club_fees              SET marked_by         = p_keep WHERE marked_by         = p_remove;
  UPDATE tournament_audit_log   SET performed_by      = p_keep WHERE performed_by      = p_remove;
  UPDATE tournament_matches     SET result_entered_by = p_keep WHERE result_entered_by = p_remove;
  UPDATE tournament_pairs       SET added_by          = p_keep WHERE added_by          = p_remove;
  UPDATE tournament_pairs       SET checked_in_by     = p_keep WHERE checked_in_by     = p_remove;
  UPDATE tournament_participants SET added_by         = p_keep WHERE added_by          = p_remove;
  UPDATE tournament_participants SET checked_in_by    = p_keep WHERE checked_in_by     = p_remove;
  -- tournament_pairs.player1_id/player2_id are NO ACTION too, but the guard
  -- proved there are none for the removed player.

  -- ---- Repoint SET NULL columns (preserve attribution) ----
  UPDATE audit_logs             SET actor_id          = p_keep WHERE actor_id          = p_remove;
  UPDATE disputes               SET resolved_by       = p_keep WHERE resolved_by       = p_remove;
  UPDATE legacy_tournament_participants SET partner_id = p_keep WHERE partner_id       = p_remove;
  UPDATE legal_documents        SET updated_by        = p_keep WHERE updated_by        = p_remove;
  UPDATE matches                SET confirmed_by      = p_keep WHERE confirmed_by      = p_remove;
  UPDATE matches                SET forfeit_player_id = p_keep WHERE forfeit_player_id = p_remove;
  UPDATE matches                SET submitted_by      = p_keep WHERE submitted_by      = p_remove;
  UPDATE platform_settings      SET updated_by        = p_keep WHERE updated_by        = p_remove;
  UPDATE session_attendance     SET marked_by         = p_keep WHERE marked_by         = p_remove;
  UPDATE sessions               SET host_player_id    = p_keep WHERE host_player_id    = p_remove;
  UPDATE tournaments            SET created_by        = p_keep WHERE created_by        = p_remove;
  UPDATE walkovers              SET admin_confirmed_by = p_keep WHERE admin_confirmed_by = p_remove;

  -- ---- Repoint CASCADE rows worth keeping ----
  -- Each is guarded by NOT EXISTS on its unique key, so a row the survivor
  -- already has wins and the loser's duplicate is left to cascade away. A plain
  -- UPDATE would raise a unique violation and abort the whole merge.

  -- Signed waivers. The reason this matters most: consent is the one thing a
  -- self-signup duplicate definitely has, and losing it silently makes a member
  -- who did accept look like they never did.
  UPDATE waiver_acceptances w SET player_id = p_keep
   WHERE w.player_id = p_remove
     AND NOT EXISTS (SELECT 1 FROM waiver_acceptances k
                      WHERE k.player_id = p_keep AND k.document = w.document
                        AND k.version = w.version);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('waiver_acceptances', v_n); END IF;

  UPDATE event_waiver_acceptances e SET player_id = p_keep
   WHERE e.player_id = p_remove
     AND NOT EXISTS (SELECT 1 FROM event_waiver_acceptances k
                      WHERE k.player_id = p_keep AND k.tournament_id = e.tournament_id
                        AND k.waiver_hash = e.waiver_hash);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('event_waiver_acceptances', v_n); END IF;

  -- A passkey is a real credential the member enrolled; making them re-enrol
  -- after an admin merges their duplicate is a support ticket.
  UPDATE passkey_credentials SET player_id = p_keep WHERE player_id = p_remove;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('passkey_credentials', v_n); END IF;

  UPDATE announcement_reads a SET player_id = p_keep
   WHERE a.player_id = p_remove
     AND NOT EXISTS (SELECT 1 FROM announcement_reads k
                      WHERE k.player_id = p_keep AND k.announcement_id = a.announcement_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('announcement_reads', v_n); END IF;

  -- ---- Merge reliability metrics into the survivor ----
  -- Counters sum. avg_confirmation_minutes is weighted by matches_completed,
  -- because averaging two averages weights a 2-match sample like a 20-match one.
  -- walkover_flag is OR: merging must not be a way to clear a flag.
  UPDATE reliability_metrics k SET
    challenges_issued          = k.challenges_issued          + r.challenges_issued,
    challenges_accepted        = k.challenges_accepted        + r.challenges_accepted,
    challenges_rejected        = k.challenges_rejected        + r.challenges_rejected,
    challenges_expired         = k.challenges_expired         + r.challenges_expired,
    matches_completed          = k.matches_completed          + r.matches_completed,
    no_shows                   = k.no_shows                   + r.no_shows,
    late_cancellations         = k.late_cancellations         + r.late_cancellations,
    early_withdrawals          = k.early_withdrawals          + r.early_withdrawals,
    walkovers_received         = k.walkovers_received         + r.walkovers_received,
    dispute_involvement_count  = k.dispute_involvement_count  + r.dispute_involvement_count,
    walkover_flag              = COALESCE(k.walkover_flag, FALSE) OR COALESCE(r.walkover_flag, FALSE),
    avg_confirmation_minutes   = CASE
      WHEN COALESCE(k.matches_completed, 0) + COALESCE(r.matches_completed, 0) = 0
        THEN COALESCE(k.avg_confirmation_minutes, r.avg_confirmation_minutes)
      ELSE ( COALESCE(k.avg_confirmation_minutes, 0) * COALESCE(k.matches_completed, 0)
             + COALESCE(r.avg_confirmation_minutes, 0) * COALESCE(r.matches_completed, 0) )
           / NULLIF(COALESCE(k.matches_completed, 0) + COALESCE(r.matches_completed, 0), 0)
    END,
    updated_at = NOW()
  FROM reliability_metrics r
  WHERE k.player_id = p_keep AND r.player_id = p_remove;

  -- The survivor may have NO ratings / reliability row at all: init_player_records
  -- fires on a status UPDATE, not on INSERT, so a directly-inserted roster row
  -- never got one. The UPDATE above then matches nothing and the loser's row
  -- cascades away — which is how a test merge silently erased a walkover_flag,
  -- the exact laundering the OR rule exists to stop. Worse for ratings: the
  -- merged player would be left with no rating row whatsoever.
  --
  -- So: adopt the loser's row when the survivor has none. There is nothing to
  -- reconcile in that case, and the loser's row is strictly better than absent.
  UPDATE reliability_metrics SET player_id = p_keep
   WHERE player_id = p_remove
     AND NOT EXISTS (SELECT 1 FROM reliability_metrics k WHERE k.player_id = p_keep);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('reliability_metrics', v_n); END IF;

  UPDATE ratings SET player_id = p_keep
   WHERE player_id = p_remove
     AND NOT EXISTS (SELECT 1 FROM ratings k WHERE k.player_id = p_keep);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_kept := v_kept || jsonb_build_object('ratings', v_n); END IF;

  -- ---- Delete the loser, then adopt its login if the survivor had none ----
  -- Order matters: players.user_id and players.email are UNIQUE, so the row must
  -- be gone before the survivor can take its values.
  DELETE FROM players WHERE id = p_remove;

  -- The SURVIVOR's own fields always win — name, email, status, everything the
  -- admin entered on the roster record is preserved. We adopt only the login
  -- link (user_id), never the self-signup's name or email, so a member typing
  -- "Steven" at signup can't overwrite the admin's "Steven Sun" / SFU email.
  -- Auth identity lives in auth.users, so sign-in keeps working with whatever
  -- address they actually log in with, regardless of players.email.
  IF v_keep.user_id IS NULL AND v_remove.user_id IS NOT NULL THEN
    UPDATE players
       SET user_id = v_remove.user_id,
           onboarding_completed = TRUE
     WHERE id = p_keep;
    v_moved_user := TRUE;
  END IF;

  -- ---- NEW (00123): re-derive the survivor's counters ----
  -- AFTER the delete, so the loser's rows have already cascaded away and there
  -- is nothing to repoint, nothing to collide on the UNIQUE pair key, and no
  -- (survivor, loser) row left to become a self-pair. A recompute is idempotent,
  -- so running it on a merge that changed no matches is free and returns 0.
  v_recomputed := public.recompute_player_stats(p_keep);
  IF v_recomputed > 0 THEN
    v_kept := v_kept || jsonb_build_object('stats_pairs_recomputed', v_recomputed);
  END IF;

  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, old_value, new_value, reason)
  VALUES (
    p_actor, 'players_merged', 'player', p_keep,
    jsonb_build_object('removed_id', p_remove, 'removed_email', v_remove.email,
                       'removed_name', v_remove.full_name, 'removed_user_id', v_remove.user_id),
    jsonb_build_object('kept_id', p_keep, 'kept_email', v_keep.email,
                       'login_moved', v_moved_user, 'rows_retained', v_kept),
    'Duplicate account merged'
  );

  RETURN jsonb_build_object('kept_id', p_keep, 'removed_id', p_remove,
                            'login_moved', v_moved_user, 'rows_retained', v_kept,
                            'stats_pairs_recomputed', v_recomputed);
END;
$function$;

COMMENT ON FUNCTION public.merge_players(uuid, uuid, uuid) IS
  'Merges a duplicate player into a survivor. Refuses if the loser has matches, money or tournament history, or if the schema has a CASCADE reference to players that this function does not classify. Waivers, event waivers, passkeys and announcement reads are repointed rather than deleted; reliability metrics are merged (counters sum, confirmation time weighted, walkover flag OR-ed); the survivor''s head-to-head and partnership pairs are re-derived after the delete (00123).';

-- 8. THE BACKFILL, WHICH REPORTS WHAT IT MOVED -------------------------------
-- The same UNION 00119 used, calling the same functions the triggers call.
-- There is no separate repair logic that could be subtly different from the live
-- path — that is the whole reason to derive rather than accumulate.
--
-- TWO THINGS MOVE THIS TIME, and the notices name both before and after:
--
--   * every rated late-notice walkover sitting at 'confirmed' stops counting,
--     so some pairs' totals go DOWN. The count of those matches is printed
--     BEFORE anything is written, so the drop is visible rather than
--     discovered later on a card;
--   * player_a_points / player_b_points go from 0 to the real figure on
--     essentially every head_to_head_stats row, so the "rows CHANGED" number
--     for that table will be close to its row count on the first run. That is
--     the fix, not a regression.
--
-- Partnership rows change only where a walkover was involved, because nothing
-- else about that function moved.
--
-- NOT WRAPPED IN AN EXPLICIT TRANSACTION: the file is piped into psql, which
-- wraps each statement, and this DO block is one statement. Either it completes
-- or it rolls back whole.
DO $$
DECLARE
  v_pair      RECORD;
  v_seen      INTEGER := 0;
  v_changed   INTEGER := 0;
  v_zeroed    INTEGER := 0;
  v_counted   INTEGER;
  v_walkovers INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_counted
    FROM public.matches m
   WHERE public.match_counts_toward_stats(m.result_status, m.walkover_type);

  -- The blast radius of the ruling, stated before it is applied.
  SELECT COUNT(*) INTO v_walkovers
    FROM public.matches m
   WHERE m.result_status = 'confirmed'::result_status
     AND m.walkover_type IS NOT NULL;

  RAISE NOTICE '00123: % matches count toward the stats tables', v_counted;
  RAISE NOTICE '00123: % walkover match(es) were sitting at result_status = ''confirmed'' and counted until now. They STOP counting. Head-to-head totals for the pairs involved go DOWN by that much. This is the ruling in ARGUMENT A of this file''s header, not a bug.', v_walkovers;

  -- ---- head to head ----
  FOR v_pair IN
      SELECT LEAST(a.player_id, b.player_id)    AS player_a_id,
             GREATEST(a.player_id, b.player_id) AS player_b_id,
             m.match_type
        FROM public.matches m
        JOIN public.match_participants a ON a.match_id = m.id AND a.team_side = 'a'
        JOIN public.match_participants b ON b.match_id = m.id AND b.team_side = 'b'
       WHERE public.match_counts_toward_stats(m.result_status, m.walkover_type)
    UNION
      SELECT h.player_a_id, h.player_b_id, h.match_type
        FROM public.head_to_head_stats h
  LOOP
    v_seen := v_seen + 1;
    IF public.recompute_head_to_head_pair(
         v_pair.player_a_id, v_pair.player_b_id, v_pair.match_type) THEN
      v_changed := v_changed + 1;
    END IF;
  END LOOP;

  SELECT COUNT(*) INTO v_zeroed FROM public.head_to_head_stats WHERE total_matches = 0;
  RAISE NOTICE '00123: head_to_head_stats — % pairs examined, % rows CHANGED (expect most of them on the first run: player_a_points / player_b_points were 0 on every row and are now derived), % rows now sitting at zero (a total, not a delta — a clean re-run reports the same figure with 0 changed)',
    v_seen, v_changed, v_zeroed;

  -- ---- partnerships ----
  v_seen := 0;
  v_changed := 0;
  FOR v_pair IN
      SELECT LEAST(p1.player_id, p2.player_id)    AS player_a_id,
             GREATEST(p1.player_id, p2.player_id) AS player_b_id
        FROM public.matches m
        JOIN public.match_participants p1 ON p1.match_id = m.id
        JOIN public.match_participants p2
          ON p2.match_id = m.id
         AND p2.team_side = p1.team_side
         AND p2.player_id <> p1.player_id
       WHERE m.match_type = 'doubles'
         AND public.match_counts_toward_stats(m.result_status, m.walkover_type)
    UNION
      SELECT s.player_a_id, s.player_b_id
        FROM public.partnership_stats s
  LOOP
    v_seen := v_seen + 1;
    IF public.recompute_partnership_pair(v_pair.player_a_id, v_pair.player_b_id) THEN
      v_changed := v_changed + 1;
    END IF;
  END LOOP;

  SELECT COUNT(*) INTO v_zeroed FROM public.partnership_stats WHERE matches_played = 0;
  RAISE NOTICE '00123: partnership_stats — % pairs examined, % rows CHANGED (only pairs whose matches included a walkover should move), % rows now sitting at zero (a total, not a delta — a clean re-run reports the same figure with 0 changed)',
    v_seen, v_changed, v_zeroed;

  RAISE NOTICE '00123: re-running this file will report 0 rows changed. If it does not, something is still writing these tables outside update_head_to_head / update_partnership_stats.';
END;
$$;
