-- ============================================================
-- 00125_close_last_note_leaks.sql — the two columns 00122 could not take, and
-- the two plpgsql bodies that were holding them open
-- ============================================================
-- 00122 dropped three of the five legacy free-text columns and HELD TWO, for a
-- reason that was correct and is the whole subject of this file: each of the
-- two is still WRITTEN by a live plpgsql function, and a dropped column named
-- in a plpgsql statement raises 42703 when that statement is first planned —
-- which is at RUN time, in the middle of a SECURITY DEFINER body that has
-- already done work. Dropping either without touching its writer would have
-- been strictly worse than the exposure it closed.
--
-- So this file redefines both functions and drops both columns together,
-- because neither half is safe alone. What each one leaks today:
--
--   tournament_participants.notes — unpair_tournament_pair (00102:289)
--     THIS IS A LIVE LEAK, not residue. The function INSERTs `p_reason` — the
--     exec's withdrawal reason, the same class of text 00117/00118 exist to
--     privatise — straight into the column, from the current build
--     (participants.ts:1392, splitPairImpl, which writes NO private note of its
--     own; the RPC is the only writer on that path). `tournament_participants`
--     is published by 00113, so every unpair-with-withdrawal streams that
--     sentence to every phone watching the bracket, and it is readable through
--     PostgREST by any signed-in member besides. 00118's header claimed this
--     column had exactly one writer and it was exitDrawImpl; 00122 found that
--     to be wrong. This is the fix.
--
--   walkovers.admin_notes — apply_walkover_result (00003:578, 00049:181)
--     Never streamed — `walkovers` is in no publication — but readable, and by
--     the worst possible reader. `walkovers_select` admits `forfeit_player_id`,
--     so the member who forfeited can read the exec's verdict on their own
--     forfeit. 00118 already stopped confirmWalkover from PASSING
--     `p_admin_notes` (it is `DEFAULT NULL`) and moved the text to
--     walkover_admin_notes app-side, so no CURRENT write reaches the column —
--     but the UPDATE names it whether or not a value arrives, and every row
--     written before 00118 is still sitting there readable.
--
-- ------------------------------------------------------------
-- BOTH SIGNATURES ARE UNCHANGED, AND THAT IS THE LOAD-BEARING DECISION
-- ------------------------------------------------------------
-- 00122's follow-up notes sketched dropping `p_admin_notes` from
-- apply_walkover_result, and correctly warned that doing so needs an explicit
--   DROP FUNCTION public.apply_walkover_result(uuid, uuid, text);
-- first, because CREATE OR REPLACE matches on the ARGUMENT LIST and a
-- two-argument definition would mint a SECOND overload beside the live
-- three-argument one.
--
-- THIS FILE DOES NOT DO THAT. Both functions keep the exact signature they have
-- today —
--   apply_walkover_result(uuid, uuid, text DEFAULT NULL)
--   unpair_tournament_pair(uuid, uuid, text, uuid)
-- — and only the BODY changes: the text is written into the private table
-- instead of into the column. Plain CREATE OR REPLACE, no DROP FUNCTION, no
-- overload, no window in which two bodies are live at once.
--
-- THE REASON IS DEPLOY ORDER. The owner applies migrations by hand and deploys
-- code separately, so both orders have to survive, and a signature change
-- cannot survive both:
--
--   MIGRATION FIRST, OLD CODE STILL RUNNING. splitPairImpl keeps calling
--     unpair_tournament_pair with all four arguments; the new body accepts them
--     and routes `p_reason` to tournament_participant_notes. confirmWalkover
--     keeps calling apply_walkover_result with two arguments; `p_admin_notes`
--     defaults to NULL and no note is written, exactly as today, and the app's
--     own writePrivateNote call after the RPC still records the text. Nothing
--     reads either dropped column by name (audit below). NO BREAKAGE.
--
--   CODE FIRST, MIGRATION NOT YET APPLIED. Vacuous — THIS FILE CHANGES NO APP
--     CODE AT ALL. There is no new build to deploy ahead of it. NO BREAKAGE.
--
-- Had the signature shrunk to two arguments, the second order would have been
-- fine and the first would have been fine, but the moment between DROP FUNCTION
-- and CREATE would not, and any caller still passing three arguments would have
-- got `function does not exist` (42883) instead. Keeping the parameter costs a
-- line of documentation and removes the whole class of problem. `p_admin_notes`
-- is no longer dead weight either: it is now the parameter that carries the
-- verdict into walkover_admin_notes, so a future caller CAN pass it and have
-- the note recorded atomically with the confirmation, which is better than what
-- the app does today (a second round trip after an irreversible RPC).
--
-- ------------------------------------------------------------
-- THE BODIES BELOW WERE TAKEN FROM THE LIVE DATABASE, NOT FROM THE MIGRATIONS
-- ------------------------------------------------------------
-- Both are `pg_get_functiondef` output from production, read through
-- `ssh pi docker exec supabase-db psql`, with the notes handling changed and
-- NOTHING else touched. This matters most for apply_walkover_result:
-- 00003 defined it, 00049 redefined it for the configurable late-withdrawal
-- threshold, and rebuilding it from 00003's text would have silently reverted
-- that — in a function that applies Elo penalties and moves reliability
-- counters, where a revert is expensive and quiet. Diffed against the live text
-- rather than transcribed: the only edits are the ones named in each section.
--
-- Preserved verbatim in both: SECURITY DEFINER, `SET search_path TO 'public',
-- 'pg_temp'`, the return types, every RAISE and its ERRCODE, the advisory lock,
-- the Elo branch and its weights, apply_match_result, the reliability-metric
-- branches, and the single read of the late-withdrawal threshold that both the
-- Elo decision and the metric decision share (00049's point).
--
-- OWNERSHIP AND GRANTS ARE UNTOUCHED, which CREATE OR REPLACE guarantees: it
-- keeps the existing owner and the existing ACL rather than re-deriving either.
-- No GRANT or REVOKE appears in this file. See "FOUND, NOT FIXED" at the foot
-- for what that preserves and why preserving it here was the right call.
--
-- ------------------------------------------------------------
-- WHAT READS THESE TWO COLUMNS TODAY — the audit the DROPs rest on
-- ------------------------------------------------------------
-- Same test 00122 applied: a NAMED select with a dropped column in the list
-- fails the WHOLE PostgREST request; a `select('*')` simply comes back without
-- the key and `?? null` does the rest.
--
--   walkovers.admin_notes
--     One read: apps/admin/src/app/walkovers/page.tsx:44,
--     `noteById.get(w.id) ?? w.admin_notes ?? null`, off the `select('*')` at
--     page.tsx:17. Already a fallback BEHIND walkover_admin_notes and already
--     coalescing to null. The player-detail panel stopped selecting the column
--     in 00118's own commit (players/[id]/page.tsx:151). No other reader in
--     either app.
--
--   tournament_participants.notes
--     NO READ ANYWHERE. Every select on this table in both apps is a named list
--     and none of them names `notes` — _internal.ts:1956, participants.ts:199,
--     results.ts:462, the player app's tournaments/page.tsx:201 and
--     tournament-actions.ts:219. The player app's event page was narrowed to
--     named columns for exactly this reason and says so at page.tsx:83.
--
-- NEITHER COLUMN IS WRITTEN FROM EITHER APP, which matters more than the reads:
-- a dropped column in a `.update({...})` or `.insert({...})` payload is a
-- PGRST204 and a broken console action, not a silent null. `admin_notes` appears
-- in no write anywhere — rejectWalkover's UPDATE (walkovers.ts:97) says in as
-- many words that it stopped setting it in 00118, and confirmWalkover's RPC call
-- omits p_admin_notes. Every INSERT and UPDATE on `tournament_participants` in
-- both apps was read for its payload keys — participants.ts:373, :666, :808,
-- :828, brackets.ts:401, seeding.ts:29, finalize.ts:232, results.ts:1346, :1360
-- and the player app's tournament-actions.ts:268, :423, :470 — and none of them
-- names `notes`. The only writer was the plpgsql in section 1.
--
-- No plpgsql outside the two functions below names either column: checked on
-- the live database with a regex over `pg_proc.prosrc` across the whole `public`
-- schema. `merge_players_preview` and `merge_players_unhandled` match the word
-- "notes" only through `varsity_notes`, a different table. Nothing calls
-- apply_walkover_result from plpgsql either — the one hit is a COMMENT inside
-- apply_match_result, which is the function apply_walkover_result CALLS.
--
-- THE GENERATED TYPES ARE NOT REGENERATED, for 00122's reason:
-- `tournament_participants.notes` and `walkovers.admin_notes` staying in
-- database.gen.ts is the safe direction of that drift — it PERMITS a read that
-- now returns undefined, it does not demand one — and removing the fallback at
-- walkovers/page.tsx:44 is a separate change from removing the column it falls
-- back to. That fallback is dead after this file and harmless: it evaluates to
-- null. It is left in place deliberately rather than overlooked.
--
-- ------------------------------------------------------------
-- SWEEP BEFORE DROP, IN ONE TRANSACTION, WITH THE TABLES LOCKED
-- ------------------------------------------------------------
-- BEGIN/COMMIT for 00122's reason: this file moves data before removing its
-- source, and unwrapped — psql reports an error and carries on to the next
-- statement — a sweep that raised partway would be followed by the DROPs
-- running anyway, taking the rows it had not reached. Either everything lands
-- and the columns go, or nothing happens and the file can simply be re-run.
--
-- One thing this file adds that 00122 did not need: it LOCKs both tables in
-- ACCESS EXCLUSIVE before the sweep. 00122 dropped columns nothing was writing;
-- these two are written by functions that CONCURRENT sessions may be inside
-- right now, running the OLD body, and a write that lands after the sweep's
-- snapshot but before the DROP takes its own lock would be lost silently. The
-- DROP acquires that lock at the end regardless, so taking it at the start
-- costs nothing but the length of this file and makes "lossless" true rather
-- than nearly true.
--
-- The sweeps themselves are byte-for-byte 00122's, ON CONFLICT DO NOTHING and
-- all. DO NOTHING rather than DO UPDATE because a note an exec has since edited
-- through the private table must not be overwritten by the stale value still in
-- the column — see 00122 for the argument, which this file does not reopen.
-- Running them again here is not belt-and-braces: unpair_tournament_pair has
-- kept writing withdrawal reasons into the column for every unpair since 00122
-- was applied, and this is the last chance to collect them.
--
-- NOTE THE ASYMMETRY, because it is deliberate: the SWEEP uses DO NOTHING
-- (the private table holds the newer value) and the FUNCTIONS below use
-- DO UPDATE (the function IS the newer value — it is writing the note as the
-- withdrawal or the confirmation happens).
--
-- IDEMPOTENT throughout: CREATE OR REPLACE, sweeps guarded on their source
-- column still existing and ending in ON CONFLICT, DROP COLUMN IF EXISTS. The
-- static SQL sits inside EXECUTE for 00117's reason — a plain statement naming
-- a dropped column fails to PARSE even on a branch that never runs.
--
-- ------------------------------------------------------------
-- WHAT IS LEFT AFTERWARDS
-- ------------------------------------------------------------
-- All five columns from 00117/00118 are gone and no free text an exec writes
-- reaches a member through a published table or through PostgREST. The five
-- private tables hold it, each with no grant for anon/authenticated, RLS on with
-- no policy, and none of them published.
--
-- THE AUDIT TABLES HOLD A SECOND COPY OF BOTH SENTENCES, and that was checked
-- on the live database rather than assumed, because the claim above is only
-- true if they are console-only. splitPairImpl writes the withdrawal reason
-- into tournament_audit_log.details.reason and confirmWalkover/rejectWalkover
-- write the verdict into audit_logs.reason, whatever the columns do. Both
-- tables carry a table-level SELECT grant for anon and authenticated — but RLS
-- is ON for both and the only SELECT policy on each is `is_admin(auth.uid())`,
-- so a member reaches neither, and NEITHER TABLE IS IN ANY PUBLICATION
-- (pg_publication_tables, checked). audit_logs also grants
-- INSERT/UPDATE/DELETE to authenticated with only an INSERT policy behind them
-- (also is_admin), so the rest is denied by RLS. The text is therefore
-- exec-visible in two places and member-visible in none, which is the intended
-- shape: an audit row that could not name the reason would not be an audit row.
--
-- NO ALTER PUBLICATION AND NO REPLICA IDENTITY CHANGE HERE, and the second is
-- worth stating because this file looks even more like the invitation than
-- 00122 did. Both apps' guard tests list four tables that must never be widened
-- to FULL, and now that all five note columns are gone a reader may think the
-- list can shrink. IT CANNOT: `tournament_pairs.pair_name` is member-chosen and
-- per 00113:88 is often a real name, and the other three would gain nothing
-- from FULL — 00120 reached for a parent-touching trigger precisely to avoid
-- it. The list is about what the tables carry, not about which migration last
-- touched them.
-- ============================================================

-- One transaction for the whole file: the sweeps have to be durable before the
-- DROPs remove what they read.
BEGIN;

-- Held for the rest of the file. See "SWEEP BEFORE DROP" above — this is what
-- stops a session already inside the old function body from writing a note into
-- a column between the sweep and the drop of it. Both DROP COLUMNs take this
-- same lock anyway; taking it here only takes it earlier.
LOCK TABLE public.tournament_participants IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.walkovers              IN ACCESS EXCLUSIVE MODE;


-- ============================================================
-- 1. unpair_tournament_pair — the withdrawal reason stops being published
-- ============================================================
-- Live definition as of this file, with exactly two edits, both in the second
-- half of the body:
--
--   * the INSERT INTO tournament_participants column list loses `notes`, and
--     the `CASE WHEN h.player_id = p_withdrawn_player_id THEN p_reason ELSE
--     NULL END` expression that fed it goes with it.
--   * a new INSERT into tournament_participant_notes after the read-back.
--
-- Everything above the DELETE is untouched: the pair lookup, the advisory lock
-- on the event field, the "that player is not in this pair" check, the
-- already-left-the-event check, the draw_locked check, and the
-- is-this-pair-in-a-match check that is the real foreign-key guard.
--
-- THE NOTE NEEDS AN ID THAT DOES NOT EXIST UNTIL THE INSERT HAS RUN, which is
-- why this is a second statement rather than another column. It reuses the same
-- read-back the function already does for its return value — one more index
-- probe on tournament_participants_event_id_player_id_key, which is UNIQUE on
-- (event_id, player_id), so the SELECT feeding the INSERT yields at most one
-- row by construction.
--
-- WRITTEN ONLY WHEN THERE IS A NOTE. `p_reason` is optional on this path —
-- unpairEntry passes null and withdrawPairMember's `reason` is `string |
-- undefined` — and `note` is NOT NULL on the private table. An empty or
-- whitespace-only reason leaves no row at all rather than an empty one, which
-- matches the `btrim(...) <> ''` guard every backfill in this directory uses.
--
-- ON CONFLICT DO UPDATE, unlike the sweep in section 3, and it is UNREACHABLE
-- today by construction rather than merely unlikely: the participant row was
-- created microseconds earlier by the INSERT above with a fresh
-- gen_random_uuid(), and any note belonging to a previous participant row for
-- the same two people went with that row through
-- tournament_participant_notes_participant_id_fkey ON DELETE CASCADE. The
-- clause is there so the statement states its own precedence — a reason written
-- as the withdrawal happens is the current one — instead of depending silently
-- on the id being fresh, and so an ON CONFLICT DO NOTHING is never reached for
-- by symmetry with the sweep, where DO NOTHING is correct and here it would
-- discard the new reason. `updated_at` is left to the set_updated_at
-- BEFORE UPDATE trigger rather than set here.
--
-- The author is real: `p_added_by` is the exec who acted, passed by
-- splitPairImpl as the holder of tournaments.draw.exit.write, and it already
-- carries a foreign key to players(id) through tournament_participants.added_by.

CREATE OR REPLACE FUNCTION public.unpair_tournament_pair(p_pair_id uuid, p_withdrawn_player_id uuid, p_reason text, p_added_by uuid)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pair   RECORD;
  v_event  RECORD;
  v_ids    uuid[];
BEGIN
  SELECT id, event_id, player1_id, player2_id, status
    INTO v_pair
    FROM tournament_pairs
   WHERE id = p_pair_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pair not found.' USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(v_pair.event_id::text));

  IF p_withdrawn_player_id IS NOT NULL
     AND p_withdrawn_player_id NOT IN (v_pair.player1_id, v_pair.player2_id) THEN
    RAISE EXCEPTION 'That player is not in this pair.' USING ERRCODE = 'check_violation';
  END IF;

  -- A pair that has already left the event is not raw material for a pool
  -- entry: putting both halves back as 'registered' would quietly reverse a
  -- withdrawal that an exec, or a forfeit cascade, decided on.
  IF v_pair.status IN ('withdrawn', 'disqualified') THEN
    RAISE EXCEPTION 'This pair has already left the event.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT id, status, draw_locked INTO v_event
    FROM tournament_events WHERE id = v_pair.event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_event.draw_locked THEN
    RAISE EXCEPTION 'Draw is locked. Unlock it before making changes.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The draw, checked as "is this pair in a match" rather than as an event
  -- status, because that is the thing the foreign keys actually protect.
  IF EXISTS (
    SELECT 1 FROM tournament_matches
     WHERE pair_a_id = p_pair_id OR pair_b_id = p_pair_id
        OR winner_pair_id = p_pair_id OR loser_pair_id = p_pair_id
  ) THEN
    RAISE EXCEPTION 'This pair is already in the draw, so it cannot be split up. Withdraw the pair instead, or regenerate the bracket.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  DELETE FROM tournament_pairs WHERE id = p_pair_id;

  -- One statement for both halves. The status expression is what makes this
  -- function serve the withdrawal case as well as the plain unpair.
  --
  -- `notes` IS NO LONGER IN THIS COLUMN LIST — 00125. The withdrawal reason
  -- used to be written here, into a column of a table published by 00113, which
  -- put the exec's sentence on the wire to every bracket subscriber. It goes
  -- into tournament_participant_notes below instead.
  INSERT INTO tournament_participants (event_id, player_id, status, elo_before, added_by)
  SELECT
    v_pair.event_id,
    h.player_id,
    CASE WHEN h.player_id = p_withdrawn_player_id THEN 'withdrawn' ELSE 'registered' END,
    COALESCE((SELECT r.doubles_elo FROM ratings r WHERE r.player_id = h.player_id), 400),
    p_added_by
  FROM unnest(ARRAY[v_pair.player1_id, v_pair.player2_id]) AS h(player_id);

  -- Read back rather than RETURNING ... INTO, which keeps only the last row of
  -- a multi-row insert.
  SELECT array_agg(id) INTO v_ids
    FROM tournament_participants
   WHERE event_id = v_pair.event_id
     AND player_id IN (v_pair.player1_id, v_pair.player2_id);

  -- THE REASON, SOMEWHERE ONLY THE CONSOLE CAN READ IT — 00125.
  -- tournament_participant_notes holds no grant for anon or authenticated, has
  -- RLS on with no policy, and is not published; this function is SECURITY
  -- DEFINER and runs as the owner, so it can write there and nobody it writes
  -- about can read it back. Atomic with the withdrawal, which is better than
  -- the app-side note writes elsewhere: there is no state in which the entry is
  -- withdrawn and the reason went missing.
  --
  -- Only when there IS a reason: unpairEntry passes NULL and `note` is NOT NULL.
  IF p_withdrawn_player_id IS NOT NULL
     AND p_reason IS NOT NULL
     AND btrim(p_reason) <> '' THEN
    INSERT INTO tournament_participant_notes (participant_id, note, author_id)
    SELECT tp.id, p_reason, p_added_by
      FROM tournament_participants tp
     WHERE tp.event_id  = v_pair.event_id
       AND tp.player_id = p_withdrawn_player_id
    ON CONFLICT (participant_id) DO UPDATE
      SET note      = EXCLUDED.note,
          author_id = EXCLUDED.author_id;
  END IF;

  RETURN v_ids;
END;
$function$;


-- ============================================================
-- 2. apply_walkover_result — the verdict stops being readable by its subject
-- ============================================================
-- Live definition as of this file — 00049's, which raised the late-withdrawal
-- threshold out of a literal and into platform_setting_int, read ONCE so that
-- the Elo decision and the reliability-metric decision cannot straddle a
-- settings edit. That single read, both branches that consume it, the Elo
-- weights (0.0 early / 0.50 late / 0.75 no-show), the match insert and its
-- pending_confirmation dance around apply_match_result, the participant
-- pre_rating snapshot, the challenge status transitions and all four
-- reliability-metric updates are reproduced EXACTLY as the database has them.
--
-- TWO EDITS, both about the note:
--
--   * `admin_notes = p_admin_notes,` is removed from the UPDATE walkovers SET
--     list. That line is the entire reason the column could not be dropped: it
--     names the column on every call, whether or not a caller supplies a value,
--     and a 42703 raised there would abort a confirmation with Elo already
--     applied earlier in the same transaction — the transaction rolls back and
--     walkover confirmation simply stops working in the console.
--   * a new INSERT into walkover_admin_notes immediately after that UPDATE.
--
-- THE SIGNATURE IS UNCHANGED — still three arguments, `p_admin_notes` still
-- `DEFAULT NULL`. See the header: this is what lets the migration and the code
-- deploy in either order. confirmWalkover (walkovers.ts:42) passes two
-- arguments today and writes its note through writePrivateNote after the RPC,
-- which keeps working untouched; if it is ever changed to pass the third, the
-- note becomes atomic with the confirmation instead. Both are correct against
-- this body, which is the point.
--
-- ON CONFLICT DO UPDATE for section 1's reason. A walkover is confirmed once —
-- the function refuses any status but 'pending' — so a conflict here means a
-- backfilled row from 00122's sweep or 00118's, and a verdict written now
-- supersedes one recovered from the column.
--
-- The author is real: `p_admin_id` is the exec confirming, the same value the
-- statement above writes into walkovers.admin_confirmed_by, which carries a
-- foreign key to players(id) — the same one walkover_admin_notes.author_id has.

CREATE OR REPLACE FUNCTION public.apply_walkover_result(p_walkover_id uuid, p_admin_id uuid, p_admin_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_walkover RECORD;
  v_challenge RECORD;
  v_elo_weight NUMERIC;
  v_apply_elo BOOLEAN;
  v_match_id UUID;
  v_winner_side team_side;
  v_is_doubles BOOLEAN;
  v_late_threshold INTEGER;
BEGIN
  SELECT * INTO v_walkover FROM walkovers WHERE id = p_walkover_id FOR UPDATE;
  IF v_walkover IS NULL OR v_walkover.status != 'pending' THEN
    RAISE EXCEPTION 'Walkover not found or not pending';
  END IF;

  -- Read once, before either branch uses it. The Elo decision and the
  -- reliability-metric decision must agree on the same number within a single
  -- call; two separate reads could straddle a settings edit.
  v_late_threshold := platform_setting_int('walkover_rules', 'late_withdrawal_threshold_hours', 24);

  SELECT * INTO v_challenge FROM challenges WHERE id = v_walkover.challenge_id;

  -- Determine Elo weight based on walkover type. At or above the threshold is
  -- early notice and free; below it costs half weight.
  IF v_walkover.walkover_type = 'withdrawal' AND COALESCE(v_walkover.notice_hours, 0) >= v_late_threshold THEN
    v_elo_weight := 0.0; -- No penalty for early withdrawal
  ELSIF v_walkover.walkover_type = 'withdrawal' THEN
    v_elo_weight := 0.50;
  ELSE -- no_show
    v_elo_weight := 0.75;
  END IF;

  v_apply_elo := v_elo_weight > 0 AND v_challenge.rated_flag;

  -- Create a match record for the walkover
  v_is_doubles := v_challenge.type = 'doubles';

  -- Determine winner side (opposite of forfeiting player)
  SELECT team_side INTO v_winner_side
  FROM challenge_participants
  WHERE challenge_id = v_walkover.challenge_id AND player_id = v_walkover.forfeit_player_id;

  IF v_winner_side = 'a' THEN v_winner_side := 'b'; ELSE v_winner_side := 'a'; END IF;

  -- Create match. When ELO applies the row starts as pending_confirmation
  -- because apply_match_result rejects any other status, then flips it to
  -- 'confirmed' itself.
  INSERT INTO matches (
    challenge_id, session_id, season_id, match_type, event_type,
    rated_flag, format, format_weight, event_multiplier,
    completed_flag, winner_side, result_status, walkover_type,
    forfeit_player_id, notice_hours, elo_weight_override, played_at
  ) VALUES (
    v_walkover.challenge_id, v_challenge.session_id,
    (SELECT id FROM seasons WHERE active_flag = TRUE LIMIT 1),
    v_challenge.type, v_challenge.event_type,
    v_challenge.rated_flag AND v_elo_weight > 0,
    v_challenge.format, get_format_weight(v_challenge.format),
    get_event_multiplier(v_challenge.event_type),
    TRUE, v_winner_side,
    CASE WHEN v_apply_elo THEN 'pending_confirmation'::result_status ELSE 'walkover'::result_status END,
    v_walkover.walkover_type,
    v_walkover.forfeit_player_id, v_walkover.notice_hours, v_elo_weight, NOW()
  ) RETURNING id INTO v_match_id;

  -- Add match participants from challenge participants
  INSERT INTO match_participants (match_id, player_id, team_side, pre_rating)
  SELECT v_match_id, cp.player_id, cp.team_side,
    CASE WHEN v_is_doubles THEN r.doubles_elo ELSE r.singles_elo END
  FROM challenge_participants cp
  JOIN ratings r ON r.player_id = cp.player_id
  WHERE cp.challenge_id = v_walkover.challenge_id;

  -- Apply Elo if weight > 0
  IF v_apply_elo THEN
    PERFORM apply_match_result(v_match_id, p_admin_id);
  ELSE
    -- Just mark participants
    UPDATE match_participants SET win_flag = (team_side = v_winner_side),
      post_rating = pre_rating, rating_delta = 0
    WHERE match_id = v_match_id;

    UPDATE matches SET result_status = 'walkover', confirmed_by = p_admin_id WHERE id = v_match_id;
    IF v_challenge.id IS NOT NULL THEN
      UPDATE challenges SET status = 'walkover_confirmed', updated_at = NOW() WHERE id = v_challenge.id;
    END IF;
  END IF;

  -- Update walkover record.
  --
  -- `admin_notes = p_admin_notes` IS NO LONGER HERE — 00125. walkovers_select
  -- admits forfeit_player_id, so the column let the member who forfeited read
  -- the exec's verdict on their own forfeit. The verdict goes to
  -- walkover_admin_notes below instead.
  UPDATE walkovers SET
    status = 'confirmed',
    match_id = v_match_id,
    admin_confirmed_by = p_admin_id,
    admin_confirmed_at = NOW(),
    elo_penalty_applied = (v_elo_weight > 0),
    updated_at = NOW()
  WHERE id = p_walkover_id;

  -- THE VERDICT, SOMEWHERE ITS SUBJECT CANNOT READ IT — 00125.
  -- walkover_admin_notes holds no grant for anon or authenticated and has RLS
  -- on with no policy, so it is reachable only through the service-role key
  -- and by SECURITY DEFINER bodies like this one. Only when a note was actually
  -- passed: `p_admin_notes` is DEFAULT NULL, today's caller omits it entirely,
  -- and `note` is NOT NULL on the private table.
  IF p_admin_notes IS NOT NULL AND btrim(p_admin_notes) <> '' THEN
    INSERT INTO walkover_admin_notes (walkover_id, note, author_id)
    VALUES (p_walkover_id, p_admin_notes, p_admin_id)
    ON CONFLICT (walkover_id) DO UPDATE
      SET note      = EXCLUDED.note,
          author_id = EXCLUDED.author_id;
  END IF;

  -- Update challenge status
  UPDATE challenges SET status = 'walkover_confirmed', updated_at = NOW()
  WHERE id = v_walkover.challenge_id;

  -- Update reliability metrics for forfeiting player. Same threshold as the
  -- Elo branch above, so the metric a player accrues always matches whether
  -- they were charged rating for it.
  IF v_walkover.walkover_type = 'no_show' THEN
    UPDATE reliability_metrics SET
      no_shows = no_shows + 1,
      updated_at = NOW()
    WHERE player_id = v_walkover.forfeit_player_id;
  ELSIF COALESCE(v_walkover.notice_hours, 0) < v_late_threshold THEN
    UPDATE reliability_metrics SET
      late_cancellations = late_cancellations + 1,
      updated_at = NOW()
    WHERE player_id = v_walkover.forfeit_player_id;
  ELSE
    UPDATE reliability_metrics SET
      early_withdrawals = early_withdrawals + 1,
      updated_at = NOW()
    WHERE player_id = v_walkover.forfeit_player_id;
  END IF;

  -- Update walkovers_received for the other players
  UPDATE reliability_metrics SET
    walkovers_received = walkovers_received + 1,
    updated_at = NOW()
  WHERE player_id IN (
    SELECT player_id FROM challenge_participants
    WHERE challenge_id = v_walkover.challenge_id
    AND player_id != v_walkover.forfeit_player_id
  );
END;
$function$;


-- ============================================================
-- 3. SWEEP — the last pass over both columns, while they still exist
-- ============================================================
-- Byte-for-byte 00122's, which is byte-for-byte 00118's; see those files for
-- why each COALESCE and each NULL::uuid is what it is. Both functions above are
-- already replaced at this point and both tables are locked, so no further row
-- can arrive in either column after this runs.
--
-- The tournament_participants sweep is the one that matters. Every
-- unpair-with-withdrawal since 00122 was applied wrote its reason into the
-- column and nowhere else, and after section 4 the column is gone.
--
-- ON CONFLICT DO NOTHING, deliberately — the private table's value is the one
-- the console has been reading and editing; the column's is superseded. The
-- consequence is stated plainly because it is a choice: where a private note
-- already exists for a parent, an older value still sitting in the legacy
-- column is not copied and goes with the drop. 00122 made that call and this
-- file does not reopen it.

DO $$
BEGIN
  -- tournament_participants.notes -> tournament_participant_notes (00118).
  -- author_id is NULL: the column never recorded who wrote the reason. New rows
  -- written by unpair_tournament_pair from now on carry p_added_by.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tournament_participants'
       AND column_name = 'notes'
  ) THEN
    EXECUTE $sql$
      INSERT INTO public.tournament_participant_notes
        (participant_id, note, author_id, created_at, updated_at)
      SELECT p.id, p.notes, NULL::uuid, COALESCE(p.created_at, NOW()), NOW()
        FROM public.tournament_participants p
       WHERE p.notes IS NOT NULL AND btrim(p.notes) <> ''
      ON CONFLICT (participant_id) DO NOTHING
    $sql$;
  END IF;

  -- walkovers.admin_notes -> walkover_admin_notes (00118). The one sweep here
  -- that recovers a real author: admin_confirmed_by was written by the same
  -- statement that wrote admin_notes.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'walkovers'
       AND column_name = 'admin_notes'
  ) THEN
    EXECUTE $sql$
      INSERT INTO public.walkover_admin_notes
        (walkover_id, note, author_id, created_at, updated_at)
      SELECT w.id, w.admin_notes, w.admin_confirmed_by,
             COALESCE(w.admin_confirmed_at, w.updated_at, w.created_at, NOW()), NOW()
        FROM public.walkovers w
       WHERE w.admin_notes IS NOT NULL AND btrim(w.admin_notes) <> ''
      ON CONFLICT (walkover_id) DO NOTHING
    $sql$;
  END IF;
END;
$$;


-- ============================================================
-- 4. DROP — the two 00122 had to leave
-- ============================================================
-- Safe now, and only now: neither column is named by any plpgsql in this
-- database any more (sections 1 and 2 were the last two), no named select in
-- either app lists either of them, and the sweep above ran in this same
-- transaction with both tables locked.
--
-- IF EXISTS on each, so a re-run is a no-op rather than a 42703. DROP COLUMN
-- takes an ACCESS EXCLUSIVE lock — already held since the top of the file — and
-- marks the attribute dropped without rewriting the table.

ALTER TABLE public.tournament_participants DROP COLUMN IF EXISTS notes;
ALTER TABLE public.walkovers               DROP COLUMN IF EXISTS admin_notes;


-- ============================================================
-- 5. SAY SO ON THE TABLES
-- ============================================================
-- Both comments currently describe a column that is about to stop existing, and
-- tournament_participant_notes' comment says something that has just stopped
-- being true — 00122 wrote that the table is INCOMPLETE because
-- unpair_tournament_pair still writes the parent column. It does not any more,
-- and a reader who acted on the old sentence would go looking for reasons that
-- are now all here. Restated in full rather than patched, because COMMENT ON has
-- no partial form.

COMMENT ON TABLE public.tournament_participant_notes IS
  'Exec-written reason a singles entry was withdrawn or disqualified. PRIVATE: no grant for anon/authenticated, RLS on with no policy, and deliberately NOT a member of supabase_realtime (its parent IS published, which is why the text had to leave). Read only by the console through the service-role key, gated on tournaments.draw.exit.write. Two writers: exitDrawImpl app-side, and unpair_tournament_pair, which since 00125 writes the withdrawal reason here atomically with the withdrawal instead of into tournament_participants.notes — a column 00125 dropped, having swept it one last time. This table is now the ONLY place a singles withdrawal reason exists.';

COMMENT ON TABLE public.walkover_admin_notes IS
  'Exec-written reason a walkover was confirmed or rejected. PRIVATE for the usual reasons plus one specific to it: walkovers_select admits forfeit_player_id, so the player who forfeited could read the exec''s verdict on their own forfeit off walkovers.admin_notes. That policy is deliberately unchanged — the row is legitimately theirs (/my-stats reads it), the column was not, and 00125 dropped it. Gated on walkovers.confirm.write / walkovers.reject.write. Written by confirmWalkover/rejectWalkover app-side, and by apply_walkover_result when a caller passes p_admin_notes — that parameter was kept rather than dropped, so the function can record the verdict atomically with the confirmation.';

COMMIT;


-- ============================================================
-- FOUND, NOT FIXED
-- ============================================================
-- NO GRANT OR REVOKE APPEARS ABOVE, and CREATE OR REPLACE preserved the ACL of
-- both functions exactly. For apply_walkover_result that ACL is right —
-- 00018:95 revoked EXECUTE from PUBLIC, anon and authenticated, and the live
-- grants are postgres and service_role only.
--
-- FOR unpair_tournament_pair IT IS NOT. The live ACL is
--   {postgres=X, anon=X, authenticated=X, service_role=X}
-- read off pg_proc.proacl on production. 00102:324 revoked EXECUTE FROM PUBLIC
-- and granted it to service_role, but Supabase's ALTER DEFAULT PRIVILEGES for
-- the public schema had already granted EXECUTE to anon and authenticated as
-- explicit entries, and REVOKE ... FROM PUBLIC does not touch those. So ANY
-- SIGNED-IN MEMBER, and any anonymous caller, can invoke this SECURITY DEFINER
-- function directly through PostgREST and split up somebody else's pair or
-- withdraw a member from an event — the capability check that guards it
-- (tournaments.draw.exit.write / .pairs.remove.write) lives in splitPairImpl,
-- app-side, and is bypassed entirely by calling the RPC.
--
-- IT IS SYSTEMIC TO 00102/00103, not a one-off. Same live ACL on
-- pair_tournament_entrants and swap_tournament_pair_member.
--
-- NOT FIXED HERE, because a grant change is a behaviour change and this file's
-- job is closing a text leak; mixing the two would mean they are applied
-- together and diagnosed together. The fix is three lines and its own
-- migration — no app change, since every caller uses the service-role key:
--
--   REVOKE EXECUTE ON FUNCTION public.unpair_tournament_pair(uuid, uuid, text, uuid)
--     FROM PUBLIC, anon, authenticated;
--   REVOKE EXECUTE ON FUNCTION public.pair_tournament_entrants(uuid, uuid, uuid, text, integer, uuid)
--     FROM PUBLIC, anon, authenticated;
--   REVOKE EXECUTE ON FUNCTION public.swap_tournament_pair_member(...)
--     FROM PUBLIC, anon, authenticated;
--
-- 00053:230 already wrote up this exact trap for check_session_caps — "REVOKE
-- FROM anon alone would do nothing: the blanket grant it inherited" — so the
-- pattern is known in this directory and 00102 simply missed half of it. Every
-- other SECURITY DEFINER function added since should be audited the same way.
--
-- ONE DEAD FALLBACK IS LEFT IN THE APP, deliberately:
-- apps/admin/src/app/walkovers/page.tsx:44 still reads `w.admin_notes` behind
-- the private-table lookup. It is off a `select('*')`, so it evaluates to null
-- rather than failing, and the generated types still declare the column so it
-- still compiles. Removing it is a separate change — see 00122, which left the
-- three equivalent fallbacks for the same reason.
-- ============================================================
