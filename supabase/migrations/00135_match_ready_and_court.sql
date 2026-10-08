-- ============================================================
-- 00135 — the two things a member needs at a live event: where to go,
--         and a way to tell the desk they are standing there
-- ============================================================
-- TWO CHANGES, ONE FILE, because they are one surface. A member courtside asks
-- the desk exactly one question — "where do I go, and do you know I'm here?" —
-- and the desk asks the mirror of it. Both answers now live on the SAME ROW of
-- tournament_matches, which is what makes them arrive together over the one
-- Realtime channel both apps already hold open.
--
-- *** RUN THIS BEFORE DEPLOYING THE CODE. ***
--
-- Not the usual "order is free" note, and not 00109's opposite rule either.
-- The player event page selects tournament_matches by NAMED COLUMN LIST
-- (apps/player/src/app/tournaments/[id]/events/[eventId]/page.tsx) and wraps
-- the result in `unwrap`, which RAISES on res.error. PostgREST fails the WHOLE
-- request on one unknown column, so a build that names `ready_player_ids`
-- against a database without it does not degrade — it throws, and the event
-- page 500s for every member. Applying this file early is harmless: nothing
-- reads the column until that build ships, and every row starts empty.
--
-- The admin console selects `*` for matches, so it is order-insensitive in both
-- directions. Only the player app pins the order, and it pins it this way.
--
-- ============================================================
-- A. THE COURT — the column already exists, and that is the finding
-- ============================================================
-- "give us a location setter / show which location the match is at before the
-- score", then: "so we can tell them where to play through the app".
--
-- The second sentence is the design. This is not a record kept for tidiness —
-- it is the MECHANISM by which the desk directs a member to a court, replacing
-- somebody shouting across a gym. That is why it has to be the most legible
-- thing on the member's own match row, and why "not set yet" has to read as a
-- state rather than as a blank.
--
-- NO COLUMN IS ADDED. `tournament_matches.court TEXT` has existed since 00001
-- (schema.sql, under `-- Scheduling`, beside scheduled_time). It is already
-- SELECTed by the player event page, already rendered there, and already drawn
-- on the console's bracket-card meta strip. What has never existed is a WRITE
-- PATH — stated as fact in the console's own copy today:
--
--     "the console has no idea whether a match is on court right now (nothing
--      writes tournament_matches.court or the 'live' match status...)"
--     — EventHeader.tsx
--
-- A repo-wide grep agrees: two readers, zero writers. So the app change is an
-- action and a control, and this file's business with `court` is one CHECK.
--
-- WHY FREE TEXT AND NOT A VENUE/COURT MODEL. `sessions.location` exists and
-- holds "West Gym" / "East Gym", but a court WITHIN a venue is a different
-- granularity and the club has no table for it, no numbering it has agreed, and
-- no request for one. A model would have to be seeded per tournament before the
-- desk could use it at all, which is a setup step somebody has to remember at
-- 9am on a Saturday. An exec types "3". The column is already TEXT. Keep it.
--
-- WHY IT NEEDS A LENGTH LIMIT ANYWAY, and this is the part that is not
-- cosmetic. tournament_matches is PUBLISHED to supabase_realtime (00113), and
-- logical replication does not consult column grants — 00117, 00118 and 00125
-- exist because exec-typed free text on THIS TABLE streamed verbatim to every
-- subscribed member. `court` is exec-typed free text on that same table, and it
-- is about to acquire its first writer.
--
-- It is different from `notes` in the one way that matters: BROADCASTING IT IS
-- THE FEATURE. A court number is an announcement, not a confidence. So it is
-- not privatised — it is bounded, so that it cannot quietly BECOME a second
-- notes field. 32 characters is room for "Court 3", "Court 12 (East Gym)" or
-- "Show Court", and no room for a sentence about why somebody was defaulted.
--
-- NOT VALID, DELIBERATELY. The evidence that nothing has ever written this
-- column is a grep over the CURRENT tree plus a comment; neither is evidence
-- about rows production accumulated under builds that no longer exist. A plain
-- ADD CONSTRAINT would fail the whole migration on one long legacy row, at the
-- console, by hand, with no way to see which row did it. NOT VALID binds every
-- future write immediately and leaves the past alone. If the owner wants the
-- back history checked too:
--
--     ALTER TABLE tournament_matches VALIDATE CONSTRAINT tournament_matches_court_len;
--
-- which takes only a SHARE UPDATE EXCLUSIVE lock and can be run any time.
--
-- There is no ADD CONSTRAINT IF NOT EXISTS, hence the DO block — the same guard
-- 00080 used for this table's other two CHECKs.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.tournament_matches'::regclass
      AND conname  = 'tournament_matches_court_len'
  ) THEN
    ALTER TABLE public.tournament_matches
      ADD CONSTRAINT tournament_matches_court_len
      CHECK (court IS NULL OR length(court) <= 32)
      NOT VALID;
  END IF;
END
$$;

COMMENT ON COLUMN public.tournament_matches.court IS
  'Where this match is being played, as the desk types it — "3", "Court 3", "East Gym 2". Free text on purpose: the club has no court model and a venue/court table would be a setup step nobody asked for. Set from the console (tournament-actions/scheduling.ts setMatchCourt) and shown to the member on their own match row BEFORE the score, because telling them where to go is the whole point. NULL means the desk has not assigned one yet, which the player app renders as "Court TBC" rather than as nothing. Bounded to 32 chars by tournament_matches_court_len: this table is published to supabase_realtime and replication ignores column grants, so unbounded exec free text here is the exact shape 00117/00118/00125 had to undo. Broadcasting a court number IS the feature, so it stays public — it is bounded, not privatised.';

-- ============================================================
-- B. WHO IS ACTUALLY STANDING THERE
-- ============================================================
-- The bug that prompted this. The player event page renders the match status as
-- `<span className="chip capitalize">{matchStatus}</span>`, which for a match at
-- status 'ready' paints a bordered uppercase READY in the right-hand slot next
-- to the member's name. It looks exactly like a button. The owner pressed it
-- repeatedly and reported "it has never worked". It is a label.
--
-- He chose to make it do what it looks like, which turns out to be the thing the
-- desk is missing: right now nobody at the scoring table knows whether the
-- person whose match is up is even in the building.
--
-- NOTE THE COLLISION OF NAMES, because it is a trap. `tournament_matches.status
-- = 'ready'` already exists and means "both sides are known" — it is written by
-- setMatchEntry and read by the bracket. It says nothing about anybody being
-- present. This is a different fact and it gets a different column.
--
-- ------------------------------------------------------------
-- PER PERSON, NOT PER ENTRY — and why that ruled out the obvious homes
-- ------------------------------------------------------------
-- In doubles all four people matter and knowing one of four has turned up is
-- worth something to whoever is deciding which match to call next. So the unit
-- is a PERSON.
--
-- tournament_participants was the first candidate and it cannot hold this. Since
-- 00102 a member in a doubles event is EITHER an unpaired entrant (a participant
-- row) OR half of a formed pair — and the second "has no participant row at
-- all", in the player app's own words. A formed pair is exactly the case this
-- feature is for, so the table that would carry the flag is the table those
-- people are missing from.
--
-- tournament_pairs cannot hold it either, and its failure is worse than
-- inconvenient. Per-person state there means player1_ready / player2_ready,
-- which is POSITIONAL — and 00103 gave the console swap_pair_member. Swap the
-- half that had tapped ready and the incoming player inherits "present". A flag
-- that says the wrong person is standing at the desk is worse than no flag.
--
-- ------------------------------------------------------------
-- WHY NOT A CHILD TABLE, WHICH IS THE TIDY ANSWER
-- ------------------------------------------------------------
-- The relationally clean shape is tournament_match_ready(match_id, player_id).
-- It was written out and rejected, because in THIS deployment every one of its
-- four costs is a failure that is invisible when you get it wrong:
--
--   1. A new table in `public` arrives with Supabase's ALTER DEFAULT PRIVILEGES
--      grants already on it — anon included — so it is public by default and the
--      REVOKE is the lock (00117:85, 00118:273).
--   2. Missing SELECT for `authenticated` fails the WHOLE PostgREST request with
--      403, supabase-js RESOLVES rather than rejects, and it renders as empty
--      data. That has silently emptied five player screens here (00115).
--   3. A subscription to a table that is not in `supabase_realtime` SUCCEEDS and
--      then never fires. Nothing errors, anywhere (00036, 00113).
--   4. Both apps' realtime-publication guard tests scan for table names inside
--      the postgres_changes literals, so a new subscription is a fifth place to
--      get right.
--
-- Putting the flag on tournament_matches costs NONE of those. The table is
-- already granted, already published, and already subscribed with `draw` by both
-- the player event page and the console. A court set at the desk and a ready tap
-- from a phone travel the same wire, in the same UPDATE, into the same
-- router.refresh(). That is not a saving — it is the coordinator's one hard
-- requirement ("it has to arrive") answered by construction rather than by new
-- plumbing.
--
-- ------------------------------------------------------------
-- WHAT GOES ON THE WIRE
-- ------------------------------------------------------------
-- Player UUIDs and nothing else. No name, no free text, no timestamp anybody
-- could reconstruct a movement from. tournament_matches already streams
-- participant ids, pair ids and the elo_snapshot JSONB (player ids with
-- before/after ratings), so this adds no CLASS of data the row did not carry —
-- and names appear in the UI only because the SERVER joins `players` when it
-- re-renders. There is nothing here for a subscriber to read that a subscriber
-- could not already read.
--
-- NOT A TIMESTAMP PER PERSON, and that is a real decision rather than laziness:
-- "when did she tap it" would be the one genuinely new thing on the wire, it is
-- a movement record, and no screen asks for it. The desk wants "is she here".
--
-- NOT NULL DEFAULT '{}' so every read is an array and no consumer needs a
-- COALESCE. Postgres rewrites nothing for a defaulted ADD COLUMN on a modern
-- server, so this is not a table rewrite even on a live event.

ALTER TABLE public.tournament_matches
  ADD COLUMN IF NOT EXISTS ready_player_ids UUID[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.tournament_matches.ready_player_ids IS
  'The players who have said they are present and ready to play THIS match — the member from their own phone, or an exec at the desk on their behalf. One entry per person, so a doubles match can be 3 of 4. Distinct from tournament_matches.status = ''ready'', which means only that both sides are known and says nothing about anybody being in the building. Lives here rather than on tournament_participants (a formed pair has no participant rows since 00102) or tournament_pairs (player1_/player2_ prefixes are positional, and swap_pair_member from 00103 would hand the flag to the wrong person). Written ONLY through set_match_ready(), which is atomic — two teammates tapping at the same second must not overwrite each other. MATCH-SCOPED, so a new round starts empty; deliberately NOT cleared when the match goes live or completed — the UI stops offering and stops showing it, and the row is deleted with the match when a draw is regenerated. Carries UUIDs only: this table is published to supabase_realtime and replication ignores column grants.';

-- ============================================================
-- C. THE ONLY WRITER
-- ============================================================
-- WHY AN RPC WHEN THE APP ALREADY HOLDS THE SERVICE-ROLE KEY. Not permission —
-- CONCURRENCY. Appending to an array from the app is read-modify-write: two
-- members of the same pair tapping "I'm ready" in the same second both read the
-- array as it was and the second write erases the first. In a gym with four
-- people on one match that is not a theoretical race. One UPDATE statement takes
-- the row lock and the interleaving stops existing.
--
-- It also lets the membership check be ATOMIC with the write. The house rule for
-- this app is that authorization lives in the action, because the service-role
-- key bypasses RLS and "a policy would look like protection and do nothing"
-- (apps/player/src/lib/tournament-actions.ts). That rule stands and the action
-- still does the gating. What is HERE is the invariant, per the same file's
-- other rule: the things that cannot be repaired from the console are the ones
-- that moved into the database. "Only somebody actually in this match can be
-- marked ready for it" is one of those — a stray id in this array is data
-- nobody can see to fix.
--
-- SECURITY INVOKER, NOT DEFINER, and it is worth saying why the safer-sounding
-- one is the wrong one. Only the service-role client calls this, and service_role
-- already owns full rights on the table, so DEFINER buys nothing. What INVOKER
-- buys is that if a future migration re-grants EXECUTE to anon, the function
-- still cannot write anything: it runs as the caller, and 00128 revoked anon's
-- table privileges on tournament_matches. Belt from the REVOKE below, braces
-- from the security model.
--
-- SET search_path regardless — an INVOKER function is still resolved against the
-- caller's path, and a `public` shadowed by a temp schema is the classic route
-- in.

CREATE OR REPLACE FUNCTION public.set_match_ready(
  p_match_id  UUID,
  p_player_id UUID,
  p_ready     BOOLEAN
)
RETURNS UUID[]
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_in_match BOOLEAN;
  v_status   TEXT;
  v_result   UUID[];
BEGIN
  -- Both disciplines in one EXISTS. A singles slot names a tournament_participants
  -- row that carries player_id; a doubles slot names a tournament_pairs row that
  -- carries two of them. A match is one or the other, never both, so the OR is
  -- exclusive in practice and the query is a single index probe either way.
  SELECT
    m.status,
    EXISTS (
      SELECT 1 FROM tournament_participants tp
       WHERE tp.id IN (m.participant_a_id, m.participant_b_id)
         AND tp.player_id = p_player_id
    )
    OR EXISTS (
      SELECT 1 FROM tournament_pairs tpr
       WHERE tpr.id IN (m.pair_a_id, m.pair_b_id)
         AND p_player_id IN (tpr.player1_id, tpr.player2_id)
    )
  INTO v_status, v_in_match
  FROM tournament_matches m
  WHERE m.id = p_match_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Match not found' USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT v_in_match THEN
    RAISE EXCEPTION 'That player is not in this match' USING ERRCODE = 'check_violation';
  END IF;

  -- A match that has been played, walked over or voided is not something anybody
  -- can turn up for. Refused here as well as hidden in the UI, because the UI is
  -- a courtesy and this is the boundary. 'pending' is allowed: the desk marking
  -- somebody present before their opponent is even known is exactly the case the
  -- feature is for.
  IF v_status IN ('completed', 'walkover', 'voided', 'disputed') THEN
    RAISE EXCEPTION 'This match is finished' USING ERRCODE = 'check_violation';
  END IF;

  -- ONE STATEMENT, so the row lock covers the read and the write together.
  -- array_append would duplicate on a double tap and array_remove is a no-op on
  -- an absent id, so the pair below is idempotent in both directions — which is
  -- what makes a control that has already been pressed safe to press again on a
  -- flaky gym connection.
  UPDATE tournament_matches
     SET ready_player_ids = CASE
           WHEN p_ready THEN
             CASE WHEN p_player_id = ANY(ready_player_ids)
                  THEN ready_player_ids
                  ELSE ready_player_ids || p_player_id
             END
           ELSE array_remove(ready_player_ids, p_player_id)
         END,
         updated_at = now()
   WHERE id = p_match_id
   RETURNING ready_player_ids INTO v_result;

  RETURN v_result;
END;
$$;

-- THE ROLES ARE NAMED, and 00126/00127/00131 are the reason. Supabase ships
-- ALTER DEFAULT PRIVILEGES that grant EXECUTE to `anon` and `authenticated` as
-- EXPLICIT ACL entries on every function created in this schema. `REVOKE ... FROM
-- PUBLIC` removes only the `=.../postgres` entry and leaves those two untouched.
-- Written without the roles, the two lines below would leave a function taking an
-- ARBITRARY p_player_id callable by anyone holding the anon key — which ships in
-- the client bundle. That is 00127's write-up almost word for word, and this
-- function has exactly the signature it warns about.
--
-- The argument list is spelled out because REVOKE and GRANT resolve by signature,
-- and a future overload would otherwise silently keep the old ACL.
REVOKE ALL PRIVILEGES ON FUNCTION public.set_match_ready(uuid, uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_match_ready(uuid, uuid, boolean)
  TO service_role;

COMMENT ON FUNCTION public.set_match_ready(uuid, uuid, boolean) IS
  'Add or remove one player from tournament_matches.ready_player_ids, atomically. The ONLY writer of that column. Called with the service-role key from apps/player/src/lib/tournament-actions.ts (the member, for themselves) and apps/admin/src/lib/tournament-actions/scheduling.ts (an exec at the desk, gated on tournaments.draw.checkin.mark.write and audited). Refuses a player who is not in the match and a match that is already finished. Idempotent in both directions, so a double tap on a bad connection is safe. EXECUTE is service_role only — the signature takes an arbitrary p_player_id, so an anon or authenticated grant here would let anyone holding the client bundle''s anon key mark anyone ready.';

-- ============================================================
-- D. WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ============================================================
-- NO GRANT, ANYWHERE, FOR THE COLUMN. Both new facts live on tournament_matches,
-- whose table-level privileges 00128 already settled: anon revoked,
-- `authenticated` holding the schema-wide grant it has had since 00001. There is
-- no column-level ACL on this table — 00032's column surgery was done to
-- `players` and, since 00116, to `sessions`, and to nothing else — so a new
-- column inherits the table's grant and needs no line here. That is the whole
-- reason the design put it on this table: the grant that would have been
-- forgotten is a grant that does not exist.
--
-- The proof is empirical rather than inferred: `court` is on this table, is
-- selected by the player app today under the `authenticated` role, and returns
-- rows. A missing grant would have made that request a 403 rendering as empty
-- data, which is what 00115 is the write-up of.
--
-- NO ALTER PUBLICATION. tournament_matches has been a member of
-- supabase_realtime since 00113. Adding a column to a published table needs
-- nothing — the WAL carries the whole new tuple, and an UPDATE's new tuple has
-- `event_id` in it, which is what both apps' `filter: event_id=eq.` matches on.
-- No REPLICA IDENTITY change either: that only affects DELETEs, and nothing
-- deletes a match to clear a court.
--
-- NO NOTIFICATION when a court is reassigned mid-event, and this was considered
-- rather than missed. A member who has read "Court 3" and now needs Court 5 is
-- the interesting case, and the live refresh already covers it: the desk's UPDATE
-- reaches the phone on the channel above and the line rewrites itself. A push on
-- top of that needs a new notification type, a per-member preference, and a
-- judgement about what earns an interruption that the owner has not made. It is
-- cheap to add later on top of this column; it is not cheap to un-send.
--
-- NO tournament_audit_log ROW FOR A MEMBER'S OWN TAP. An exec marking somebody
-- else ready is audited, because that is one person asserting something about
-- another. A member toggling their own flag is not, or the first busy Saturday
-- writes a few hundred rows saying nothing.
