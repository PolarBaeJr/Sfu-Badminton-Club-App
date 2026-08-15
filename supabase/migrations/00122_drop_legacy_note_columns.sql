-- ============================================================
-- 00122_drop_legacy_note_columns.sql — the follow-up 00117 and 00118 asked for,
-- and the two columns it cannot take
-- ============================================================
-- 00117 moved `matches.admin_note` into a private table and 00118 did the same
-- for four more columns of exec-written free text. NEITHER DROPPED THE OLD
-- COLUMN, deliberately: the owner applies migrations by hand and deploys code
-- separately, so at the moment either file ran a build was still selecting
-- them, and a dropped column is a 42703 that supabase-js RESOLVES rather than
-- rejects — an EMPTY SCREEN, not an error (00115 is the write-up, from the time
-- it emptied five player screens). Both headers therefore wrote the drop out for
-- a later hand and named the precondition: run it once no deployed build
-- references the columns.
--
-- THE PRECONDITION IS NOW MET. Production has been running the post-sweep code
-- since 2026-08-15. Nothing in either app writes any of the five columns, and
-- every read of them is a `select('*')` whose consumer already coalesces a
-- missing value to null — the audit is written out below, per column, because
-- "nothing reads it" is the claim this whole file rests on.
--
-- IT DROPS THREE OF THE FIVE. Two of them are still written — not by the apps,
-- but by plpgsql functions this database runs today, which neither 00117 nor
-- 00118 accounted for. See "THE TWO THAT STAY", which is the important half of
-- this file.
--
-- ------------------------------------------------------------
-- WHAT IS READ, PER COLUMN, AS OF THIS COMMIT
-- ------------------------------------------------------------
-- The failure mode being guarded against is a NAMED select — `select('a, b')`
-- with a dropped column in the list — because PostgREST fails the WHOLE request
-- on an unknown column. A `select('*')` is unaffected: the key is simply absent
-- from the row and `?? null` does the rest. So the audit below distinguishes the
-- two, and every named select in both apps was checked against every one of
-- these five names, including the multi-line template-literal forms.
--
--   matches.admin_note
--     No read anywhere. The player app's challenge detail page was narrowed to
--     named columns in 00117's own commit and `admin_note` is not among them.
--     `create-match.tsx` and validators/schemas.ts still carry an `admin_note`
--     FIELD — that is the form payload the action reads and forwards to
--     match_admin_notes, not the column; actions/matches.ts:437 stopped writing
--     the column. actions/matches.ts:580 destructures `admin_note` off that
--     same payload to keep it out of the audit row. Neither touches the table.
--
--   tournament_pairs.notes
--     One read: the admin event page, off `select('*')` (page.tsx:158). The
--     player app's event page reads pairs with a NAMED list and `notes` is not
--     in it. Not written anywhere — exitDrawImpl (participants.ts:917) updates
--     `{ status }` alone since 00118.
--
--   tournament_matches.notes
--     Two reads, both off `select('*')`: the admin event page (page.tsx:291,
--     `matchNotes.get(id) ?? m.notes ?? null`) and unvoidMatchImpl
--     (results.ts:831, `priorNotes.get(id) ?? match.notes ?? null`). Both are
--     already fallbacks BEHIND the private table, both coalesce to null, and
--     both keep compiling because the generated Row type is untouched (below).
--     The player app's event page reads tournament_matches with a NAMED list
--     that deliberately excludes `notes`. Not written anywhere.
--
-- Those three are dropped. The other two are not, and the reason is not a read.
--
-- ------------------------------------------------------------
-- THE TWO THAT STAY, AND WHY — THIS IS THE POINT OF THE FILE
-- ------------------------------------------------------------
-- Both 00117 and 00118 audited the APPS. Neither audited the plpgsql, and two
-- of the five columns are written from inside a function. A dropped column named
-- in a plpgsql statement raises 42703 when that statement is first planned —
-- which is at RUN time, in the middle of a body that has already done work.
-- That is not an empty screen, it is a broken write with a half-applied effect
-- behind it. Dropping either of these would be strictly worse than leaving it.
--
--   walkovers.admin_notes — apply_walkover_result
--     00003:578, last redefined by 00049:181, still live:
--
--         UPDATE walkovers SET
--           status = 'confirmed', … admin_notes = p_admin_notes, …
--
--     00118 KNEW the function writes this column and reasoned about it: it made
--     confirmWalkover stop PASSING `p_admin_notes` (it is `DEFAULT NULL`), so
--     the function writes NULL into a column nobody reads, and called the
--     parameter "dead weight until the drop migration above removes it". The
--     step it did not take is that the drop cannot happen without redefining
--     the function, because the UPDATE names the column whether or not the
--     caller supplies a value. And this UPDATE runs AFTER `apply_match_result`
--     has moved Elo and created the match row, inside a SECURITY DEFINER body:
--     a 42703 there aborts the confirmation with the rating already applied in
--     the same transaction — so the transaction rolls back and every walkover
--     confirmation in the console simply stops working.
--
--   tournament_participants.notes — unpair_tournament_pair
--     00102:289, and this one is worse than an oversight about a drop:
--
--         INSERT INTO tournament_participants
--           (event_id, player_id, status, elo_before, added_by, notes)
--         SELECT …, CASE WHEN h.player_id = p_withdrawn_player_id
--                        THEN p_reason ELSE NULL END
--
--     `p_reason` IS THE WITHDRAWAL REASON — the same exec free text 00118 exists
--     to privatise — and it is written into the published column TODAY, by the
--     current build, from participants.ts:1392. 00118's header states that this
--     column "has exactly ONE writer and it is elsewhere: exitDrawImpl". That is
--     FACTUALLY WRONG, and the consequence is not only that the column cannot be
--     dropped: the privacy fix is not merely awaiting a drop on this column, it
--     is STILL LEAKING. tournament_participants is published by 00113, so every
--     unpair-with-withdrawal streams the exec's reason to every bracket
--     subscriber, and tournament_participant_notes never receives it at all.
--
-- NEITHER FUNCTION IS REDEFINED HERE, and that is a considered choice rather
-- than the easy one. 00049 — the last migration to touch apply_walkover_result
-- — says it plainly: plpgsql cannot be patched in part, so any change means
-- reproducing ~150 lines of a SECURITY DEFINER body that applies rating
-- penalties and auto-suspension counters, verbatim, by hand. 00118 accepted a
-- non-atomic note write rather than take that risk. Taking it HERE, in a
-- migration whose whole job is to remove things, would mean a hand-transcribed
-- Elo path riding along with a column drop — the two changes would be applied
-- together and diagnosed together, and only one of them is reversible.
-- unpair_tournament_pair is smaller, but its fix is a design question and not a
-- transcription (the note needs the participant id, which only exists after the
-- INSERT, so it wants a RETURNING and a second statement), and doing it here
-- would smuggle a behaviour change into a cleanup.
--
-- THE FOLLOW-UP, WRITTEN OUT SO IT IS NOT REDISCOVERED. One migration each,
-- redefining the function and dropping its column together, because neither
-- half is safe alone:
--
--   * apply_walkover_result: carry the body over verbatim from the live
--     definition, delete `admin_notes = p_admin_notes` from the UPDATE, then
--       ALTER TABLE public.walkovers DROP COLUMN IF EXISTS admin_notes;
--     DROPPING `p_admin_notes` FROM THE SIGNATURE NEEDS AN EXPLICIT
--       DROP FUNCTION public.apply_walkover_result(uuid, uuid, text);
--     CREATE OR REPLACE matches on the ARGUMENT LIST — 00049 says so in its own
--     header — so a two-argument definition would mint a SECOND overload and
--     leave the three-argument body live for anything still passing three.
--     Until then `p_admin_notes` is not dead weight: it is the parameter whose
--     UPDATE keeps the column alive. Leave it, documented, which is what this
--     file does.
--
--   * unpair_tournament_pair: drop `notes` from the INSERT column list, take the
--     ids it already reads back (or a RETURNING) and INSERT the withdrawal
--     reason into tournament_participant_notes instead — atomically, which is
--     better than what the app does elsewhere — then
--       ALTER TABLE public.tournament_participants DROP COLUMN IF EXISTS notes;
--     Its signature is unchanged, so CREATE OR REPLACE suffices. That migration
--     should also BACKFILL, because every unpair-with-withdrawal since 00118 has
--     written the reason to the column and nowhere else; the sweep in section 1
--     below picks those up now, and re-running it there picks up any since.
--
-- ------------------------------------------------------------
-- THE SWEEP COMES FIRST, AND IT IS WHAT MAKES THE DROP LOSSLESS
-- ------------------------------------------------------------
-- 00117 and 00118 COPIED rather than moved, and both said their backfills were
-- written to be re-run afterwards to sweep up whatever the old build wrote in
-- the interim. Nobody has re-run them. Between the day each file was applied and
-- the day the new code reached production, the running build kept writing the
-- old columns, and those rows exist only there.
--
-- So section 1 re-runs the backfill for ALL FIVE columns — including the two
-- that are not dropped, which costs nothing and is the only thing that has ever
-- captured what unpair_tournament_pair has been writing — and section 2 drops
-- the three. Same transaction, sweep before drop, so the drop cannot lose a row
-- rather than being believed not to. That is also the honest answer to "prove
-- the data was copied": this file does not assert it, it re-establishes it.
--
-- The sweeps are byte-for-byte the ones in 00117 and 00118, ON CONFLICT DO
-- NOTHING and all — DO NOTHING rather than DO UPDATE because a note an exec has
-- since edited through the new table must not be overwritten by the stale value
-- still sitting in the old column. Note the one thing DO NOTHING therefore does
-- NOT do: where a private note already exists for a parent, an older value still
-- sitting in the legacy column is not copied and is lost with the drop. That is
-- the right precedence — the private table holds the note the console has been
-- reading and editing, the column holds a superseded one — but it is a choice,
-- not an identity, and this file is the last chance to disagree with it.
--
-- ------------------------------------------------------------
-- THIS FILE IS WRAPPED IN BEGIN / COMMIT, AND 00109 IS NOT
-- ------------------------------------------------------------
-- Every other migration in this directory, the last drop-a-column one (00109)
-- included, is a bare sequence of statements: the owner pipes the file into
-- psql, each statement autocommits, and that is fine for files that only ADD
-- things or only REMOVE things, because a half-applied one can be finished by
-- re-running it.
--
-- THIS FILE MOVES DATA BEFORE REMOVING ITS SOURCE, which is the one shape where
-- ordering is not enough. Unwrapped, and without ON_ERROR_STOP, a sweep that
-- raised partway would be followed by three DROP COLUMNs running anyway — psql
-- reports the error and carries on to the next statement — and the rows that
-- sweep had not reached yet would go with the columns. That is precisely the
-- loss the section above claims is impossible, so the claim has to be
-- established rather than asserted. BEGIN / COMMIT establishes it: either every
-- row lands in a private table and the three columns go, or nothing happens and
-- the file can simply be run again.
--
-- Nothing here forbids a transaction — no CREATE INDEX CONCURRENTLY, no
-- ALTER TYPE ... ADD VALUE, no VACUUM. If this file is ever applied by a runner
-- that already opens its own transaction, the BEGIN is a no-op with a warning
-- and the COMMIT ends the runner's transaction at the end of the file, which is
-- where it would have ended anyway.
--
-- ------------------------------------------------------------
-- WHAT THIS CLOSES, PRECISELY, AND WHAT IT DOES NOT
-- ------------------------------------------------------------
-- AFTER THIS FILE, three of the five exposures are gone and two remain:
--
--   matches            published (00114). No longer carries the text.  CLOSED.
--   tournament_matches published (00113). No longer carries it.        CLOSED.
--   tournament_pairs   published (00113). No longer carries it.        CLOSED.
--   tournament_participants  published (00113), STILL carries `notes`, and
--                      unpair_tournament_pair STILL WRITES IT. Withdrawal
--                      reasons continue to stream to every bracket subscriber
--                      on every UPDATE of the row, and continue to be readable
--                      through PostgREST by any signed-in member.   STILL OPEN.
--   walkovers          in NO publication, so `admin_notes` never streamed. It
--                      stays readable through PostgREST under walkovers_select,
--                      which admits `forfeit_player_id` — the forfeiting member
--                      can still read the exec's verdict on their own forfeit,
--                      for rows written before 00118.               STILL OPEN.
--
-- NO ALTER PUBLICATION AND NO REPLICA IDENTITY CHANGE APPEARS IN THIS FILE, and
-- the second one is worth stating because this file looks like the invitation.
-- Both apps' guard tests say "THIS LIST SHRINKS ONLY WHEN THE COLUMNS ARE
-- DROPPED", and three of them now are — but the list must NOT shrink:
--   * tournament_pairs still carries `pair_name`, which is member-chosen and,
--     per 00113:88, is often a real name.
--   * tournament_participants still carries `notes`.
--   * matches and tournament_matches would gain nothing from FULL, and 00120
--     reached for a parent-touching trigger precisely to avoid it.
-- 00120's comment on touch_event_on_entry_delete names BOTH entry tables as
-- carrying `notes`; after this file only tournament_participants does. The
-- sentence is stale, its conclusion is not, and an applied migration is not
-- edited in place.
--
-- THE GENERATED TYPES ARE NOT REGENERATED, deliberately.
-- packages/shared/src/types/database.gen.ts and database.ts still declare
-- `tournament_matches.notes`, `tournament_pairs.notes` and `matches.admin_note`.
-- Removing them would turn `m.notes` at
-- apps/admin/src/app/tournaments/[id]/events/[eventId]/page.tsx:291 and
-- `match.notes` at results.ts:831 into type errors — both are the deliberate
-- legacy fallbacks described above, both still compile and still evaluate to
-- null once the column is gone, and removing a fallback is a separate change
-- from removing the column it falls back to. The types describing a column that
-- no longer exists is the safe direction of that drift: it permits a read that
-- returns undefined, it does not demand one.
--
-- IDEMPOTENT throughout: every sweep guarded on its source column still
-- existing and ending in ON CONFLICT DO NOTHING, every drop DROP COLUMN IF
-- EXISTS. Re-running the whole file changes nothing. The guard is what lets the
-- sweep and the drop sit in one file at all — on a second run the three source
-- columns are gone, their guards are false, and the sweeps are skipped rather
-- than raising 42703. The static SQL sits inside EXECUTE for the same reason
-- 00117 and 00118 put it there: a plain statement naming a dropped column fails
-- to PARSE even on a branch that never runs.
-- ============================================================

-- One transaction for the whole file. See "THIS FILE IS WRAPPED IN BEGIN /
-- COMMIT" above: the sweep below has to be durable before the drop after it
-- removes what it read, and only this makes that true rather than likely.
BEGIN;


-- ============================================================
-- 1. SWEEP — every row the old build wrote after 00117/00118 were applied
-- ============================================================
-- All five columns, including the two that survive section 2. Byte-for-byte the
-- backfills from 00117 and 00118; see those files for why each COALESCE and each
-- NULL::uuid is what it is.

DO $$
BEGIN
  -- matches.admin_note -> match_admin_notes (00117). Dropped below.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'matches'
       AND column_name = 'admin_note'
  ) THEN
    EXECUTE $sql$
      INSERT INTO public.match_admin_notes (match_id, note, author_id, created_at, updated_at)
      SELECT m.id, m.admin_note, NULL::uuid,
             COALESCE(m.updated_at, m.created_at, NOW()), NOW()
        FROM public.matches m
       WHERE m.admin_note IS NOT NULL AND btrim(m.admin_note) <> ''
      ON CONFLICT (match_id) DO NOTHING
    $sql$;
  END IF;

  -- tournament_participants.notes -> tournament_participant_notes (00118).
  -- NOT dropped below, and this is the sweep that matters most of the five:
  -- unpair_tournament_pair has been writing withdrawal reasons straight into
  -- this column the whole time, so for those rows the private table is empty and
  -- this is the first thing that has ever copied them across. It will need
  -- running again by the migration that fixes the function.
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

  -- tournament_pairs.notes -> tournament_pair_notes (00118). Dropped below.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tournament_pairs'
       AND column_name = 'notes'
  ) THEN
    EXECUTE $sql$
      INSERT INTO public.tournament_pair_notes
        (pair_id, note, author_id, created_at, updated_at)
      SELECT p.id, p.notes, NULL::uuid, COALESCE(p.created_at, NOW()), NOW()
        FROM public.tournament_pairs p
       WHERE p.notes IS NOT NULL AND btrim(p.notes) <> ''
      ON CONFLICT (pair_id) DO NOTHING
    $sql$;
  END IF;

  -- tournament_matches.notes -> tournament_match_notes (00118). Dropped below.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tournament_matches'
       AND column_name = 'notes'
  ) THEN
    EXECUTE $sql$
      INSERT INTO public.tournament_match_notes
        (match_id, note, author_id, created_at, updated_at)
      SELECT m.id, m.notes, NULL::uuid,
             COALESCE(m.updated_at, m.created_at, NOW()), NOW()
        FROM public.tournament_matches m
       WHERE m.notes IS NOT NULL AND btrim(m.notes) <> ''
      ON CONFLICT (match_id) DO NOTHING
    $sql$;
  END IF;

  -- walkovers.admin_notes -> walkover_admin_notes (00118). NOT dropped below.
  -- The one sweep of the five that recovers a real author: admin_confirmed_by is
  -- written by the same statement that wrote admin_notes.
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
-- 2. DROP — the three with no reader and no writer left
-- ============================================================
-- In the same transaction as the sweep above, which is the whole point: the
-- values reach the private tables before the columns holding them cease to
-- exist, or neither happens.
--
-- IF EXISTS on each, so a re-run is a no-op rather than a 42703. A DROP COLUMN
-- takes an ACCESS EXCLUSIVE lock but does not rewrite the table — Postgres marks
-- the attribute dropped and reclaims the space on the next rewrite — so this is
-- fast on tables of this size regardless of row count.

ALTER TABLE public.matches            DROP COLUMN IF EXISTS admin_note;
ALTER TABLE public.tournament_pairs   DROP COLUMN IF EXISTS notes;
ALTER TABLE public.tournament_matches DROP COLUMN IF EXISTS notes;

-- NOT DROPPED, and each is still written by a live plpgsql function. See "THE
-- TWO THAT STAY" above — dropping either raises 42703 inside a SECURITY DEFINER
-- body mid-effect, which is worse than the exposure it would close:
--
--   ALTER TABLE public.tournament_participants DROP COLUMN IF EXISTS notes;
--     -- blocked by unpair_tournament_pair (00102:289), which still WRITES the
--     -- withdrawal reason here. Fix the function first, in the same migration.
--
--   ALTER TABLE public.walkovers DROP COLUMN IF EXISTS admin_notes;
--     -- blocked by apply_walkover_result (00003:578, 00049:181), whose UPDATE
--     -- names the column even though confirmWalkover no longer passes
--     -- p_admin_notes. Redefine the function and drop the parameter — with an
--     -- explicit DROP FUNCTION, see above — in the same migration.


-- ============================================================
-- 3. SAY SO ON THE TABLES
-- ============================================================
-- The three private tables whose source column is now gone say "Superseded X,
-- which is left in place until no deployed build selects it". That sentence has
-- stopped being true and a reader checking it would go looking for a column that
-- no longer exists. Restated in full rather than patched, because COMMENT ON has
-- no partial form. The other two tables' comments are left exactly as they are —
-- their source columns really are still there.

COMMENT ON TABLE public.match_admin_notes IS
  'Exec-written free text about one match — the create form''s Admin Note, and the reasons recorded by voidMatch and convertMatchToCasual. PRIVATE: no grant for anon/authenticated, RLS on with no policy, and deliberately NOT a member of supabase_realtime. Read only by the console through the service-role key, gated in the app on matches.create.write / matches.void.write / matches.convert.write. Superseded matches.admin_note, which 00122 dropped once no deployed build selected it.';

COMMENT ON TABLE public.tournament_pair_notes IS
  'Exec-written reason a doubles entry was withdrawn or disqualified. Same locks, same gate and same parent-is-published reasoning as tournament_participant_notes. Superseded tournament_pairs.notes, which 00122 dropped once no deployed build selected it.';

COMMENT ON TABLE public.tournament_match_notes IS
  'Exec-written reason a tournament match was voided, recorded as a double no-show, or restored. PRIVATE: no grant for anon/authenticated, RLS on with no policy, NOT published to supabase_realtime — 00113 publishes tournament_matches, so this text streamed to every subscriber until it moved here. Gated on tournaments.results.void.write / .doublenoshow.write / .unvoid.write. Superseded tournament_matches.notes, which 00122 dropped once no deployed build selected it.';

-- The one comment that has to record a fact rather than restate a design.
-- tournament_participant_notes is INCOMPLETE for as long as
-- unpair_tournament_pair keeps writing the parent column, and a reader who
-- assumes otherwise will conclude the withdrawal reasons were never recorded.
COMMENT ON TABLE public.tournament_participant_notes IS
  'Exec-written reason a singles entry was withdrawn or disqualified. PRIVATE: no grant for anon/authenticated, RLS on with no policy, and deliberately NOT a member of supabase_realtime (its parent IS published, which is why the text had to leave). Read only by the console through the service-role key, gated on tournaments.draw.exit.write. Supersedes tournament_participants.notes, which 00122 could NOT drop: unpair_tournament_pair (00102) still writes the withdrawal reason into that column, so the reason an entry left after an unpair may exist ONLY there and still streams over Realtime. 00122 swept what was there; fix the function and drop the column together.';

COMMIT;
