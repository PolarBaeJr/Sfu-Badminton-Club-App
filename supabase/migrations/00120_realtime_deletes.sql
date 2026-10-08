-- ============================================================
-- 00120_realtime_deletes.sql — make a removal reach the other exec's screen,
-- without putting a deleted row's contents on the wire
-- ============================================================
-- WHY
-- ---
-- 00112, 00113 and 00114 each published a set of tables and each wrote down the
-- same limitation at the bottom, in the same words, because it is the same
-- limitation:
--
--   Under DEFAULT replica identity a DELETE's WAL tuple carries ONLY THE
--   PRIMARY KEY. A `postgres_changes` subscription filtered on any other column
--   — `session_id=eq.…`, `event_id=eq.…`, `tournament_id=eq.…` — is therefore
--   never routed the event, because the filter cannot match a payload that does
--   not contain the column. Nothing errors. The callback simply never runs, and
--   the row stays on screen.
--
-- All three migrations judged the gap survivable and all three were right about
-- the surfaces they were describing. This file revisits the judgement for the
-- two surfaces where it actually costs something, and leaves the rest alone —
-- there is no general fix here and none is wanted.
--
-- WHAT WAS REJECTED THEN, AND STILL IS, AS A BLANKET ANSWER
-- ---------------------------------------------------------
-- Two alternatives were named in 00112:110, 00113:222 and 00114:314 and
-- dismissed. Neither has got better:
--
--   REPLICA IDENTITY FULL EVERYWHERE. Streams every deleted row's ENTIRE old
--     contents to every subscriber the filter admits. On three of these tables
--     that is disqualifying, and more so today than when it was written: 00117
--     and 00118 have just moved four columns of exec-written free text out of
--     published tables precisely so they stop streaming, and the old columns
--     ARE NOT DROPPED YET (00118 says so at length and writes out the follow-up
--     DROP). `tournament_participants.notes`, `tournament_pairs.notes` and
--     `tournament_matches.notes` are all still there, still populated with
--     history. FULL on those three would put a disqualification reason on the
--     wire in the DELETE path, where today it is not — the exact thing this
--     week's work was for.
--
--   DROPPING THE FILTERS. Wakes Tuesday's door list for Thursday's traffic and
--     every tournament screen in the club for every other tournament. The
--     filters are the reason a busy Saturday is not a broadcast storm.
--
-- BUT "REPLICA IDENTITY FULL" IS NOT ONE DECISION. It is per table, and the
-- objection above is entirely about COLUMN CONTENTS. A table whose every column
-- is an id, a timestamp or a constrained enum is not the same case as one
-- carrying an exec's private note, and treating them as one class is what kept
-- this closed for three migrations. Worked table by table, two of the seven
-- published tables are text-free and are the two that matter.
--
-- ------------------------------------------------------------
-- THE SURFACES, ONE AT A TIME
-- ------------------------------------------------------------
-- Every DELETE that can reach a published table, and what this file does about
-- it. The three "no change" rows are as much a part of the decision as the
-- others.
--
--  1. session_attendance — clearAttendanceMark (actions/sessions.ts:438).
--     REAL GAP. An exec un-marks somebody at the door; the officer watching the
--     same list from a laptop keeps showing them, and the "checked in today"
--     count with them, until they reload. FIXED HERE by REPLICA IDENTITY FULL
--     on that table alone. See part 1.
--
--  2. tournament_participants and tournament_pairs — removeParticipant
--     (participants.ts:757) and removePair (:1643), both refused once a draw
--     exists. REAL GAP, and 00113 called it "what IS affected": an entry
--     removed during `registration` or `checkin` stays on the other exec's
--     screen. FIXED HERE, but NOT with replica identity — both tables still
--     carry `notes`, and `tournament_pairs` also carries member-chosen
--     `pair_name`. Fixed instead by touching the parent. See part 3.
--
--  3. tournament_events — deleteTournamentEvent (events.ts:350), refused unless
--     the event is at `registration`, and the bulk delete in deleteTournament
--     (actions/tournaments.ts:333, which is also what actually removes a
--     deleted tournament's entries — see the note on :332 at the foot of this
--     file). REAL GAP, smaller than the others: a
--     deleted event stays on another exec's tournament overview and can be
--     clicked into. FIXED HERE by REPLICA IDENTITY FULL — nineteen columns of
--     format, seeding and status and, as 00113 put it, "not one of them free
--     text". Verified again below. See part 2.
--
--  4. tournament_matches — deletePhaseMatches (brackets.ts:194), which clears a
--     phase before regenerating it. NO CHANGE, and the reasoning is 00113's,
--     re-checked rather than repeated on trust: it has exactly two call sites
--     (brackets.ts:919 and :1378) and BOTH are immediately followed by the
--     generation loop that INSERTs the new matches. An INSERT's tuple is the
--     new row and carries `event_id`, so it routes, and the re-render simply no
--     longer contains the old matches. There is no clear-without-rebuild path.
--     A regenerated draw already reaches every watcher, so a trigger here would
--     buy nothing and cost an extra WAL update per phase clear. The table could
--     not take FULL anyway: `notes`, `walkover_reason` and the `elo_snapshot`
--     JSONB.
--
--  5. matches — discardIncompleteMatch (actions/matches.ts:298, deleting at
--     :312) is still the only DELETE against it in the tree. NO CHANGE. 00114
--     works this through and its conclusion holds: the match being discarded
--     was never rendered anywhere, it existed for the few hundred milliseconds
--     between a failed INSERT and its cleanup. The console's own listener on
--     `matches` is UNFILTERED and hears the delete regardless — a PK is enough
--     to route when nothing has to be matched. (00114 cites this function at
--     matches.ts:178; the line has since moved to :298. The count is still one.)
--
--  6. match_participants — cascade only, from 5. NO CHANGE, same reason.
--
--  7. challenges and challenge_participants — NO CHANGE. 00114 verified there
--     is no DELETE against either, in the tree or in any migration; a challenge
--     is cancelled by moving `status`, which is an UPDATE and routes normally.
--     Re-verified for this file.
--
--  AND THE OTHER THREE PUBLISHED TABLES, named so that this list is actually
--  exhaustive rather than merely long. supabase_realtime has twelve members;
--  00036 and 00096 added three that predate the four migrations above.
--
--   ratings — NO CHANGE and none possible to want. /leaderboard subscribes
--     UNFILTERED, so it would hear a PK-only delete anyway, and live-rating.tsx
--     filters on `player_id=eq.<the viewer>` for a row that is created with the
--     player and only ever UPDATEd. Nothing deletes a rating outside of a
--     player deletion, which removes the viewer along with it.
--   announcements and announcement_reads — NO CHANGE, and the gap cannot reach
--     them: both listeners in bottom-nav.tsx are `event: 'INSERT'`. A delete
--     has nothing to route to, filtered or not.
--
-- SO: of twelve published tables, two get FULL, two get a trigger, eight get
-- nothing and each of the eight is accounted for above.
--
-- ------------------------------------------------------------
-- WHY RLS-ON-DELETE CANNOT BITE EITHER OF THE TWO
-- ------------------------------------------------------------
-- Realtime's handling of RLS for DELETE payloads is not something this file
-- wants to depend on being remembered correctly — the old tuple is the only
-- thing there is to test a policy against, and with default replica identity it
-- is a bare primary key, so the behaviour is at best subtle.
--
-- IT IS MADE MOOT RATHER THAN LOOKED UP. Both tables set to FULL below have a
-- SELECT policy of `USING (TRUE)` for `authenticated` — attendance_select
-- (00005:111) and tournament_events_select (00022:102). Every signed-in member
-- can already SELECT every row and every column of both through PostgREST. So
-- whether Realtime applies RLS to a DELETE, and whichever way it applies it,
-- the set of people who can see these columns does not change. That property is
-- the reason these two tables are safe to change and the three text-carrying
-- ones would not be even if their policies read the same, and it is why the
-- guard tests below pin the list rather than trusting a future reader to redo
-- this paragraph.
--
-- ------------------------------------------------------------
-- WHAT THIS COSTS, MEASURED RATHER THAN WAVED AT
-- ------------------------------------------------------------
-- ADDITIONAL DATA REACHING SUBSCRIBERS — the whole of it:
--
--   * On a session_attendance DELETE or UPDATE, an `old` record containing the
--     seven columns of the previous row: id, session_id, player_id,
--     checked_in_at, status, marked_by, marked_at. Four ids, two timestamps,
--     one enum. NO NAME, no note, no free text of any kind — the table has
--     never had a text column (00001:266 plus 00008's three additions, which
--     are the whole history of its shape). The `new` record for an UPDATE
--     already carried exactly these columns.
--
--   * On a tournament_events DELETE or UPDATE, an `old` record of the same
--     columns the `new` record already streams: event_type, format,
--     match_format, seeding_method, status, competition_category and seed_by
--     (all TEXT but all machine values — five of the seven are CHECK-
--     constrained enumerations and the other two are method names), plus
--     integers, booleans, ids and timestamps.
--
--   NOTHING NEW IN KIND, on either table. Publishing already streams every
--   column of the NEW row on every INSERT and UPDATE; FULL adds the OLD row,
--   drawn from the same column list. No column becomes visible that was not
--   visible before, to nobody who could not already read it.
--
--   ONE EVENT THAT IS NEWLY DELIVERED AND IS NOT A REMOVAL, listed because
--   "what additional data reaches subscribers" should not quietly mean "the
--   data I was aiming at". deleteSessionImpl (actions/sessions.ts:467) clears a
--   session's attendance rows before deleting the session itself, so deleting a
--   session now refreshes anyone holding that session's door list open. Its
--   `session_id` matches their filter, so it routes like any other removal.
--   That is correct — the list they are watching has ceased to exist and the
--   refresh is what tells them — but it was not the case being fixed.
--
-- ADDITIONAL WAKE-UPS: one, from part 3, and it is bounded to a single
--   tournament. Removing an entrant from event A now bumps event A's row, and
--   the `tournament_events` listener is filtered by `tournament_id`, so every
--   screen watching THAT TOURNAMENT refreshes — including one open on a sibling
--   event B. That is the granularity the tournament_events listener already has
--   by design (00113 chose tournament-wide deliberately, so that an event
--   created after the page loaded is not missed). No screen watching a
--   different tournament, and no player screen anywhere else, hears anything.
--   The events are also coalesced client-side at 700ms.
--
-- ADDITIONAL WAL: FULL doubles the tuple written for an UPDATE or DELETE on two
--   small tables. session_attendance is one narrow row per attendee per session;
--   tournament_events is a handful of rows per tournament, updated when an exec
--   presses a button. Neither is a volume table and neither has a column wider
--   than a UUID.
--
-- NOT CHANGED, DELIBERATELY: the callbacks still call router.refresh() rather
-- than merging the payload. That is what re-derives every capability gate from
-- the viewer's own credentials, and it is the reason a wider payload is not a
-- wider exposure — nothing in an `old` record is ever rendered. It is also why
-- part 3 works at all: the refresh re-reads from the server, so the removed row
-- disappears without the delete event ever being needed.
-- ============================================================


-- ============================================================
-- 1. session_attendance — THE DOOR
-- ============================================================
-- 00112:41 already enumerated this table's columns to argue it was safe to
-- publish: "session_id, player_id, checked_in_at, status, marked_by and
-- marked_at — four ids and two timestamps. No NAME is in it." That sentence is
-- the entire case for this statement, because FULL streams the same columns
-- from the old row that publication already streams from the new one.
--
-- Re-verified against the schema rather than quoted on trust: 00001:266 creates
-- id/session_id/player_id/checked_in_at and 00008:14 adds status (the
-- `attendance_status` enum), marked_by and marked_at. No other migration alters
-- the table. There is no text column to leak and there never has been.
--
-- THE FILTER STILL WORKS AND IS STILL WHAT KEEPS THIS QUIET. With FULL, the
-- old tuple carries `session_id`, so `session_id=eq.…` can finally match a
-- DELETE. Thursday's door list still does not hear Tuesday's — the fix is that
-- the filter can now be EVALUATED, not that it has been removed.
--
-- GUARDED ON relreplident RATHER THAN RUN BLIND. Re-setting the same replica
-- identity is harmless in itself, but ALTER TABLE takes an ACCESS EXCLUSIVE
-- lock, and a migration set that is piped in by hand and re-run is one where a
-- no-op should cost no lock at all. 'f' is FULL; 'd' is the default.
--
-- WRITTEN AS A LITERAL STATEMENT INSIDE THE BLOCK, NOT EXECUTE format(...).
-- Same reason 00113:145 gives for writing its four ALTERs out longhand: the
-- guard tests read this directory as TEXT and cannot see through a constructed
-- string. An EXECUTE here would make the change invisible to the very test that
-- exists to pin it.
DO $$
BEGIN
  IF (SELECT relreplident FROM pg_class WHERE oid = 'public.session_attendance'::regclass) <> 'f' THEN
    ALTER TABLE public.session_attendance REPLICA IDENTITY FULL;
  END IF;
END
$$;


-- ============================================================
-- 2. tournament_events — THE OVERVIEW
-- ============================================================
-- The cleanest of 00113's four, in its own words: "nineteen columns of format,
-- seeding and status, and not one of them free text". Re-verified column by
-- column rather than quoted, because 00106, 00107, 00109 and 00111 have all
-- touched the table since:
--
--   TEXT columns:  event_type, format, match_format, seeding_method, status
--                  (all five CHECK-constrained to a fixed list), seed_by
--                  (00046, a seeding method name) and competition_category
--                  (00111, a category label). Machine values, chosen from menus.
--   everything else: ids, integers, booleans, timestamps.
--
-- NO COLUMN HERE IS WRITTEN BY A HUMAN IN PROSE. That is the test, and it is
-- the test the other three tournament tables fail.
--
-- THIS IS ALSO THE TABLE PART 3 LEANS ON, so its own deletes routing is not
-- incidental: deleteTournament removes participants and then events, and with
-- this statement in place both halves reach the watchers instead of the first
-- half nudging a screen that then keeps drawing an event that is gone.
DO $$
BEGIN
  IF (SELECT relreplident FROM pg_class WHERE oid = 'public.tournament_events'::regclass) <> 'f' THEN
    ALTER TABLE public.tournament_events REPLICA IDENTITY FULL;
  END IF;
END
$$;


-- ============================================================
-- 3. THE ENTRY LISTS — TOUCH THE PARENT INSTEAD
-- ============================================================
-- tournament_participants and tournament_pairs are the surface 00113 named as
-- the one that actually costs something, and they are the two tables that may
-- NOT take the fix above:
--
--   tournament_participants.notes — the withdrawal / disqualification reason.
--   tournament_pairs.notes        — the same, for a pair.
--   tournament_pairs.pair_name    — member-chosen and "often a real name"
--                                   (00113:88).
--
-- 00118 moved the two `notes` columns into private tables for exactly this
-- family of reason and DID NOT DROP THE ORIGINALS — its header explains why and
-- writes out the follow-up DROP COLUMN for a later hand. So the columns are
-- still there and still hold every note written before that migration ran. FULL
-- on either table would stream them on delete. That is the line this file does
-- not cross, and it is worth being precise about where the line is: those
-- columns already stream on INSERT and UPDATE today, so this is not a claim
-- that FULL would "undo" 00118. It is narrower and it is enough — FULL would
-- put that text on the wire in a path where today it is not, and it would
-- create a coupling that has to be revisited the day the DROP COLUMN runs.
-- The trigger below has no such coupling and needs no revisiting.
--
-- SO THE DELETE IS MADE TO PRODUCE AN EVENT ON A ROW THAT *IS* PUBLISHED AND
-- *DOES* CARRY THE FILTER COLUMN. Removing an entry touches its parent event;
-- subscribers see an UPDATE on `tournament_events` matching
-- `tournament_id=eq.…`; the callback calls router.refresh(); the server
-- re-reads the entry list without the removed row. The delete event is never
-- needed because nothing was ever going to be read out of it.
--
-- WHY THIS IS A TRIGGER AND NOT TWO LINES IN participants.ts:
--
--   * It cannot be forgotten. A future fifth delete path — a bulk withdrawal, a
--     cascade from somewhere new, a hand-typed DELETE at a psql prompt during a
--     tournament — gets the behaviour for free. The three delete paths this
--     file inherited were themselves discovered by reading, and the next one
--     will not announce itself.
--   * It cannot be skipped by the cascade. tournament_pairs rows disappear by
--     ON DELETE CASCADE in more places than they are deleted explicitly.
--   * It keeps the change out of apps/admin/src/lib/tournament-actions/
--     entirely, which is being edited elsewhere.
--
-- WHY updated_at IS THE RIGHT COLUMN TO MOVE, checked rather than assumed:
--
--   * NOTHING READS IT. No `.order('updated_at')` exists anywhere in either app
--     or in packages/, on this table or any other, and no surface renders an
--     event's updated_at. Grepped for both before writing this. So bumping it
--     reorders nothing and contradicts no label.
--   * THE CONSOLE ALREADY BUMPS IT THE SAME WAY, by hand, in six places —
--     events.ts:302 and :424, brackets.ts:1089, :1436, :1496 and :1522 — because
--     tournament_events is NOT in 00004's set_updated_at trigger list, so
--     nothing sets it automatically. This trigger is that same convention
--     applied to a path that was missing it.
--   * IT IS ALSO SIMPLY TRUE. The event's entry list changed. `SET id = id`
--     would emit the same WAL tuple and say less.
--
-- FOR EACH STATEMENT WITH A TRANSITION TABLE, NOT FOR EACH ROW. deleteTournament
-- (actions/tournaments.ts:332) deletes every participant of a tournament in ONE
-- statement, and a row-level trigger would fire once per entrant and emit one
-- WAL update per entrant — a forty-person tournament becoming forty wake-ups
-- for the same fact. The statement-level form collapses that to a single UPDATE
-- over the DISTINCT parents, and behaves identically for the single-row
-- removeParticipant path. OLD TABLE transition tables need PG 10; this is 15.
--
-- WHAT HAPPENS WHEN THE PARENT IS THE THING BEING DELETED, which is the case
-- worth thinking about and is safe: deleting an event cascades to its
-- participants, this trigger fires, and its UPDATE matches ZERO ROWS because
-- the parent is already gone in this transaction. No error, no resurrection,
-- nothing emitted. The event's own delete routes on its own now (part 2). Same
-- for deleteTournament's cascade to pairs.
--
-- NO RECURSION IS POSSIBLE: the trigger fires on DELETE against two tables and
-- writes to a third, which has no triggers of its own.
--
-- SECURITY DEFINER, and it is not reflexive. Today only service_role can write
-- these tables ("Service write tournament_participants", 00005:435), and
-- service_role would not need it. It is here so that the day a member-facing
-- withdrawal path is added, the trigger does not turn every such delete into a
-- permission error on tournament_events — a failure that would present as "the
-- withdraw button is broken" and take an hour to trace to this file. The grant
-- it lends is bounded to setting updated_at on rows the transition table
-- already names, search_path is pinned, and it can neither read nor return
-- anything.
CREATE OR REPLACE FUNCTION public.touch_event_on_entry_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- DISTINCT because one statement can remove several entries from one event,
  -- and the point of the statement-level form is to emit one tuple per event
  -- rather than one per entry.
  UPDATE public.tournament_events e
     SET updated_at = NOW()
   WHERE e.id IN (SELECT DISTINCT r.event_id FROM removed_entries r);

  -- AFTER STATEMENT triggers ignore the return value; NULL is the convention.
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.touch_event_on_entry_delete() IS
  'Bumps tournament_events.updated_at when entries are removed from an event, so the DELETE produces a Realtime event on a published row that carries tournament_id. Under default replica identity a DELETE tuple is the primary key alone, so the entry tables'' own event_id-filtered subscriptions never receive it; tournament_participants and tournament_pairs cannot take REPLICA IDENTITY FULL because both still carry the notes column 00118 privatised but did not drop. See 00120.';

-- DROP-then-CREATE rather than CREATE IF NOT EXISTS, which Postgres does not
-- offer for triggers before 14. This is 00118:436's idempotence pattern.
DROP TRIGGER IF EXISTS touch_event_on_participant_delete ON public.tournament_participants;
CREATE TRIGGER touch_event_on_participant_delete
  AFTER DELETE ON public.tournament_participants
  REFERENCING OLD TABLE AS removed_entries
  FOR EACH STATEMENT EXECUTE FUNCTION public.touch_event_on_entry_delete();

DROP TRIGGER IF EXISTS touch_event_on_pair_delete ON public.tournament_pairs;
CREATE TRIGGER touch_event_on_pair_delete
  AFTER DELETE ON public.tournament_pairs
  REFERENCING OLD TABLE AS removed_entries
  FOR EACH STATEMENT EXECUTE FUNCTION public.touch_event_on_entry_delete();
-- Both triggers name their transition table `removed_entries` so that ONE
-- function serves both. The alias is fixed by the trigger definition, not by
-- the function, so the names must agree.


-- ============================================================
-- 4. WHAT THIS FILE DOES NOT DO
-- ============================================================
-- NO ALTER PUBLICATION APPEARS HERE, and none is needed: every table this file
-- touches is already a member of supabase_realtime (00112, 00113). The guard
-- tests in both apps assert that the private note tables of 00117 and 00118 are
-- never added to it, and this file adds nothing to it at all.
--
-- NO NEW REPLICA IDENTITY BEYOND THE TWO ABOVE. Those guards have been extended
-- to pin that list by name, in both apps, on the same reasoning that pins the
-- publication: `players` may never take FULL either — 00032 revoked table-level
-- SELECT and re-granted a column whitelist, and logical replication does not
-- consult column grants, so FULL on `players` would stream `email` and `phone`
-- from every deleted or updated row. It is not published, so that is currently
-- unreachable; the assertion is there so it stays unreachable by two locks
-- rather than one.
--
-- IDEMPOTENT THROUGHOUT: both replica identity changes are guarded on
-- relreplident so a re-run takes no lock, the function is CREATE OR REPLACE,
-- and each trigger is dropped before it is created. Re-running the whole file
-- changes nothing.
--
-- NOTHING HAPPENS UNTIL THIS IS RUN. Unlike the publication migrations, the
-- failure mode here is not silence-that-looks-like-life: it is exactly the
-- behaviour of the last three months. Removals keep reaching only the exec who
-- made them, via revalidatePath, and everything else keeps working.
--
--
-- ============================================================
-- 5. FOUND WHILE TRACING THE DELETE PATHS, NOT FIXED HERE
-- ============================================================
-- deleteTournament (apps/admin/src/lib/actions/tournaments.ts:332) reads
--
--     await adminClient.from('tournament_participants').delete()
--       .eq('tournament_id', tournamentId);
--
-- and `tournament_participants` HAS NO `tournament_id` COLUMN. It has
-- `event_id` and `player_id` and never had a third (00001:290, unaltered
-- since; the generated types agree at database.gen.ts:2652). The table that
-- does carry `tournament_id` is `legacy_tournament_participants`, which is a
-- different table.
--
-- So that statement resolves to a 42703 that PostgREST returns as an error, and
-- the call site discards it — a bare `await` with no destructuring, unlike the
-- `const { error }` on :335 three lines below. IT HAS NEVER DELETED ANYTHING.
--
-- NOT A DATA BUG TODAY, which is why it is a note rather than a fix: :333
-- deletes the tournament's events one line later, and `tournament_participants
-- .event_id` is ON DELETE CASCADE, so the entries go anyway. The statement is
-- dead, not wrong. Worth writing down because the next person to read :332 will
-- assume, as this file's author briefly did, that it is the path that clears a
-- tournament's entries, and will reason about ordering on that basis.
--
-- IT DOES NOT WEAKEN THE CHOICE OF `FOR EACH STATEMENT` ABOVE. The cascade from
-- :333 removes every entry of every event in one statement per table, which is
-- the same bulk shape and the same argument. If :332 is ever repaired to say
-- `.in('event_id', …)` the trigger already handles it.
