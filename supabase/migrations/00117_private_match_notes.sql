-- ============================================================
-- 00117_private_match_notes.sql — the exec's own words about a match stop
-- being club-readable
-- ============================================================
-- WHAT IS WRONG TODAY. `matches.admin_note` is free text an exec writes in
-- three places and nobody outside the console is meant to read:
--
--   apps/admin/src/app/matches/create-match.tsx   "Admin Note (optional)"
--     -> lib/actions/matches.ts adminCreateMatch
--   lib/actions/matches.ts voidMatch              the reason a match was voided
--   lib/actions/matches.ts convertMatchToCasual   the reason it was demoted
--
-- Every signed-in member can read all of it. `matches_select` is
-- `FOR SELECT TO authenticated USING (TRUE)` (00005:164), `matches` holds a
-- plain table-level SELECT grant for `authenticated`, and no column of it is
-- withheld — 00114 established that by querying
-- information_schema.column_privileges on the live database and wrote the
-- exposure down rather than fixing it, because fixing it was not that file's
-- job. This is that job.
--
-- Nothing in either app RENDERS the note. That is not a defence, it is the
-- reason it went unnoticed: `select('*')` on `matches` from a member's own
-- session returns it, PostgREST will answer `?select=admin_note` directly, and
-- since 00114 the row streams over Realtime as well.
--
-- ------------------------------------------------------------
-- WHY NOT A COLUMN GRANT
-- ------------------------------------------------------------
-- The one-line change — `REVOKE SELECT (admin_note) ON matches FROM
-- authenticated` — does not work here, on two independent counts, and both are
-- already documented in this directory.
--
--   1. IT WOULD BREAK READS THAT DO NOT WANT THE COLUMN. A missing column
--      grant is not a missing value: PostgREST refuses the WHOLE request with
--      403, supabase-js RESOLVES rather than rejects, and the app's `?? []` /
--      `?? null` renders the refusal as empty. 00115 is the whole write-up of
--      that failure mode, from the time it emptied five player screens. The
--      player app's challenge detail page does `select('*', …)` on `matches`
--      (apps/player/src/app/challenges/[id]/page.tsx), so the revoke would
--      silently blank the match panel on it. That select is narrowed to named
--      columns in the same commit as this file — worth doing on its own merits
--      — but a narrow select in ONE deployed build is not a guarantee about
--      every build that is running.
--
--   2. LOGICAL REPLICATION DOES NOT HONOUR COLUMN-LEVEL GRANTS. 00114 added
--      `matches` to `supabase_realtime`, so even a revoke that broke nothing
--      would keep streaming the note verbatim to every subscriber. That is the
--      exact reason `players` may never be published (00036, 00113, 00114) and
--      it applies here identically. A publication column list cannot strip it
--      either: such a list must contain every replica-identity column, and
--      00114 explains why it declined to go there.
--
-- ------------------------------------------------------------
-- WHAT THIS DOES INSTEAD
-- ------------------------------------------------------------
-- The note moves to its OWN table, which is not published to Realtime, holds
-- no grant for `anon` or `authenticated`, and has RLS on with no policy. Both
-- halves of that are written below because they defend against different
-- things; see "THE TWO LOCKS".
--
-- ONE ROW PER MATCH, not an append-only log. That is a faithful port of what
-- the column does rather than a redesign: today a void reason OVERWRITES
-- whatever the create form wrote, and the console shows one note per match.
-- `match_id` is therefore the primary key and the write path upserts. A note
-- history is a bigger feature (it wants an ordering, a renderer and a policy
-- on editing) and inventing one here would smuggle it in under a privacy fix.
--
-- ON DELETE CASCADE, and it is load-bearing rather than hygiene.
-- discardIncompleteMatch (apps/admin/src/lib/actions/matches.ts) is the only
-- DELETE against `matches` anywhere in this app, and adminCreateMatch calls it
-- on its own failure paths — AFTER the match row, and therefore after any note
-- row, already exists. Without the cascade a half-failed match entry would hit
-- a foreign-key violation during its own cleanup and leave the orphan it was
-- trying to remove.
--
-- author_id, which the column never had. Three different acts write this text
-- and "who wrote it" was recoverable for none of them: `submitted_by` is the
-- person who entered the SCORE, which for a void is precisely the wrong name.
-- ON DELETE SET NULL rather than CASCADE — removing a player must not delete
-- the club's record of why a match was voided.
--
-- ------------------------------------------------------------
-- THE TWO LOCKS, AND WHICH ONE IS LOAD-BEARING
-- ------------------------------------------------------------
-- THE REVOKE IS THE LOCK. Supabase ships `ALTER DEFAULT PRIVILEGES` in
-- `public` granting to `anon`, `authenticated` and `service_role`, so a bare
-- CREATE TABLE hands `authenticated` SELECT the moment it exists. The proof is
-- in this directory: not one table created by 00001 is followed by a `GRANT
-- SELECT … TO authenticated`, and every one of them is readable from a
-- member's session today. So a new table is PUBLIC BY DEFAULT here and the
-- REVOKE below is what actually closes it — the same reasoning, and the same
-- statement, as 00037's `email_suppressions`.
--
-- RLS WITH NO POLICY IS THE BRACES. Enabled and left empty, it denies every
-- row to every non-superuser role that is not the table owner, so if a future
-- migration or a console tool re-grants the table the rows still do not come
-- out. `service_role` is BYPASSRLS, which is why the console is unaffected.
--
-- NO SELECT POLICY IS WRITTEN FOR `authenticated`, deliberately, and this is
-- the design decision most worth arguing with. Two reasons:
--
--   * NOBODY SIGNED IN AS THEMSELVES NEEDS TO READ THIS. The console does not
--     use a member's session: every read and write on /matches goes through
--     createAdminClient(), a SUPABASE_SERVICE_ROLE_KEY client that bypasses
--     RLS entirely, and the per-viewer decision is made in the app by
--     requireCapability(). An RLS policy admitting execs would widen the
--     table's reach without any surface using it.
--
--   * THE CAPABILITY MODEL IS NOT EXPRESSIBLE IN SQL. Capabilities resolve as
--     baseline ∪ grants − revokes with area-page pruning, and that resolver
--     lives in packages/shared/src/utils/access-level.ts. The database holds
--     the vocabulary as CHECK constraints (00087, 00105) and the stored arrays
--     on `players`, and nothing else — there is no SQL function that answers
--     "does this user hold matches.void.write". A policy could only reach for
--     the coarse tools that DO exist, and each is wrong: is_admin() excludes
--     every executive, who are exactly the people who write these notes, and
--     admin_access_level() IS NOT NULL admits every varsity trainer, whose
--     three-capability baseline touches nothing in `matches`. Writing either
--     one down would state a permission rule that disagrees with the console's,
--     and the disagreement would be invisible until somebody relied on it.
--
-- WHERE THE READ IS GATED INSTEAD: apps/admin/src/lib/match-note.ts, on the
-- UNION of `matches.create.write`, `matches.void.write` and
-- `matches.convert.write` — the three capabilities that gate the three actions
-- that AUTHOR these notes. No single one of them covers all three write paths,
-- so any single choice would leave an exec who wrote a note unable to read it
-- back. `matches.page` was rejected as the alternative: it is the ledger READ,
-- held by anyone allowed merely to look at the club's results, which is a
-- strictly wider audience than the authors and is the audience this change
-- exists to exclude. No new capability is minted — a new string would need a
-- vocabulary migration, a place in EDITOR_OFFERABLE and a decision about the
-- baselines, all to re-answer a question three existing strings already answer.
--
-- ------------------------------------------------------------
-- `matches.admin_note` IS NOT DROPPED HERE
-- ------------------------------------------------------------
-- On purpose, and it is the single most important line in this file. The owner
-- applies migrations by hand and deploys code separately, so at any moment a
-- running build may still be selecting that column. Dropping it would turn
-- every such select into a 42703 — and per 00115 that surfaces as an EMPTY
-- screen rather than an error. The column keeps its data, stops being written,
-- and can be dropped by a later migration once no running build references it:
--
--     ALTER TABLE public.matches DROP COLUMN IF EXISTS admin_note;
--
-- Leaving it also gives the migration-first deploy order somewhere to land —
-- see below. Until that follow-up runs the note is readable in the old column
-- for matches that predate this file; the exposure is not CLOSED by this
-- migration, it is made closable. The values are copied, not moved, and that
-- is the honest description of what one hand-applied step can safely do.
--
-- ------------------------------------------------------------
-- DEPLOY ORDER IS FREE, IN BOTH DIRECTIONS
-- ------------------------------------------------------------
-- MIGRATION FIRST, CODE LATER. The old build keeps writing
-- `matches.admin_note`, which still exists, so nothing errors and nothing
-- changes; the new table simply stays empty for anything entered in the
-- meantime. The backfill below is written so it can be re-run after the code
-- lands to sweep up exactly those rows.
--
-- CODE FIRST, MIGRATION LATER. This is the direction that needs care, and it
-- differs from 00116's in kind: there the risk was an unknown COLUMN, here it
-- is an absent TABLE. The console's note write is therefore its own statement,
-- issued after the match write, and only the "no such table" family is
-- swallowed — PGRST205 (PostgREST's schema cache), PGRST202, and Postgres's own
-- 42P01. Everything else is rethrown, because swallowing everything would mean
-- that once this file is applied a genuine failure still ends in a green
-- success toast, which is how somebody comes to believe a note was recorded
-- that was not. Pre-migration, then: the match is created, voided or converted
-- exactly as before, the note is silently dropped, and nothing on screen lies
-- about it. That is the same shape as 00116's `require_scan_to_check_in`
-- write, and the reasoning is spelled out at the call site.
--
-- The console's READ is likewise its own query and treats an absent table as
-- "no notes", so /matches renders normally against a database without it.
--
-- ------------------------------------------------------------
-- CONSIDERED AND REJECTED
-- ------------------------------------------------------------
--   * A SEPARATE SCHEMA (`private.match_admin_notes`). Genuinely stronger —
--     PostgREST exposes only the schemas in its `db-schemas` setting, so a
--     table outside them is unreachable no matter what grants it accumulates.
--     Rejected because the console reads this table THROUGH PostgREST with the
--     service-role key, so the schema would have to be exposed to be usable,
--     at which point it buys nothing that the REVOKE does not; and this
--     database has no non-public schema today, so introducing one would change
--     how every future migration has to think about search_path. The stronger
--     version of this idea is a follow-up, not a rider.
--
--   * PUBLISHING IT TO REALTIME. Never. Nothing subscribes to it and nothing
--     should: a publication does not consult grants or RLS row filters the way
--     a query does, which is the whole hazard 00114 documents for `players`.
--     Both apps' realtime-publication guard tests assert by name that this
--     table is absent from every ALTER PUBLICATION in this directory.
--
--   * ENCRYPTING THE COLUMN IN PLACE. Solves the wrong problem — the note has
--     to be readable by the console, so the key would live beside it.
--
-- IDEMPOTENT throughout: IF NOT EXISTS on the table and the index, ENABLE ROW
-- LEVEL SECURITY (a no-op when already on), a backfill guarded on the source
-- column and ending in ON CONFLICT DO NOTHING, DROP TRIGGER IF EXISTS before
-- the trigger, and GRANT / REVOKE, which never error on a privilege already
-- held or already absent. Re-running the whole file changes nothing.

-- 1. THE TABLE -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.match_admin_notes (
  -- The primary key, not a surrogate id with a unique index on top: one match
  -- has at most one note, and saying that here is what makes the write an
  -- upsert instead of a read-then-branch. CASCADE because
  -- discardIncompleteMatch deletes matches — see the header.
  match_id   UUID PRIMARY KEY REFERENCES public.matches(id) ON DELETE CASCADE,
  -- NOT NULL: "no note" is the absence of a row. A nullable column here would
  -- give the console two ways to say the same thing and the renderer would
  -- have to handle both.
  note       TEXT NOT NULL,
  -- Nullable, and NULL is a real answer: rows copied from the old column below
  -- have no recoverable author. SET NULL so removing a player does not delete
  -- the record of why a match was voided.
  author_id  UUID REFERENCES public.players(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.match_admin_notes IS
  'Exec-written free text about one match — the create form''s Admin Note, and the reasons recorded by voidMatch and convertMatchToCasual. PRIVATE: no grant for anon/authenticated, RLS on with no policy, and deliberately NOT a member of supabase_realtime. Read only by the console through the service-role key, gated in the app on matches.create.write / matches.void.write / matches.convert.write. Superseded matches.admin_note, which is left in place until no deployed build selects it.';

COMMENT ON COLUMN public.match_admin_notes.author_id IS
  'The exec who wrote the note, or NULL for rows copied from matches.admin_note by 00117 — that column never recorded an author, and matches.submitted_by is the person who entered the score, which for a void reason is the wrong name.';

-- 2. THE LOCKS -------------------------------------------------------------
-- The REVOKE is the one that closes the table; the empty-policy RLS is the
-- belt to it. Both, for the reasons in the header.
ALTER TABLE public.match_admin_notes ENABLE ROW LEVEL SECURITY;

-- PUBLIC is named alongside the two roles because a privilege held by PUBLIC is
-- held by every role there is, including ones nobody has created yet. 00033 and
-- 00038 revoke cron_config the same way; 00037 named only anon and authenticated
-- and this file does not repeat that.
REVOKE ALL ON public.match_admin_notes FROM PUBLIC, anon, authenticated;

-- Restated rather than assumed. service_role holds this by default privilege
-- today; the cost of writing it down is nothing and the cost of assuming wrong
-- is a console that cannot record a void reason.
GRANT ALL ON public.match_admin_notes TO service_role;

-- 3. PRESERVE WHAT IS ALREADY WRITTEN --------------------------------------
-- Copied, never moved: the source column stays exactly as it is (see the
-- header). Blank-but-not-null notes are skipped — the old column has no NOT
-- NULL and no CHECK, so '' is reachable, and an empty note is not a note.
--
-- ON CONFLICT DO NOTHING rather than DO UPDATE, and the difference matters on
-- the SECOND run. Re-running this after the console has shipped must sweep up
-- matches the old build wrote in the interim; it must NOT overwrite a note an
-- exec has since edited through the new table with the stale value still
-- sitting in the old column. DO NOTHING gives both.
--
-- created_at is the match's own timestamp rather than NOW(), so a backfilled
-- note is not dated to the day the migration was run. author_id is left NULL
-- deliberately — see the column comment.
-- GUARDED ON THE SOURCE COLUMN STILL EXISTING, so this file survives the
-- follow-up that eventually drops it. Unguarded, a re-run after
-- `ALTER TABLE matches DROP COLUMN admin_note` would raise 42703 and the
-- migration would stop being re-runnable — which for a hand-applied set is the
-- same as stopping being trustworthy. The static SQL is inside EXECUTE for the
-- same reason: a plain statement referencing a dropped column fails to PARSE
-- even on a branch that never runs.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'matches'
       AND column_name = 'admin_note'
  ) THEN
    EXECUTE $sql$
      INSERT INTO public.match_admin_notes (match_id, note, author_id, created_at, updated_at)
      -- NULL::uuid, not a bare NULL: an untyped NULL in a SELECT list resolves
      -- to `unknown`, and leaning on the INSERT target to coerce it is exactly
      -- the sort of thing that works until it does not.
      SELECT m.id, m.admin_note, NULL::uuid, COALESCE(m.updated_at, m.created_at, NOW()), NOW()
        FROM public.matches m
       WHERE m.admin_note IS NOT NULL
         AND btrim(m.admin_note) <> ''
      ON CONFLICT (match_id) DO NOTHING
    $sql$;
  END IF;
END;
$$;

-- 4. THE ONE INDEX THAT IS NOT FREE ----------------------------------------
-- The primary key already serves the console's only read shape — `in('match_id',
-- <the fifty ids on screen>)` — so no index is added for that. This one is for
-- the foreign key: an unindexed FK makes every player deletion scan this table,
-- and removePlayer is a real console action.
CREATE INDEX IF NOT EXISTS match_admin_notes_author_id_idx
  ON public.match_admin_notes (author_id)
  WHERE author_id IS NOT NULL;

-- 5. KEEP updated_at HONEST -------------------------------------------------
-- The upsert sets it explicitly, so this is a backstop for anything written by
-- hand at a psql prompt. trigger_set_updated_at() is 00004's own function,
-- already attached to eleven tables by the loop at 00004:15 — this table is
-- named here rather than added to that array because 00004 is recorded as
-- applied on both databases and editing it would never re-run.
--
-- DROP-then-CREATE rather than CREATE IF NOT EXISTS, which Postgres does not
-- offer for triggers before 14 and which this file does not depend on: DROP
-- IF EXISTS is the portable idempotent form and is what makes a re-run a
-- no-op.
DROP TRIGGER IF EXISTS set_updated_at ON public.match_admin_notes;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.match_admin_notes
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
