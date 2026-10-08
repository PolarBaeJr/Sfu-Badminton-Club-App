-- ============================================================
-- 00118_private_free_text_sweep.sql — the rest of the exec's own words stop
-- being club-readable
-- ============================================================
-- 00117 did this for `matches.admin_note`. It was not the only such column,
-- only the first one looked at. This file finishes the sweep for the four that
-- remain, and it is a deliberate copy of 00117's shape rather than a second
-- design — read that file first; everything it argues (why a column-grant
-- revoke cannot do this job, why the REVOKE is the lock and empty-policy RLS is
-- the braces, why no SELECT policy is written for `authenticated`, why the old
-- column is not dropped) applies here verbatim and is not repeated at length.
--
-- ------------------------------------------------------------
-- THE FOUR COLUMNS, AND ONE CORRECTION TO THE BRIEF
-- ------------------------------------------------------------
-- The work was described as three fields — `tournament_participants.notes`,
-- `tournament_pairs.notes` and `walkovers.admin_notes` — with the tournament
-- pair cited at lib/tournament-actions/results.ts:618, :720 and :798. Those
-- three line numbers do not write either of those columns. They write
-- `tournament_matches.notes`, from voidMatch, recordDoubleNoShow and
-- unvoidMatch. The participant/pair column has exactly ONE writer and it is
-- elsewhere: exitDrawImpl, participants.ts:917, which branches on `isPair` and
-- so writes whichever of the two tables applies.
--
-- So there are FOUR columns, not three, and the extra one is the worst of them:
--
--   tournament_participants.notes  withdrawal / DQ reason   exitDrawImpl
--   tournament_pairs.notes         the same, for a pair     exitDrawImpl
--   tournament_matches.notes       void / no-show / restore reason
--                                                           results.ts x3
--   walkovers.admin_notes          walkover confirm/reject reason
--                                                           walkovers.ts x2
--
-- `tournament_matches.notes` is included rather than left for a later pass
-- because excluding it would have closed three quiet leaks and left the loud
-- one open: it is the only one of the four that is RENDERED anywhere
-- (ScoreEntryDialog's restore panel quotes it back), it is the one an exec
-- writes most often, and 00113 published `tournament_matches`, so it streams.
--
-- ------------------------------------------------------------
-- WHAT STREAMS, AND WHAT STOPS
-- ------------------------------------------------------------
-- 00113 put `tournament_events`, `tournament_matches`, `tournament_participants`
-- and `tournament_pairs` in `supabase_realtime` for the live-bracket screens.
-- THREE OF THE FOUR COLUMNS ABOVE THEREFORE STREAM — logical replication does
-- not consult grants or RLS row filters, which is the whole hazard 00114
-- documents for `players`. `walkovers` is in no publication, so its column
-- never streamed; it leaked the other way, through PostgREST (see below).
--
-- THE PARENT TABLES STAY PUBLISHED. That is not an oversight: the live bracket
-- is built on them and removing them would silently stop four screens updating
-- (the failure mode 00036 exists because of). What changes is that the free
-- text is no longer IN them — the new tables below are not published and both
-- apps' guard tests now assert, by name, that they never will be.
--
-- ------------------------------------------------------------
-- `walkovers_select` IS ROW-SCOPED AND STILL POINTED AT THE WRONG PERSON
-- ------------------------------------------------------------
-- 00005:222 reads
--
--   USING (reported_by = get_player_id(auth.uid())
--       OR forfeit_player_id = get_player_id(auth.uid())
--       OR is_admin(auth.uid()))
--
-- which sounds tighter than `USING (TRUE)` and, for `admin_notes`, is worse
-- than it sounds. The second disjunct is the player who FORFEITED, and
-- `admin_notes` is the exec's verdict ON that forfeit — including the reason a
-- walkover was REJECTED. The one member most motivated to read the exec's
-- private assessment of them is the one member the policy names.
--
-- THE POLICY IS LEFT ALONE, DELIBERATELY, and that is the fix rather than a gap
-- in it. The forfeiting player has a legitimate claim on the ROW: the player
-- app's /my-stats reads their own walkovers (my-stats/page.tsx:153) to show
-- reliability, and narrowing the policy would empty that screen to close a leak
-- that is really about one column. Moving the text out closes it for every
-- reader at once — a member's session cannot read `walkover_admin_notes` at
-- all, whatever `walkovers_select` says — and leaves the row where its owner
-- can still see it. The column, not the row, was the mistake.
--
-- ------------------------------------------------------------
-- FOUR TABLES, NOT ONE
-- ------------------------------------------------------------
-- One table per parent, each keyed by the parent's id, exactly as 00117 keyed
-- its table by `match_id`. The tempting alternative — a single
-- `private_notes(parent_type, parent_id, note)` — is rejected: it cannot hold a
-- foreign key, so it cannot hold the ON DELETE CASCADE that is load-bearing
-- here (below), and it would replace four natural primary keys with a composite
-- one plus a CHECK constraint enumerating the legal parent types. Four small
-- tables that are each a copy of a reviewed shape are cheaper to audit than one
-- table with a discriminator.
--
-- Participants and pairs get two tables for the same reason and it is not
-- ceremony: they are two different parent tables, so one table covering both
-- would need two nullable FKs and an exactly-one-of CHECK, and would lose the
-- primary key that makes the write an upsert.
--
-- ON DELETE CASCADE, load-bearing on all four. Every parent here has a real
-- DELETE path in the console: removeParticipant (participants.ts:754),
-- removePair (:1578), deleteTournament (actions/tournaments.ts:332) and — the
-- one that runs most — clearing a draw before regenerating it
-- (brackets.ts:194, `.delete().eq('event_id', …)` over tournament_matches).
-- Without the cascade, regenerating a bracket would hit a foreign-key violation
-- on notes belonging to matches it is entitled to erase.
--
-- author_id on all four, which none of the columns had. Same reasoning as
-- 00117: the parent's own "who" column is the wrong person. `added_by` on an
-- entry is whoever REGISTERED it, not whoever disqualified it; `submitted_by`
-- on a tournament match is not the person who voided it. ON DELETE SET NULL, so
-- removing a player does not delete the club's record of why an entry was
-- disqualified.
--
-- ONE EXCEPTION, AND IT IS A HAPPY ONE: `walkovers.admin_confirmed_by` IS the
-- exec who wrote `admin_notes` — the same statement sets both. So the walkover
-- backfill below recovers a real author instead of leaving NULL.
--
-- ------------------------------------------------------------
-- THE COLUMNS ARE NOT DROPPED
-- ------------------------------------------------------------
-- Same reasoning as 00117, and the same standing instruction. The owner applies
-- migrations by hand and deploys code separately, so a running build may still
-- be selecting these. Dropping one turns every such select into a 42703, which
-- per 00115 surfaces as an EMPTY SCREEN rather than an error. The values are
-- COPIED, the writes stop, and a later migration can drop them once no deployed
-- build references them:
--
--     ALTER TABLE public.tournament_participants DROP COLUMN IF EXISTS notes;
--     ALTER TABLE public.tournament_pairs        DROP COLUMN IF EXISTS notes;
--     ALTER TABLE public.tournament_matches      DROP COLUMN IF EXISTS notes;
--     ALTER TABLE public.walkovers               DROP COLUMN IF EXISTS admin_notes;
--
-- That follow-up should also drop `p_admin_notes` from apply_walkover_result
-- (see below), which by then will be a parameter nobody passes.
--
-- UNTIL IT RUNS THE EXPOSURE IS NOT CLOSED, IT IS MADE CLOSABLE. Historical
-- values stay in the old columns, stay readable through PostgREST, and — for
-- the three published tables — keep streaming. That is the honest description
-- of what one hand-applied step can safely do, and it is why the drop is
-- written out above rather than left to be rediscovered.
--
-- ------------------------------------------------------------
-- DEPLOY ORDER IS FREE, IN BOTH DIRECTIONS
-- ------------------------------------------------------------
-- MIGRATION FIRST, CODE LATER. Every old column still exists, so the running
-- build keeps writing and reading them and nothing errors. The new tables sit
-- empty for anything entered in the meantime; every backfill below is written
-- to be re-run afterwards to sweep exactly those rows up.
--
-- CODE FIRST, MIGRATION LATER. The console's note writes are separate
-- statements issued AFTER the parent write, and only the "no such table" family
-- is swallowed — PGRST205, PGRST202 and Postgres's own 42P01. This is a
-- DIFFERENT family from 00116's missing COLUMN (PGRST204 / 42703) and the
-- predicate is not interchangeable; lib/private-notes.ts spells that out at the
-- call site and reuses 00117's own helper rather than re-deriving it. Before
-- this file is applied: the entry is withdrawn, the match is voided, the
-- walkover is confirmed — all exactly as before — the note is dropped, the
-- AUDIT ROW STILL LANDS and records that it was dropped, and nothing on screen
-- claims a note was recorded.
--
-- READS degrade the same way: each read treats an absent table as "no notes"
-- and falls back to the legacy column while it still exists, so the restore
-- dialog keeps quoting the void reason in either order.
--
-- ------------------------------------------------------------
-- apply_walkover_result IS NOT REDEFINED HERE
-- ------------------------------------------------------------
-- `walkovers.admin_notes` is the one of the four written from inside a
-- function: apply_walkover_result sets it alongside the walkover's status, the
-- match insert, the Elo application and the reliability counters. Rewriting the
-- function to insert into `walkover_admin_notes` instead would be ATOMIC with
-- all of that, which is genuinely better than what this file does.
--
-- It is not done, for one reason: plpgsql cannot be patched in part, so the
-- change means reproducing ~150 lines of a SECURITY DEFINER function that
-- applies rating penalties and auto-suspension counters, verbatim, by hand.
-- 00049 — the last migration to touch it — says exactly this about its own
-- two-line change. The risk of a transcription slip in that body is worse than
-- the risk this file accepts, which is that a walkover confirmation and its
-- note are two statements instead of one. The note is advisory; the Elo and the
-- suspension counters are not.
--
-- SO THE CONSOLE STOPS PASSING IT. confirmWalkover omits `p_admin_notes`
-- (it is `DEFAULT NULL`), the function writes NULL into a column nobody reads,
-- and the note is written to the table below by the same helper the other five
-- call sites use. The parameter survives as dead weight until the drop
-- migration above removes it. A future hand doing that work should redefine the
-- function properly at the same time.
--
-- ------------------------------------------------------------
-- IDEMPOTENT THROUGHOUT, like 00117: IF NOT EXISTS on every table and index,
-- ENABLE ROW LEVEL SECURITY (a no-op when already on), every backfill guarded
-- on its source column still existing and ending in ON CONFLICT DO NOTHING,
-- DROP TRIGGER IF EXISTS before each trigger, and GRANT / REVOKE, which never
-- error on a privilege already held or already absent. Re-running the whole
-- file changes nothing.
--
-- NO ALTER PUBLICATION APPEARS IN THIS FILE, and none ever should. Both apps'
-- realtime-publication guard tests assert these four table names are absent
-- from every ALTER PUBLICATION in this directory.
-- ============================================================


-- ============================================================
-- 1. THE TABLES
-- ============================================================
-- Four copies of one shape. Where 00117's comments explain a column choice, it
-- is not repeated — only what differs is noted.

-- Withdrawal / disqualification reason for a SINGLES entry.
CREATE TABLE IF NOT EXISTS public.tournament_participant_notes (
  participant_id UUID PRIMARY KEY
    REFERENCES public.tournament_participants(id) ON DELETE CASCADE,
  note           TEXT NOT NULL,
  author_id      UUID REFERENCES public.players(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The same, for a DOUBLES entry. A separate table rather than a nullable second
-- FK on the one above — see the header.
CREATE TABLE IF NOT EXISTS public.tournament_pair_notes (
  pair_id    UUID PRIMARY KEY
    REFERENCES public.tournament_pairs(id) ON DELETE CASCADE,
  note       TEXT NOT NULL,
  author_id  UUID REFERENCES public.players(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Void reason, double-no-show reason, and the reason a void was RESTORED. One
-- row per match because that is what the column was: unvoidMatch overwrites the
-- void reason with the restore reason, and the restore panel quotes whatever is
-- current. A note history is a bigger feature and inventing one here would
-- smuggle it in under a privacy fix (00117 declined the same invitation).
CREATE TABLE IF NOT EXISTS public.tournament_match_notes (
  match_id   UUID PRIMARY KEY
    REFERENCES public.tournament_matches(id) ON DELETE CASCADE,
  note       TEXT NOT NULL,
  author_id  UUID REFERENCES public.players(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The exec's verdict on a walkover — the one of the four that a member could
-- already read about THEMSELVES through walkovers_select. See the header.
CREATE TABLE IF NOT EXISTS public.walkover_admin_notes (
  walkover_id UUID PRIMARY KEY
    REFERENCES public.walkovers(id) ON DELETE CASCADE,
  note        TEXT NOT NULL,
  author_id   UUID REFERENCES public.players(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.tournament_participant_notes IS
  'Exec-written reason a singles entry was withdrawn or disqualified. PRIVATE: no grant for anon/authenticated, RLS on with no policy, and deliberately NOT a member of supabase_realtime (its parent IS published, which is why the text had to leave). Read only by the console through the service-role key, gated on tournaments.draw.exit.write. Superseded tournament_participants.notes, left in place until no deployed build selects it.';

COMMENT ON TABLE public.tournament_pair_notes IS
  'Exec-written reason a doubles entry was withdrawn or disqualified. Same locks, same gate and same parent-is-published reasoning as tournament_participant_notes. Superseded tournament_pairs.notes.';

COMMENT ON TABLE public.tournament_match_notes IS
  'Exec-written reason a tournament match was voided, recorded as a double no-show, or restored. PRIVATE: no grant for anon/authenticated, RLS on with no policy, NOT published to supabase_realtime — 00113 publishes tournament_matches, so this text streamed to every subscriber until it moved here. Gated on tournaments.results.void.write / .doublenoshow.write / .unvoid.write. Superseded tournament_matches.notes.';

COMMENT ON TABLE public.walkover_admin_notes IS
  'Exec-written reason a walkover was confirmed or rejected. PRIVATE for the usual reasons plus one specific to it: walkovers_select admits forfeit_player_id, so the player who forfeited could read the exec''s verdict on their own forfeit. That policy is deliberately unchanged — the row is legitimately theirs (/my-stats reads it), the column was not. Gated on walkovers.confirm.write / walkovers.reject.write. Superseded walkovers.admin_notes.';

COMMENT ON COLUMN public.walkover_admin_notes.author_id IS
  'The exec who wrote the note. Unlike the other three tables here, the backfill recovers a real author: walkovers.admin_confirmed_by is set by the same statement that set admin_notes.';


-- ============================================================
-- 2. THE LOCKS
-- ============================================================
-- THE REVOKE IS THE LOCK. Supabase ships ALTER DEFAULT PRIVILEGES in `public`
-- granting to anon, authenticated and service_role, so a bare CREATE TABLE
-- hands `authenticated` SELECT the moment it exists — a new table here is
-- PUBLIC BY DEFAULT and these four statements are what actually close it.
-- RLS WITH NO POLICY IS THE BRACES: if a future migration re-grants the table,
-- the rows still do not come out. service_role is BYPASSRLS, so the console is
-- unaffected. 00117 argues both at length.
--
-- PUBLIC is named alongside the two roles because a privilege held by PUBLIC is
-- held by every role there is, including ones nobody has created yet.

ALTER TABLE public.tournament_participant_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_pair_notes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_match_notes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.walkover_admin_notes         ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.tournament_participant_notes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.tournament_pair_notes        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.tournament_match_notes       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.walkover_admin_notes         FROM PUBLIC, anon, authenticated;

-- Restated rather than assumed. service_role holds this by default privilege
-- today; the cost of writing it down is nothing and the cost of assuming wrong
-- is a console that cannot record a void reason.
GRANT ALL ON public.tournament_participant_notes TO service_role;
GRANT ALL ON public.tournament_pair_notes        TO service_role;
GRANT ALL ON public.tournament_match_notes       TO service_role;
GRANT ALL ON public.walkover_admin_notes         TO service_role;


-- ============================================================
-- 3. PRESERVE WHAT IS ALREADY WRITTEN
-- ============================================================
-- Copied, never moved: every source column stays exactly as it is.
--
-- Blank-but-not-null notes are skipped — none of these columns has a NOT NULL
-- or a CHECK, so '' is reachable, and an empty note is not a note.
--
-- ON CONFLICT DO NOTHING rather than DO UPDATE, and the difference matters on
-- the SECOND run: re-running this after the console has shipped must sweep up
-- rows the old build wrote in the interim, and must NOT overwrite a note an
-- exec has since edited through the new table with the stale value still
-- sitting in the old column.
--
-- created_at is the PARENT's own timestamp rather than NOW(), so a backfilled
-- note is not dated to the day the migration was run. Note that
-- tournament_participants and tournament_pairs have `created_at` but no
-- `updated_at` — hence the shorter COALESCE on those two.
--
-- EACH IS GUARDED ON ITS SOURCE COLUMN STILL EXISTING, so this file survives
-- the follow-up that drops them. Unguarded, a re-run after the DROP COLUMN
-- would raise 42703 and the migration would stop being re-runnable — which for
-- a hand-applied set is the same as ceasing to be trustworthy. The static SQL
-- sits inside EXECUTE for the same reason: a plain statement referencing a
-- dropped column fails to PARSE even on a branch that never runs.
--
-- NULL::uuid rather than a bare NULL in the author position: an untyped NULL in
-- a SELECT list resolves to `unknown`, and leaning on the INSERT target to
-- coerce it is the sort of thing that works until it does not.

DO $$
BEGIN
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

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'walkovers'
       AND column_name = 'admin_notes'
  ) THEN
    -- The only backfill of the four that recovers an author: admin_confirmed_by
    -- is written by the same statement that writes admin_notes, in both
    -- apply_walkover_result and rejectWalkover.
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
-- 4. THE INDEXES THAT ARE NOT FREE
-- ============================================================
-- Each primary key already serves the console's only read shape —
-- `in('<parent>_id', <the ids on screen>)` — so no index is added for that.
-- These four are for the foreign key: an unindexed FK makes every player
-- deletion scan the table, and removePlayer is a real console action.
-- Partial, because a backfilled row's author is NULL and those rows are not
-- what a player deletion is looking for.

CREATE INDEX IF NOT EXISTS tournament_participant_notes_author_id_idx
  ON public.tournament_participant_notes (author_id) WHERE author_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tournament_pair_notes_author_id_idx
  ON public.tournament_pair_notes (author_id) WHERE author_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tournament_match_notes_author_id_idx
  ON public.tournament_match_notes (author_id) WHERE author_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS walkover_admin_notes_author_id_idx
  ON public.walkover_admin_notes (author_id) WHERE author_id IS NOT NULL;


-- ============================================================
-- 5. KEEP updated_at HONEST
-- ============================================================
-- The upserts set it explicitly, so these are a backstop for anything written
-- by hand at a psql prompt. trigger_set_updated_at() is 00004's own function —
-- these tables are named here rather than added to 00004's loop because 00004
-- is recorded as applied on both databases and editing it would never re-run.
--
-- DROP-then-CREATE rather than CREATE IF NOT EXISTS, which Postgres does not
-- offer for triggers before 14: DROP IF EXISTS is the portable idempotent form
-- and is what makes a re-run a no-op.

DROP TRIGGER IF EXISTS set_updated_at ON public.tournament_participant_notes;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.tournament_participant_notes
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON public.tournament_pair_notes;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.tournament_pair_notes
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON public.tournament_match_notes;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.tournament_match_notes
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON public.walkover_admin_notes;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.walkover_admin_notes
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
