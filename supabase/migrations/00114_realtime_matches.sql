-- ============================================================
-- 00114_realtime_matches.sql — publish the four tables club play actually
-- moves through, so a result lands on the screens watching for it
-- ============================================================
-- WHY
-- ---
-- Five surfaces subscribe to postgres_changes on these tables:
--
--   apps/player/src/components/live-matches.tsx        (the shared hook)
--     <- apps/player/src/app/feed/page.tsx                 (the club river)
--     <- apps/player/src/app/my-stats/page.tsx             (the member's own
--                                                           derived numbers)
--     <- apps/player/src/app/challenges/page.tsx           (the challenge list)
--     <- apps/player/src/app/challenges/[id]/actions.tsx   (one challenge)
--   apps/admin/src/app/matches/live-matches.tsx        (the console)
--     <- apps/admin/src/app/matches/page.tsx
--
-- A club match is watched by somebody who is not the person typing, exactly
-- like a tournament draw and unlike almost everything else in this app. Two
-- people play, ONE of them submits the score, and the other is sitting on a
-- phone waiting to be asked to confirm it. `revalidatePath` on the submit path
-- covers the submitter and nobody else — so the opponent's /challenges list,
-- their challenge page, their /my-stats and the whole club's /feed all sat on
-- whatever they rendered when they were opened.
--
-- /feed is the sharpest case and the reason this file is not merely a nicety:
-- apps/player/src/lib/actions/matches.ts revalidates `/challenges`,
-- `/challenges/[id]`, `/leaderboard` and `/my-stats` and NEVER `/feed`. The
-- club river is therefore not live for ANYONE today, not even the person who
-- just submitted the result that belongs in it. For that one surface these
-- listeners are not an improvement on revalidatePath, they are the only
-- mechanism it has.
--
-- *** NOTHING HAPPENS UNTIL THIS FILE IS RUN. ***
--
-- A subscription to a table that is not a member of `supabase_realtime`
-- SUCCEEDS and then never fires: .subscribe() resolves, the callback simply
-- never runs, nothing errors anywhere. That is not hypothetical — it is what
-- 00036 was written to fix after the leaderboard and the announcements badge
-- shipped "live" and were silently static for months, with 00096, 00112 and
-- 00113 following for the same reason. Until this is applied all five surfaces
-- behave exactly as they did before: correct on load, correct after the
-- viewer's own write, stale otherwise.
--
-- WHAT DECIDED THE LIST: not what the pages READ, which is a much longer list
-- taking in `players`, `ratings`, `seasons`, `sessions`, `session_attendance`,
-- `announcements`, `walkovers`, `disputes`, `reliability_metrics` and
-- `season_final_ratings`, but what the RESULT write paths MUTATE and a watching
-- surface has to re-read. Between them submit_match_result, apply_match_result
-- (00041), adminCreateMatch, voidMatch, convertMatchToCasual, resolveDispute
-- and apply_walkover_result write exactly these four tables plus `match_games`,
-- `ratings` (published since 00036), `head_to_head_stats`, `partnership_stats`,
-- `reliability_metrics`, `notifications` and `audit_logs`. The last five are
-- covered or excluded below.
--
-- SAFE TO PUBLISH, TABLE BY TABLE
-- -------------------------------
-- Publishing a table streams its rows to every subscribed client, filtered by
-- RLS, so the question each time is "does this hand out something a query would
-- not". All four answer no, and the structural reason is the same one that
-- makes them publishable where `players` is not: NO COLUMN OF ANY OF THESE FOUR
-- IS WITHHELD FROM `authenticated` BY A COLUMN-LEVEL GRANT.
--
-- HOW THAT WAS ESTABLISHED, by two different methods, said precisely because
-- this is the load-bearing claim of the whole file. For `matches` and
-- `match_participants` it was QUERIED: information_schema.column_privileges on
-- the live database returns zero withheld columns for either (the same check
-- also cleared `match_games`, which is not published here for other reasons).
-- For `challenges` and `challenge_participants` it was NOT queried — it is
-- inferred from the migrations, which is weaker and is flagged as such: no
-- GRANT or REVOKE statement anywhere in this directory names either table, and
-- the only column-grant surgery in the entire schema is 00032 on `players` and
-- 00111 on `players.competition_category`. If that inference is ever worth
-- hardening, the query is
--
--   SELECT table_name, column_name, privilege_type
--     FROM information_schema.column_privileges
--    WHERE grantee = 'authenticated'
--      AND table_name IN ('challenges', 'challenge_participants');
--
-- and what it should show is a table-level grant with no per-column rows.
--
-- The only REVOKEs touching `matches` and `match_participants` are 00072's
-- TRUNCATE, REFERENCES and TRIGGER, which are not SELECT privileges and have
-- nothing to do with what replication streams.
--
--   matches. RLS enabled (00005:33). SELECT policy matches_select,
--     `FOR SELECT TO authenticated USING (TRUE)` (00005:164). Every signed-in
--     member can already read every row. Carries challenge_id, tournament_id,
--     session_id and season_id, which is what lets one listener be scoped to a
--     single challenge; it carries NO player column, which is why nothing here
--     is scoped per member on this table — see the note on scoping below.
--
--     IT CARRIES FREE TEXT, and two fields of it. `score_summary` is the
--     scoreline, which is the point. `admin_note` is the exec's own words on a
--     void or a conversion to casual, and it streams verbatim to every
--     subscriber. THAT IS NOT A NEW EXPOSURE AND THIS FILE DOES NOT FIX IT:
--     matches_select is USING (TRUE) with no column grant against it, so any
--     signed-in member can already ask PostgREST for `admin_note` directly and
--     has been able to since 00005. Publishing changes the delivery mechanism,
--     not the audience. It is called out here because a publication is exactly
--     the place somebody will later look to ask "who can see this", and the
--     honest answer is "everyone, already". Narrowing it is a separate change
--     to the SELECT policy or the grant, and deliberately not attempted here.
--
--   match_participants. RLS enabled (00005:34), SELECT policy mp_select,
--     `FOR SELECT TO authenticated USING (TRUE)` (00005:192). THE ONE THAT
--     MAKES A MEMBER'S OWN STATS LIVE, and the only per-member key in this
--     whole set: it is the sole table here with a `player_id` column, so
--     `player_id=eq.<me>` is expressible on it and on nothing else. Ten
--     columns of ids, ratings and counters — pre_rating, post_rating,
--     rating_delta, points, games, win_flag, team_side — and not one of them
--     free text. apply_match_result (00041:276) UPDATEs post_rating,
--     rating_delta and win_flag on this table for every participant of every
--     confirmed match, which is precisely the event /my-stats needs to hear.
--
--   challenges. RLS enabled (00005:31), SELECT policy challenges_select,
--     `FOR SELECT TO authenticated USING (TRUE)` (00005:125). Where a
--     challenge's STATUS lives, and it has to be published rather than inferred
--     from the participant rows: when the other party accepts or rejects, the
--     row that changes is THEIRS, and the viewer's own challenge_participants
--     row does not move at all. `challenges.status` is the only thing that
--     records "this challenge is now accepted" in a form the other side can
--     hear. Free text: `note`, the member-written line attached to a challenge,
--     same USING (TRUE) reasoning as above.
--
--   challenge_participants. RLS enabled (00005:32), SELECT policy cp_select,
--     `FOR SELECT TO authenticated USING (TRUE)` (00005:144). Carries
--     `player_id`, so it is the second per-member key here and the one that
--     tells a member a challenge has been ISSUED TO THEM — that arrives as an
--     INSERT of their own participant row, which routes to a filtered
--     subscriber because an INSERT's WAL tuple is the new row. No free text:
--     ids, a role, a team side, a confirmation status and a timestamp.
--
-- NO NAME REACHES A CLIENT THROUGH THIS. All four tables carry ids; the feed,
-- the history table and the head-to-head card show names because the SERVER
-- joins `players` when it re-renders. Every callback calls router.refresh()
-- rather than merging the socket payload into local state, so the console's
-- capability gates (matches.create.write, matches.void.write, the dispute and
-- walkover controls) and the player app's standing gates are all re-evaluated
-- server-side on the viewer's own credentials, and a live update cannot
-- surface what a static render withheld.
--
-- CONSIDERED AND REJECTED
-- -----------------------
-- The house rule from 00036 stands: publish only what the UI actually listens
-- to.
--
--   * players — must NEVER be published, and this file is the one where the
--     temptation was real, because every surface here renders names. 00032 did
--     not change the players_select RLS policy; it REVOKED table-level SELECT
--     and re-granted a column whitelist. POSTGRES LOGICAL REPLICATION DOES NOT
--     HONOUR COLUMN-LEVEL GRANTS, so publishing that table would stream `email`
--     and `phone` to every subscriber whose row filter passes — the exact
--     columns 00032 exists to withhold, handed back through a channel that
--     never consults the grant. No subscription-side filtering could contain
--     it either: any member can open their own socket and ask for anything.
--     The names on these screens stay server-rendered, which is why every
--     callback here is refresh-only.
--
--   * head_to_head_stats and partnership_stats — the obvious candidates for
--     "make a member's stats live", and both correctly left out. They are
--     written ONLY by update_head_to_head() and update_partnership_stats()
--     (00003:246, 00003:739), which are called ONLY by trigger_match_confirmed
--     (00004:59), an AFTER UPDATE OF result_status trigger on `matches`. A
--     trigger runs inside the transaction of the statement that fired it, so
--     their writes and the `matches` UPDATE and the `match_participants`
--     UPDATEs all commit together — and logical decoding emits nothing until
--     COMMIT. Any match_participants event a client receives therefore
--     GUARANTEES the h2h and partnership rows from that same transaction are
--     already visible to the refresh that follows. Publishing them would add
--     two tables, two more listeners and a second wake-up per confirmation to
--     deliver information the first refresh already carried.
--
--     They are also the two tables in this neighbourhood with MULTIPLE FOREIGN
--     KEYS TO `players` (player_a_id, player_b_id), which is the shape that
--     makes a bare PostgREST embed ambiguous — the reader answers 300 and
--     supabase-js resolves rather than rejects, so the surface reads as empty
--     rather than broken. /my-stats embeds both with named constraints for
--     that reason. Not publishing them keeps that hazard off the socket
--     entirely.
--
--   * match_games — written by submit_match_result, adminCreateMatch and the
--     dispute `edited` path, and read by the challenge detail page, so it looks
--     like it belongs. It does not, on two counts. Every write to it is
--     accompanied by a write to `matches` in the same flow — the dispute path
--     DELETEs and re-INSERTs the games and then UPDATEs `matches.score_summary`
--     (disputes.ts:63-77), and that UPDATE is what routes — so a listener on it
--     would only ever fire alongside one that already did. And it is
--     UNFILTERABLE for every purpose here: its only foreign key is match_id, so
--     neither "this member's games" nor "this challenge's games" is
--     expressible, and the only available subscription is every game score in
--     the club on every screen.
--
--   * disputes, walkovers — rendered on the console beside the matches they
--     concern, but a dispute or a walkover always moves `matches.result_status`
--     with it (dispute_match_result 00027, apply_walkover_result 00003:485),
--     and the console's listener on `matches` is unfiltered. So both are
--     already covered by a table that is published, and adding them would be a
--     second wake-up for one event.
--
--   * reliability_metrics, notifications, audit_logs — written by the same
--     confirm path, and none of the five surfaces above renders any of them
--     live. audit_logs additionally carries unbounded `old_value`/`new_value`
--     JSONB and is admin-gated.
--
--   * tournament_matches and friends — a DIFFERENT table from `matches` and
--     already published by 00113. Tournament scoring never touches `matches`;
--     club play never touches `tournament_matches`. Neither file's listeners
--     can hear the other's traffic, which is correct.
--
-- NO COLUMN LISTS, AND NOT BY CHOICE. A publication column list must contain
-- every replica-identity column; replica identity here is left at the DEFAULT,
-- the primary key `id`, which is not a column anybody would want in such a
-- list. So `admin_note` cannot be stripped at the publication even though it is
-- the one field on these four tables somebody might want stripped. Default
-- replica identity is still the right setting: the callbacks only need to know
-- that something changed, and REPLICA IDENTITY FULL would stream every deleted
-- row's entire contents — `admin_note` included — to every subscriber, to close
-- a gap described below that none of these surfaces depends on.
--
-- FOUR SEPARATE GUARDED STATEMENTS, one per table, rather than one ADD TABLE
-- with four names or a loop. Same two reasons as 00113. A single four-name ADD
-- is all-or-nothing: if a later hand-run has already added one of them the
-- whole statement raises "relation is already member of publication" and the
-- other three never land. And a loop would have to build the statement with
-- EXECUTE format(...), which the publication guard tests
-- (apps/{player,admin}/src/lib/__tests__/realtime-publication.test.ts) read as
-- TEXT and cannot see through — the guard would conclude these tables are
-- unpublished and fail, which is the correct behaviour for a test that cannot
-- tell. Written out, it can.
--
-- IDEMPOTENT, like 00096, 00112 and 00113 and unlike 00036's bare ADD: a
-- migration that cannot be piped in twice is a migration nobody dares re-run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'matches'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.matches;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'match_participants'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.match_participants;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'challenges'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.challenges;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'challenge_participants'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.challenge_participants;
  END IF;
END
$$;

-- WHAT THESE SUBSCRIPTIONS WILL NOT DELIVER, and where the gap actually bites.
--
-- Under default replica identity a DELETE's WAL tuple carries only the primary
-- key, so no other column is there for `filter` to match on and a FILTERED
-- subscriber is never routed the event. An UNFILTERED subscriber IS — the
-- primary key is enough to route when nothing has to be matched — which is one
-- more reason the console watches `matches` without a filter.
--
-- Working through every delete that can reach these four tables:
--
--   1. discardIncompleteMatch (apps/admin/src/lib/actions/matches.ts:178) is
--      the only DELETE against `matches` in the entire codebase. It is the
--      rollback arm of adminCreateMatch: if the participant or game INSERTs
--      fail, the half-built match row is removed, guarded by .eq on the status
--      it was created with. `match_participants` rows go with it by ON DELETE
--      CASCADE, and a cascade delete's tuple is also PK-only, so `player_id` is
--      not in it and a member's filtered listener never learns of it.
--
--      SURVIVABLE, and this is the one that matters: the match being discarded
--      never rendered anywhere. It existed for the few hundred milliseconds
--      between a failed INSERT and its cleanup, and no surface had drawn it.
--      The console, being unfiltered, hears the delete regardless.
--
--   2. resolveDispute's `edited` branch DELETEs `match_games`
--      (apps/admin/src/lib/actions/disputes.ts:63) before re-inserting the
--      corrected scores. `match_games` is not published, so nothing here is
--      listening for it — and the same function then UPDATEs `matches` with the
--      new score_summary, which every listener does hear.
--
--   3. NOTHING DELETES `challenges` OR `challenge_participants`. Verified
--      against both the app tree and every migration: there is no DELETE
--      statement against either, in SQL or through PostgREST. A challenge is
--      cancelled, rejected or expired by moving `challenges.status`, and a
--      status move is an UPDATE, which is delivered normally. This is the
--      answer to the obvious worry about a withdrawn challenge vanishing from
--      somebody else's list: it does not vanish, it changes status, and that
--      change routes.
--
-- So no surface in this change depends on hearing a row disappear. The two
-- alternatives are both worse than the gap — REPLICA IDENTITY FULL streams
-- every deleted row's full contents (including `admin_note`) to every
-- subscriber, and dropping the filters wakes a member's phone for every other
-- member's match.
--
-- ONE MORE THING A LISTENER CANNOT HEAR, and it is not a replication limit.
-- adminCreateMatch INSERTs an UNRATED match with result_status already
-- 'confirmed' (matches.ts:235). An AFTER UPDATE trigger does not fire on an
-- INSERT, so trigger_match_confirmed never runs and head_to_head_stats and
-- partnership_stats are never written for that match — and reverse_match_result
-- (00003:708) does not decrement them either, so a voided match leaves those
-- counters inflated. Both are pre-existing data-integrity gaps in the schema,
-- both are visible on /my-stats, and NEITHER IS CAUSED OR FIXED BY THIS FILE.
-- They are written down here because this is the migration that makes those
-- cards update promptly, and a number that refreshes quickly is a number
-- somebody will finally notice is wrong.
--
-- WORTH KNOWING BEFORE THIS IS RUN, and still true as of 00113: staging's
-- supabase_realtime publication was EMPTY until recently — 00036 had never been
-- applied there — so check pg_publication_tables before assuming `ratings` is
-- live on whichever database this is going to. That matters for this change
-- because /my-stats and /feed already mount LiveRating, which depends on
-- `ratings` and nothing else. Reapplying 00036 is 00036's job, not this file's.
