-- ============================================================
-- 00119_stats_counters_are_derived.sql — head-to-head and partnership stop
-- being a running total nobody can audit and start being a view of the matches
-- ============================================================
-- WHAT IS WRONG TODAY, and 00114 wrote both of these down without fixing them
-- (00114:319-329) because they were not that file's job. This is that job.
--
--   GAP 1 — AN UNRATED ADMIN-ENTERED MATCH IS NEVER COUNTED AT ALL.
--     adminCreateMatch (apps/admin/src/lib/actions/matches.ts) INSERTs an
--     unrated match with result_status ALREADY 'confirmed', because there is
--     no Elo to apply and therefore no reason to route it through
--     apply_match_result. The only thing that has ever written
--     head_to_head_stats or partnership_stats is on_match_confirmed
--     (00004:70), which is `AFTER UPDATE OF result_status`. An AFTER UPDATE
--     trigger does not fire on an INSERT. So a row born confirmed is never
--     counted, by anything, ever.
--
--   GAP 2 — VOIDING NEVER GIVES THE COUNT BACK. reverse_match_result
--     (00003:708) unwinds every participant's Elo and flips the match to
--     'voided', and touches neither counter table. A voided match therefore
--     stays in "we have played 8 times" forever. Same for the every other
--     way out of 'confirmed'.
--
--   GAP 3, WHICH NOBODY HAD WRITTEN DOWN, and it is the same bug pointing the
--     other way: a CONFIRMED match can be disputed. dispute_match_result
--     (00027:72) accepts `result_status IN ('pending_confirmation',
--     'confirmed')`, and resolveDispute's `accepted` and `edited` branches
--     (apps/admin/src/lib/actions/disputes.ts:39-95) then put the match back
--     to 'pending_confirmation' and call apply_match_result, which flips it to
--     'confirmed' again — firing on_match_confirmed a SECOND time and adding a
--     SECOND count for one match. Both branches carry the comment "the match
--     was disputed (never confirmed)", which is true of the common case and
--     false of the case that inflates the numbers. The `edited` branch is
--     worse than a double count: it can also change `winner_side`, so the two
--     counts disagree about who won.
--
-- THE THREE ARE ONE BUG. Every one of them is "an increment fired, or failed
-- to fire, at a moment that does not correspond to the fact being counted".
-- That is what a running total buys you: the number is a history of the writes
-- rather than a statement about the matches, and there is no way to look at a
-- row and tell whether it is right.
--
-- ------------------------------------------------------------
-- DO UNRATED MATCHES COUNT? YES — AND THAT IS NOT A NEW DECISION
-- ------------------------------------------------------------
-- This had to be settled before anything could be written, because "an unrated
-- match is not part of your head-to-head record" is a perfectly defensible
-- club rule and gap 1 would then be correct behaviour reached by accident.
--
-- IT IS NOT. The rest of the schema already answers it, and answers YES:
--
--   * apply_match_result's casual branch (00003:323) skips Elo entirely and
--     then still runs `UPDATE matches SET result_status = 'confirmed'`, which
--     fires on_match_confirmed. An unrated CHALLENGE match is counted today,
--     by a path written on purpose.
--
--   * convertMatchToCasual says so out loud. Its never-confirmed branch
--     (matches.ts:202-210) demotes the match to casual and calls
--     apply_match_result, commented "apply_match_result skips Elo for
--     event_type 'casual' but still confirms the result and updates
--     head-to-head once". Counting an unrated match is the documented,
--     intended outcome of an exec's deliberate action.
--
--   * NOTHING ANYWHERE FILTERS THESE TABLES ON rated_flag. Not
--     update_head_to_head, not update_partnership_stats, not
--     /my-stats, not /leaderboard/[playerId]. head_to_head_stats does not even
--     carry the column; the only thing it partitions by is `match_type`.
--
--   * The counters are DESCRIPTIVE, not rating state. "You have played Bob 8
--     times, 5-3" is a fact about the evenings, and `ratings` is where rating
--     state lives. A member who plays six casual games with the same partner
--     has a partnership; a card that says otherwise is wrong about the season
--     they actually had.
--
-- So the admin-created unrated match is the SOLE outlier, and it is an
-- accident of trigger shape (AFTER UPDATE vs INSERT) rather than a rule. This
-- file makes it agree with every other unrated match in the club.
--
-- THE PREDICATE IS UNCHANGED IN SUBSTANCE: `result_status = 'confirmed'`,
-- which is exactly what on_match_confirmed has always tested. It is written
-- ONCE, below, as match_counts_toward_stats(), so that whatever else moves,
-- the confirm path, the reversal path and the backfill can never come to
-- disagree about which matches are in the count. Everything else keeps
-- behaving as it does today — including two things this file deliberately does
-- NOT change: tournament results live in `tournament_matches` and never touch
-- these tables at all, and unrated walkovers sit at result_status = 'walkover'
-- and have never counted (see FOUND AND NOT FIXED).
--
-- ------------------------------------------------------------
-- THE FIX: DERIVE, DO NOT ACCUMULATE
-- ------------------------------------------------------------
-- update_head_to_head() and update_partnership_stats() keep their names and
-- their signatures — they are still the single owners of these two tables, so
-- the "calling this here as well would double-count" comments in 00003:459,
-- 00019:198, 00028:268 and 00041:315 all stay TRUE. What changes is what they
-- do inside. Instead of `+ 1`, they find the pairs that the given match
-- involves and RECOMPUTE each of those pairs from `matches` and
-- `match_participants`.
--
-- That one change does the work of four separate guards:
--
--   IDEMPOTENCE IS FREE. A double confirm, a re-run, two triggers both firing
--   for the same match — all recompute the same pairs from the same rows and
--   land on the same numbers. There is no counter to advance twice. This is
--   why gap 3 closes without anybody having to reason about dispute state
--   machines.
--
--   REVERSAL IS THE SAME OPERATION AS CONFIRMATION. Nothing subtracts. Voiding
--   a match takes it out of the predicate and the recompute simply does not
--   see it any more. So gap 2 is fixed by the recompute, not by a decrement.
--
--   UNDERFLOW IS NOT GUARDED AGAINST, IT IS IMPOSSIBLE. There is no `- 1`
--   anywhere in this file. Voiding one of gap 1's matches — a match that was
--   never counted, because it was created before this migration ran — cannot
--   take a counter negative, because the reversal path recounts from zero
--   rather than subtracting from whatever happens to be stored. A COUNT(*)
--   cannot return a negative number.
--
--   HISTORY REPAIRS ITSELF. The backfill at the end of this file is the same
--   function applied to every pair, so the code that fixes today's rows is the
--   code that keeps tomorrow's right. There is no separate one-shot repair
--   script that can be subtly different from the live path.
--
-- WHAT IT COSTS, stated honestly: CONCURRENCY. Two overlapping confirmations
-- involving the same pair can interleave read-recompute-write and lose one of
-- the two results, where `+ 1` was safe by construction. Two things make that
-- acceptable here. Each pair's write is a single INSERT ... ON CONFLICT DO
-- UPDATE whose SET list is computed before the statement, so the row lock
-- covers the write; and — the real answer — a recompute is SELF-HEALING. A
-- lost update is transient: the next confirmation, void or dispute touching
-- that pair recomputes from source and the number is right again. Incremental
-- drift is permanent, which is precisely the state this migration is cleaning
-- up. A club that plays a few hundred matches a season is not going to race
-- two confirmations of the same pair to the microsecond, and if it did, the
-- damage self-corrects.
--
-- Also: because the functions no longer accumulate, `authenticated` calling
-- update_head_to_head() directly can no longer inflate anything. 00018 never
-- revoked EXECUTE on these two (it revoked reverse_match_result and
-- apply_match_result), and 00027's REVOKE covers `matches` /
-- `match_participants` / `match_games` but not `head_to_head_stats`. So a
-- member could call update_head_to_head('<any match id>') repeatedly and add a
-- count per call. After this file the same calls are a no-op recompute. That
-- is a side effect, not the reason for the change, and the grants are left
-- exactly as they are rather than tightened in a data-integrity migration.
--
-- ------------------------------------------------------------
-- WHY THIS IS SQL AND NOT TYPESCRIPT
-- ------------------------------------------------------------
-- Gap 2 and gap 3 are only reachable in SQL: the void is a database function
-- and the double count comes out of a database trigger. Gap 1 could have been
-- fixed in the console alone — make adminCreateMatch insert the unrated match
-- as 'pending_confirmation' and flip it to 'confirmed' at the end — and that
-- change IS made, in the same commit, because it is the right shape for that
-- action anyway. But it is not the fix, because `service_role` can INSERT a
-- confirmed match through PostgREST from any code path anybody writes later,
-- and a rule that lives only in one call site is a rule that lasts until the
-- second call site. So the database closes it too, with the trigger in step 4.
--
-- THE TWO CANNOT DRIFT, and the reason is an invariant rather than a promise.
-- After the console change, adminCreateMatch INSERTs a rated match as
-- 'pending_confirmation' and an unrated one as 'incomplete' — NEITHER IS
-- 'confirmed' — and its failure cleanup (discardIncompleteMatch) is scoped
-- `.eq('result_status', expectedStatus)` on whichever of the two it used. The
-- trigger in step 4b only ever acts on a match that is ALREADY 'confirmed'.
-- Those two sets are disjoint by construction, so the cleanup can never delete
-- a match whose counters have been written, in either order, no matter which
-- of the two lands on a given database first. That is also the answer to the
-- deploy-order question: migration-first and code-first are both safe.
--
-- (The unrated one is 'incomplete' rather than 'pending_confirmation' for a
-- reason that has nothing to do with this file and everything to do with not
-- opening a third hole while closing two. apply_match_result decides whether
-- to apply Elo on event_type, not on rated_flag, and 'admin_entered' is not
-- 'casual'; its only other gate is result_status = 'pending_confirmation'. An
-- UNRATED match parked at that status is one participant-only RPC away from
-- being rated. 'incomplete' is refused by apply_match_result,
-- dispute_match_result and reverse_match_result alike, and is already what
-- submit_match_result uses for a match row that is not a finished result. The
-- reasoning is written out at the call site.)
--
--   MIGRATION FIRST, CODE LATER. The old console still inserts unrated
--   matches confirmed-first. The step 4 trigger counts them when the
--   participants land — which is the fix working, a version early. The only
--   exposure is the narrow one above: if the GAME insert then fails and the
--   match is discarded, the counters keep a match that no longer exists. That
--   window is the current console's, it is seconds wide, it needs a database
--   error to open at all, and the next confirm or void touching either player
--   recomputes it away. Deploying the console closes it permanently.
--
--   CODE FIRST, MIGRATION LATER. The console inserts the match unconfirmed,
--   flips it to confirmed at the end, and the EXISTING on_match_confirmed
--   trigger fires on that flip — so unrated admin matches start counting
--   correctly with no database change at all. Gaps 2 and 3 stay open until
--   this file is run.
--
-- ------------------------------------------------------------
-- THE BACKFILL IS A REWRITE, AND IT SAYS SO OUT LOUD
-- ------------------------------------------------------------
-- Existing rows are wrong and this file recomputes them. That is the honest
-- fix — the club is pre-release, the data is small, and leaving known-wrong
-- numbers in place while shipping the machinery to keep them right is the
-- worst of both. But a recompute is NOT a narrow correction of the broken
-- rows, and pretending otherwise would be the "silent mass rewrite" that must
-- not happen. Three columns change meaning for essentially every row:
--
--   last_played_at was `NOW()` — the moment somebody pressed confirm. It is
--     now MAX(COALESCE(played_at, created_at)) over the counted matches: when
--     they actually last played. played_at is nullable (00001:394), hence the
--     COALESCE; created_at is NOT NULL, so the result is never NULL for a pair
--     with at least one counted match.
--
--   avg_elo_delta was a running mean ROUNDed to 2dp at every step, so it
--     carried accumulated rounding drift. It is now one AVG over the counted
--     matches. Same quantity, no drift, slightly different number.
--
--   win_rate had a REAL BUG that this fixes as a side effect: the INSERT arm
--     of update_partnership_stats never listed the column, so a pair's FIRST
--     match left win_rate at its DEFAULT 0. Only the ON CONFLICT arm computed
--     it. Every partnership therefore under-reported until its second match,
--     and /my-stats orders the Best Partners card by win_rate — so the card
--     WILL REORDER after this runs, and that is the fix, not a regression.
--
--   head_to_head_stats.last_played_at had the SAME omission, in the same
--     shape: its INSERT arm listed only the ids, the match_type and the three
--     counts, so a pair's FIRST meeting left the column NULL and only their
--     second set it. Nothing renders it today, which is why it went unnoticed.
--
--   *** win_rate IS STORED 0-100, NOT 0-1, AND STAYS THAT WAY. *** The
--   ON CONFLICT arm multiplied by 100 and the renderer was fixed on
--   2026-08-14 to stop multiplying again (apps/player/src/app/my-stats/
--   page.tsx:852 carries the note). The ROUND(... * 100, 2) below preserves
--   that convention exactly. Changing it would silently divide every
--   partnership win rate by a hundred on a screen that has already been
--   burned by this once.
--
-- SO THE BACKFILL REPORTS ITS OWN BLAST RADIUS. It RAISEs NOTICE with pairs
-- examined, rows written and rows zeroed, per table, so that piping this into
-- psql shows how much moved instead of hiding it. Every write is additionally
-- guarded `IS DISTINCT FROM` the value already there, so a row that is already
-- right is not touched at all and its updated_at does not move — the notice
-- counts real changes, not statements executed.
--
-- ROWS FOR PAIRS THAT NO LONGER HAVE ANY COUNTED MATCH ARE ZEROED, NOT
-- DELETED. Less destructive, no race with a concurrent upsert re-creating the
-- row, and harmless to every reader: /my-stats filters partnerships to
-- `matches_played >= 3` and orders head-to-head by total_matches, so a zeroed
-- row sorts last and draws nothing. A DELETE would also throw away
-- head_to_head_stats.id, which nothing depends on today but which is the sort
-- of thing that is annoying to have destroyed. In the zero case last_played_at
-- goes to NULL along with the counts, because that is what the recompute
-- actually returns — MAX over no rows — and a row saying "0 matches, last
-- played in March" is the kind of half-truth this file exists to remove.
--
-- ------------------------------------------------------------
-- ONE MATCH CHANGES SIDES, AND IT IS A DECISION RATHER THAN A CONSEQUENCE
-- ------------------------------------------------------------
-- convertMatchToCasual, on an ALREADY-CONFIRMED match, calls
-- reverse_match_result (which sets result_status = 'voided') and then sets
-- rated_flag = FALSE and event_type = 'casual'. The status STAYS 'voided' —
-- the comment at matches.ts:184 explains that the voided-plus-casual-flags
-- outcome was kept deliberately.
--
-- Today such a match stays in the counters, because nothing ever took it out.
-- After this file it is EXCLUDED, because 'voided' is not 'confirmed'.
--
-- That is deliberate and it is worth arguing with, because it looks like it
-- contradicts the ruling above. It does not: the ruling is that UNRATED
-- matches count, and this match is not excluded for being unrated. It is
-- excluded for being VOIDED, which is what an exec chose when they used a
-- control whose whole job is to undo a result. "Voided does not count" is a
-- cleaner rule than "voided counts if it was voided as part of a demotion",
-- and the alternative would need the predicate to reach past result_status
-- into the reason the status got there.
--
-- IF THE OWNER WANTS THE OTHER ANSWER, the change is not to this file: it is
-- for convertMatchToCasual to leave the match confirmed rather than voided on
-- that branch, which is now SAFE in a way it was not before. That branch's
-- comment says the voided outcome avoids "re-firing the on_match_confirmed
-- stats trigger" — THAT REASON IS NOW STALE. Re-firing the trigger cannot
-- double-count anything any more; a recompute run twice is a recompute. The
-- constraint that shaped that code no longer exists, and the next person to
-- read it should know that before they design around it.
--
-- ------------------------------------------------------------
-- FOUND AND NOT FIXED
-- ------------------------------------------------------------
--   * UNRATED WALKOVERS NEVER COUNT, RATED ONES DO. apply_walkover_result
--     (00003:485) sends a walkover through 'pending_confirmation' ->
--     'confirmed' when Elo applies, and straight to result_status = 'walkover'
--     when it does not. 'walkover' is not 'confirmed', so the second kind is
--     invisible to these counters while the first kind is counted. That is
--     inconsistent with the ruling above, and it is deliberately left alone:
--     whether a forfeit belongs in "we have played 8 times" at all is a club
--     question, not a schema question, and answering it here would change the
--     numbers for a reason this file is not about. If the answer is yes, the
--     one-line change is to match_counts_toward_stats() and the backfill will
--     carry it through every historical row.
--
--   * merge_players (00079) REASSIGNS match_participants.player_id and
--     re-points head_to_head_stats / partnership_stats rows at the surviving
--     player. Nothing recomputes afterwards, so a merge can leave two rows for
--     what is now one pair, or a row whose counts double-count matches both
--     identities played. The tool has never actually been run. The repair, if
--     it ever is, is to call the two functions below for each affected match —
--     but wiring that into 00079's rewrite loop is a change to the merge tool
--     and belongs with it.
--
--   * head_to_head_stats.player_a_points / player_b_points have NEVER been
--     written by anything and are 0 on every row. The data to fill them is
--     right there in match_participants.points_scored. They are deliberately
--     NOT filled here: nothing reads them (/my-stats and
--     /leaderboard/[playerId] both select only the win counts and
--     total_matches), so filling them would widen an already-wide rewrite to
--     no reader's benefit. The recompute below leaves them exactly as it finds
--     them.
--
--   * win_flag stays NULL on the participants of an unrated admin-entered
--     match, because apply_match_result — the only thing that sets it — never
--     runs for one. These counters do not read win_flag (they derive the
--     result from matches.winner_side, which IS set), so it does not affect
--     anything here, but /my-stats does read it per participant.
--
--   * packages/shared/src/types/database.gen.ts is generated FROM the live
--     database, so the three new functions below will not appear in it until
--     somebody regenerates it after this file is applied. Nothing calls any of
--     them through .rpc() — they are reached only by the two triggers — so the
--     apps type-check and build unchanged today. Regenerating is a follow-up,
--     not a prerequisite.
--
-- IDEMPOTENT throughout: CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS
-- before CREATE TRIGGER (the portable form — CREATE OR REPLACE TRIGGER is
-- version-dependent and this file does not need it), and a backfill that is a
-- recompute, which is the definition of idempotent. Running the whole file
-- twice changes nothing the second time and the notices will say so.

-- 1. THE PREDICATE, WRITTEN ONCE ---------------------------------------------
-- Which matches are in the count. Every other statement in this file, and both
-- triggers, ask this function rather than spelling out the comparison, so
-- there is exactly one place to change if the club ever decides differently
-- (see the walkover note above) and no way for the confirm path, the reversal
-- path and the backfill to end up disagreeing.
--
-- It takes the status rather than the match row: a rowtype parameter would
-- pin this function to the shape of `matches`, and 00117 already has a
-- follow-up queued that drops a column from it.
CREATE OR REPLACE FUNCTION public.match_counts_toward_stats(p_result_status result_status)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT p_result_status = 'confirmed'::result_status
$$;

COMMENT ON FUNCTION public.match_counts_toward_stats(result_status) IS
  'The single definition of "this match is in the head-to-head and partnership counters". Deliberately independent of rated_flag: an unrated match counts, exactly as it always has through apply_match_result''s casual branch. See 00119.';

-- 2. HEAD-TO-HEAD ------------------------------------------------------------

-- One pair, one match_type, recomputed from scratch. Returns TRUE if the
-- stored row actually moved, which is what lets the backfill report a real
-- blast radius rather than a statement count.
CREATE OR REPLACE FUNCTION public.recompute_head_to_head_pair(
  p_player_a  UUID,
  p_player_b  UUID,
  p_match_type match_type_enum
) RETURNS BOOLEAN AS $$
DECLARE
  v_total  INTEGER;
  v_a_wins INTEGER;
  v_b_wins INTEGER;
  v_last   TIMESTAMPTZ;
  v_rows   INTEGER;
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
  -- match played and a win for nobody — which is what the old CASE expressions
  -- did too, by falling through to ELSE 0 on both sides.
  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE m.winner_side = pa.team_side),
         COUNT(*) FILTER (WHERE m.winner_side = pb.team_side),
         MAX(COALESCE(m.played_at, m.created_at))
    INTO v_total, v_a_wins, v_b_wins, v_last
    FROM public.matches m
    JOIN public.match_participants pa
      ON pa.match_id = m.id AND pa.player_id = p_player_a
    JOIN public.match_participants pb
      ON pb.match_id = m.id AND pb.player_id = p_player_b
   WHERE m.match_type = p_match_type
     AND pa.team_side <> pb.team_side
     AND public.match_counts_toward_stats(m.result_status);

  IF COALESCE(v_total, 0) = 0 THEN
    -- Nothing counted for this pair any more. Zero the row in place if it
    -- exists; never insert one. See the header on zero-vs-delete.
    UPDATE public.head_to_head_stats
       SET total_matches  = 0,
           player_a_wins  = 0,
           player_b_wins  = 0,
           last_played_at = NULL,
           updated_at     = NOW()
     WHERE player_a_id = p_player_a
       AND player_b_id = p_player_b
       AND match_type  = p_match_type
       AND (total_matches, player_a_wins, player_b_wins, last_played_at)
           IS DISTINCT FROM (0, 0, 0, NULL::timestamptz);
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows > 0;
  END IF;

  -- player_a_points / player_b_points are deliberately absent from both the
  -- INSERT list and the SET list — see FOUND AND NOT FIXED. Leaving them out
  -- of the SET is what makes this a no-op for them rather than a reset.
  INSERT INTO public.head_to_head_stats (
    player_a_id, player_b_id, match_type,
    total_matches, player_a_wins, player_b_wins, last_played_at
  )
  VALUES (
    p_player_a, p_player_b, p_match_type,
    v_total, v_a_wins, v_b_wins, v_last
  )
  ON CONFLICT (player_a_id, player_b_id, match_type) DO UPDATE
    SET total_matches  = EXCLUDED.total_matches,
        player_a_wins  = EXCLUDED.player_a_wins,
        player_b_wins  = EXCLUDED.player_b_wins,
        last_played_at = EXCLUDED.last_played_at,
        updated_at     = NOW()
    -- A row that is already right is not written, so updated_at does not move
    -- and the backfill's notice counts changes rather than visits.
    WHERE (head_to_head_stats.total_matches,
           head_to_head_stats.player_a_wins,
           head_to_head_stats.player_b_wins,
           head_to_head_stats.last_played_at)
      IS DISTINCT FROM
          (EXCLUDED.total_matches,
           EXCLUDED.player_a_wins,
           EXCLUDED.player_b_wins,
           EXCLUDED.last_played_at);

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

-- SAME NAME, SAME SIGNATURE, SAME SINGLE OWNERSHIP — a different body. Every
-- caller and every comment that names this function stays correct; it simply
-- no longer accumulates. It takes a match and recomputes the pairs that match
-- involves, WITHOUT asking whether the match itself counts: on the reversal
-- path the match has already been voided by the time this runs, and the pairs
-- still have to be found in order to be recounted without it.
CREATE OR REPLACE FUNCTION public.update_head_to_head(p_match_id UUID) RETURNS VOID AS $$
DECLARE
  v_pair RECORD;
BEGIN
  FOR v_pair IN
    SELECT DISTINCT
           LEAST(a.player_id, b.player_id)    AS player_a_id,
           GREATEST(a.player_id, b.player_id) AS player_b_id,
           m.match_type
      FROM public.matches m
      JOIN public.match_participants a ON a.match_id = m.id AND a.team_side = 'a'
      JOIN public.match_participants b ON b.match_id = m.id AND b.team_side = 'b'
     WHERE m.id = p_match_id
  LOOP
    PERFORM public.recompute_head_to_head_pair(
      v_pair.player_a_id, v_pair.player_b_id, v_pair.match_type
    );
  END LOOP;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

-- 3. PARTNERSHIPS ------------------------------------------------------------

-- Doubles only, and only pairs who played on the SAME side.
--
-- THE ARITHMETIC IS A FAITHFUL PORT, not an improvement, everywhere it could
-- have been either. total_points_scored sums BOTH partners' points_scored,
-- which double-counts the team's points because each partner's row carries the
-- team score — that is what the old running total did, nothing reads the
-- column, and changing it here would be a third semantic shift smuggled into a
-- correctness fix. losses is matches - wins, so a confirmed match with no
-- winner_side is a loss, exactly as `CASE WHEN v_won THEN 0 ELSE 1 END` made
-- it. Only win_rate, avg_elo_delta and last_played_at change, for the reasons
-- in the header.
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
     AND public.match_counts_toward_stats(m.result_status);

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

  -- 0-100, TO TWO DECIMAL PLACES. Not 0-1. See the header — the renderer was
  -- fixed on 2026-08-14 to stop multiplying by 100 a second time, and this is
  -- the convention it was fixed to match.
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

-- Same shape as update_head_to_head: find this match's pairs, recompute each.
-- The match_type = 'doubles' test that used to sit at the top of this function
-- has moved into recompute_partnership_pair's own query, where it belongs —
-- the pair is what is being recomputed, and a pair's counted matches are the
-- doubles ones whatever this particular match happens to be.
CREATE OR REPLACE FUNCTION public.update_partnership_stats(p_match_id UUID) RETURNS VOID AS $$
DECLARE
  v_pair RECORD;
BEGIN
  FOR v_pair IN
    SELECT DISTINCT
           LEAST(p1.player_id, p2.player_id)    AS player_a_id,
           GREATEST(p1.player_id, p2.player_id) AS player_b_id
      FROM public.match_participants p1
      JOIN public.match_participants p2
        ON p2.match_id = p1.match_id
       AND p2.team_side = p1.team_side
       AND p2.player_id <> p1.player_id
     WHERE p1.match_id = p_match_id
  LOOP
    PERFORM public.recompute_partnership_pair(v_pair.player_a_id, v_pair.player_b_id);
  END LOOP;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

-- 4. THE TWO TRIGGERS --------------------------------------------------------

-- 4a. ON THE STATUS MOVING, IN EITHER DIRECTION.
--
-- The old body was `NEW.result_status = 'confirmed' AND OLD.result_status IS
-- DISTINCT FROM 'confirmed'` — it fired on the way IN and never on the way
-- OUT. That is gap 2 and gap 3 in one line: nothing recounted when a match
-- left 'confirmed' for 'voided' (reverse_match_result) or for 'disputed'
-- (dispute_match_result), and the trip back through 'pending_confirmation' to
-- 'confirmed' that resolveDispute performs looked exactly like a first
-- confirmation.
--
-- Now it fires whenever the match CROSSES the predicate, whichever way. So:
--
--   pending_confirmation -> confirmed   counts it            (as before)
--   confirmed -> voided                 uncounts it          (GAP 2)
--   confirmed -> disputed               uncounts it          (GAP 3, half)
--   disputed -> pending_confirmation    nothing to do
--   pending_confirmation -> confirmed   counts it once       (GAP 3, other half)
--   confirmed -> confirmed              nothing to do        (double confirm)
--
-- reverse_match_result IS DELIBERATELY NOT EDITED. Its `UPDATE matches SET
-- result_status = 'voided'` is what fires this trigger, so the decrement it
-- was missing now happens as a consequence of the void itself rather than as a
-- second thing somebody has to remember to call. Adding an explicit
-- PERFORM update_head_to_head(...) inside it would be harmless — the recompute
-- is idempotent — but it would put a second owner on these tables, which is
-- exactly what 00003:459 spent a paragraph warning against. One owner, and it
-- is this trigger. The same sentence covers dispute_match_result,
-- convertMatchToCasual and anything else that ever moves the status: none of
-- them needs to know these tables exist.
--
-- The AFTER UPDATE **OF result_status** clause on the trigger itself is left
-- exactly as 00004 wrote it, so an UPDATE that does not name the column does
-- not even evaluate this.
CREATE OR REPLACE FUNCTION public.trigger_match_confirmed()
RETURNS TRIGGER AS $$
BEGIN
  IF public.match_counts_toward_stats(NEW.result_status)
     IS DISTINCT FROM public.match_counts_toward_stats(OLD.result_status) THEN
    PERFORM public.update_head_to_head(NEW.id);
    PERFORM public.update_partnership_stats(NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- 4b. ON THE PARTICIPANTS ARRIVING FOR A MATCH THAT IS ALREADY CONFIRMED.
--
-- THIS IS GAP 1, AND IT HAS TO HANG OFF match_participants RATHER THAN
-- matches. The obvious fix — an AFTER INSERT trigger on `matches` — does not
-- work and would be worse than the bug. adminCreateMatch has no transaction
-- (PostgREST gives it none), so it writes the match row FIRST and the
-- participants in a separate, later statement. An AFTER INSERT trigger on
-- `matches` would run against zero participants: update_head_to_head would
-- find no pairs and do nothing, and the old FOREACH-over-a-NULL-array body
-- would have raised outright and broken match entry altogether. A DEFERRABLE
-- constraint trigger does not help either, because the match INSERT has
-- already COMMITTED by the time the participants are sent.
--
-- So the event that matters is "participants exist for a confirmed match", and
-- that is an INSERT on match_participants.
--
-- STATEMENT-LEVEL WITH A TRANSITION TABLE, not FOR EACH ROW: a doubles match
-- sends four participant rows in one statement, and a row trigger would run
-- the whole recompute four times and would see a half-built team on the first
-- three. `REFERENCING NEW TABLE` gives the statement's rows in one go, after
-- all of them have landed.
--
-- IT ONLY EVER ACTS ON A MATCH THAT IS ALREADY 'confirmed', which is what
-- makes it a no-op on every path that already works: submit_match_result and
-- apply_walkover_result insert their participants while the match is
-- 'pending_confirmation', so this costs them one indexed lookup and nothing
-- else. And it is the invariant that makes this trigger safe alongside
-- adminCreateMatch's cleanup — see "THE TWO CANNOT DRIFT" in the header.
--
-- NO DELETE TRIGGER IS ADDED, deliberately. The tempting symmetry — recompute
-- when a match is deleted — depends on facts about whether an RI cascade fires
-- statement-level triggers on the child table and on how AFTER-trigger name
-- ordering interacts with the cascade, neither of which can be established
-- without running SQL against this database. Building on a guess there would
-- be worse than the gap it closes, and the gap is closed by the status
-- invariant instead: discardIncompleteMatch is the only DELETE against
-- `matches` in either app, and after the console change in this commit it can
-- only ever target a 'pending_confirmation' or 'incomplete' row — never a
-- 'confirmed' one, and therefore by definition never one this trigger has
-- counted.
CREATE OR REPLACE FUNCTION public.trigger_match_participants_inserted()
RETURNS TRIGGER AS $$
DECLARE
  v_match_id UUID;
BEGIN
  FOR v_match_id IN
    SELECT DISTINCT n.match_id
      FROM new_participants n
      JOIN public.matches m ON m.id = n.match_id
     WHERE public.match_counts_toward_stats(m.result_status)
  LOOP
    PERFORM public.update_head_to_head(v_match_id);
    PERFORM public.update_partnership_stats(v_match_id);
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- DROP-then-CREATE is the portable idempotent form; CREATE OR REPLACE TRIGGER
-- is version-dependent and this file has no need of it. Same reasoning as
-- 00117:306.
DROP TRIGGER IF EXISTS on_match_participants_inserted ON public.match_participants;
CREATE TRIGGER on_match_participants_inserted
  AFTER INSERT ON public.match_participants
  REFERENCING NEW TABLE AS new_participants
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.trigger_match_participants_inserted();

-- 5. THE BACKFILL, WHICH REPORTS WHAT IT MOVED -------------------------------
-- Every pair that any counted match implies, UNION every pair that already has
-- a row. The first half fixes matches that were never counted (gap 1) and
-- matches that were counted twice (gap 3); the second half fixes pairs whose
-- matches have since been voided or disputed away (gap 2), including pairs
-- whose count should now be zero and which the first half therefore never
-- visits.
--
-- This is the SAME function the triggers call. There is no separate repair
-- logic that could be subtly different from the live path, which is the whole
-- reason to derive rather than accumulate.
--
-- NOT WRAPPED IN AN EXPLICIT TRANSACTION: the file is piped into psql, which
-- wraps each statement, and this DO block is one statement. Either it
-- completes or it rolls back whole.
DO $$
DECLARE
  v_pair    RECORD;
  v_seen    INTEGER := 0;
  v_changed INTEGER := 0;
  v_zeroed  INTEGER := 0;
  v_counted INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_counted
    FROM public.matches m
   WHERE public.match_counts_toward_stats(m.result_status);
  RAISE NOTICE '00119: % matches count toward the stats tables', v_counted;

  -- ---- head to head ----
  FOR v_pair IN
      SELECT LEAST(a.player_id, b.player_id)    AS player_a_id,
             GREATEST(a.player_id, b.player_id) AS player_b_id,
             m.match_type
        FROM public.matches m
        JOIN public.match_participants a ON a.match_id = m.id AND a.team_side = 'a'
        JOIN public.match_participants b ON b.match_id = m.id AND b.team_side = 'b'
       WHERE public.match_counts_toward_stats(m.result_status)
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
  RAISE NOTICE '00119: head_to_head_stats — % pairs examined, % rows CHANGED, % rows now sitting at zero (a total, not a delta — a clean re-run reports the same figure with 0 changed)',
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
         AND public.match_counts_toward_stats(m.result_status)
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
  RAISE NOTICE '00119: partnership_stats — % pairs examined, % rows CHANGED, % rows now sitting at zero (a total, not a delta — a clean re-run reports the same figure with 0 changed)',
    v_seen, v_changed, v_zeroed;

  RAISE NOTICE '00119: re-running this file will report 0 rows changed. If it does not, something is still writing these tables outside update_head_to_head / update_partnership_stats.';
END;
$$;
