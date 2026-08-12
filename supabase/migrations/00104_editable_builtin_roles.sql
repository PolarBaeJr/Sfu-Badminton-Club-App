-- ============================================================
-- 00104 — the four VP jobs become editable rows
--
-- *** APPLY THIS BEFORE DEPLOYING THE CODE THAT GOES WITH IT. *** The console
-- selects permission_baselines.builtin_role in the same statement it selects
-- the rest of the row. PostgREST answers an unknown column with an error and no
-- rows, so on a database without this migration the Baselines list on
-- /permissions renders EMPTY — not a missing feature, the whole list gone.
--
-- ------------------------------------------------------------------
-- WHAT THE OWNER ASKED FOR
-- ------------------------------------------------------------------
-- "Allow me to edit the permissions of each preassigned role beforehand."
--
-- The immediate case: Finance should see money IN as well as out. Today it
-- stops at the expense ledger, because ROLE_DEFAULTS.finance is a hard-coded
-- constant in packages/shared/src/utils/access-level.ts and changing it takes a
-- developer, a deploy, and the unpicking of two structural test invariants.
--
-- ------------------------------------------------------------------
-- THE ONE DESIGN DECISION — 00093'S, APPLIED A SECOND TIME
-- ------------------------------------------------------------------
-- resolvePermissions() is PURE and SYNCHRONOUS and is reached from 22 places:
-- middleware, the sidebar, twelve page shells, the field guard, the batch
-- editor and setPlayerPermissions itself. A role whose contents live in this
-- table cannot be looked up from inside it, and passing them in as a fourth
-- argument means 22 call sites where forgetting resolves somebody's ENTIRE BASE
-- to nothing — fail-closed, but silently, in twenty-two places, one of them the
-- edge middleware where the lookup is also a per-request round trip.
--
-- SO THE ROW CARRIES THE ANSWER, NOT A POINTER TO IT — the same trade 00093
-- made. A built-in role is now a SEEDED ROW in permission_baselines, and
-- assigning it writes permission_role = 'custom' (the empty base, 00091) with
-- the capabilities copied into permission_grants. THE RESOLVER IS NOT TOUCHED
-- BY THIS MIGRATION OR THE CODE THAT GOES WITH IT — not one line.
--
-- ROLE_DEFAULTS SURVIVES AS THE SEED, NOT AS THE RUNTIME ANSWER. It is what
-- part 3 below inserts, what "reset to shipped default" restores, and nothing
-- else. Because it stops being edited, its two structural invariants survive
-- LITERALLY: every role is still inside EXEC_BASELINE, and the four still
-- partition it exactly. The security property those tests carried moves to
-- write time, where it now has to be — every edit to one of these rows is
-- closure-checked against the editor's own set and capped at EDITOR_OFFERABLE
-- by baselineCapabilityRefusal(), on every path that writes this table.
--
-- ------------------------------------------------------------------
-- WHAT CHANGES FOR PEOPLE WHEN THIS IS APPLIED: NOTHING. Part 4 is a
-- PROVABLY EQUIVALENT rewrite, and the proof is one line:
--
--     resolvePermissions('custom', ROLE_DEFAULTS[r] ∪ grants, revokes)
--   ≡ resolvePermissions(r,        grants,                    revokes)
--
-- because 'custom' has an EMPTY base, so the union it is handed is exactly the
-- union the role would have formed from its own defaults. Same set before
-- subtraction, same revokes, same page-prune afterwards, same answer. Nobody
-- gains or loses one capability at the moment this runs.
--
-- ------------------------------------------------------------------
-- SIX PARTS
--   1. A pre-flight refusal, so a name clash fails in words.
--   2. permission_baselines.builtin_role — which VP job a row shipped as.
--   3. The seed: four rows, byte-identical to ROLE_DEFAULTS.
--   4. Converting today's role holders, equivalently.
--   5. Grants (none needed) and the comments.
--   6. NOTIFY.
-- ============================================================

-- 1. PRE-FLIGHT ------------------------------------------------------------
--
-- permission_baselines_name_key is UNIQUE on lower(btrim(name)), so if the club
-- has already written a baseline of its own called 'Finance' the seed below
-- fails on a constraint name that explains nothing. Refuse first, in words,
-- naming the row to rename. ON CONFLICT (id) cannot catch this: the collision is
-- on the NAME, and the ids are new.
DO $$
DECLARE
  clashing TEXT;
BEGIN
  SELECT string_agg(name, ', ' ORDER BY name) INTO clashing
  FROM public.permission_baselines
  WHERE lower(btrim(name)) IN ('finance', 'tournaments', 'internal', 'external')
    AND id NOT IN (
      '5eed0060-0000-4000-8000-000000000101',
      '5eed0060-0000-4000-8000-000000000102',
      '5eed0060-0000-4000-8000-000000000103',
      '5eed0060-0000-4000-8000-000000000104'
    );
  IF clashing IS NOT NULL THEN
    RAISE EXCEPTION
      'Rename the existing baseline(s) % first — 00104 seeds the four VP jobs under those names.',
      clashing;
  END IF;
END $$;

-- 2. WHICH VP JOB A ROW SHIPPED AS ----------------------------------------
--
-- NULL for a baseline the club wrote itself, which is every row that exists
-- today. The four seeded below carry the role they replace.
--
-- IT IS NOT A FOREIGN KEY AND NOT AN ENUM — the four values are pinned by a
-- CHECK naming them, the same way players_permission_role_check (00091) pins
-- the identical vocabulary two tables away. A fifth VP job is not a thing that
-- can happen: the club writes an ordinary baseline for that, which is the whole
-- point of 00093.
ALTER TABLE public.permission_baselines
  ADD COLUMN IF NOT EXISTS builtin_role TEXT;

ALTER TABLE public.permission_baselines
  DROP CONSTRAINT IF EXISTS permission_baselines_builtin_role_check;
ALTER TABLE public.permission_baselines
  ADD CONSTRAINT permission_baselines_builtin_role_check
  CHECK (builtin_role IS NULL
         OR builtin_role IN ('finance', 'tournaments', 'internal', 'external'));

-- ONE ROW PER JOB. Two rows both claiming to be Finance is two things with one
-- meaning, and "reset Finance to its shipped default" would not know which. A
-- partial index rather than a plain UNIQUE, because NULL is the overwhelming
-- majority and means "not a built-in" rather than "an unknown built-in".
CREATE UNIQUE INDEX IF NOT EXISTS permission_baselines_builtin_role_key
  ON public.permission_baselines (builtin_role)
  WHERE builtin_role IS NOT NULL;

COMMENT ON COLUMN public.permission_baselines.builtin_role IS
  'Which of the four VP jobs this row SHIPPED as (finance/tournaments/internal/external), or NULL for a baseline the club wrote itself. Three things depend on it: the row is seeded from ROLE_DEFAULTS in code, it can be RESET to that shipped default, and it can never be DELETED — a built-in with no holders would otherwise delete cleanly and take the seed with it. Renaming and editing are allowed; that is the feature.';

-- 3. THE SEED -------------------------------------------------------------
--
-- FIXED UUIDS, NOT LOOKUP BY NAME, because these rows are RENAMEABLE — 'Finance'
-- may become 'Treasurer' — so a name is not an identity. The same four
-- constants appear in BUILTIN_BASELINE_IDS in access-level.ts and the contents
-- are ROLE_DEFAULTS sorted; editable-roles.test.ts reads THIS FILE as text and
-- asserts both against the constants, so the seed and the code cannot drift and
-- "reset to shipped default" cannot restore something that was never shipped.
--
-- ON CONFLICT (id) DO NOTHING so re-running is safe and, more importantly, so
-- re-running NEVER OVERWRITES AN EDIT. Once the owner has taught Finance to see
-- the club's books, a second application of this migration must not quietly put
-- it back.

INSERT INTO public.permission_baselines (id, name, capabilities, builtin_role)
VALUES (
  '5eed0060-0000-4000-8000-000000000101',
  'Finance',
  ARRAY[
    'fees.expenses.add.write', 'fees.expenses.read', 'fees.page'
  ]::TEXT[],
  'finance'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.permission_baselines (id, name, capabilities, builtin_role)
VALUES (
  '5eed0060-0000-4000-8000-000000000102',
  'Tournaments',
  ARRAY[
    'matches.convert.write', 'matches.create.write', 'matches.page',
    'matches.void.write', 'sessions.archive.write', 'sessions.attendance.write',
    'sessions.checkin.token.write', 'sessions.create.write', 'sessions.delete.write',
    'sessions.page', 'sessions.reminders.write', 'sessions.update.write',
    'tournaments.draw.checkin.mark.write', 'tournaments.draw.checkin.token.write', 'tournaments.draw.entrycounts.read',
    'tournaments.draw.exit.write', 'tournaments.draw.generate.write', 'tournaments.draw.lock.write',
    'tournaments.draw.noshow.write', 'tournaments.draw.pairs.add.write', 'tournaments.draw.pairs.remove.write',
    'tournaments.draw.participants.add.write', 'tournaments.draw.participants.remove.write', 'tournaments.draw.seed.auto.write',
    'tournaments.draw.seed.clear.write', 'tournaments.draw.seed.set.write', 'tournaments.draw.unlock.write',
    'tournaments.draw.waivers.read', 'tournaments.manage.archive.write', 'tournaments.manage.create.write',
    'tournaments.manage.delete.write', 'tournaments.manage.event.create.write', 'tournaments.manage.event.delete.write',
    'tournaments.manage.event.status.write', 'tournaments.manage.event.update.write', 'tournaments.manage.resume.write',
    'tournaments.manage.status.write', 'tournaments.manage.suspend.write', 'tournaments.manage.update.write',
    'tournaments.page', 'tournaments.results.bonuses.write', 'tournaments.results.doublenoshow.write',
    'tournaments.results.edit.write', 'tournaments.results.enter.write', 'tournaments.results.entry.write',
    'tournaments.results.finalize.write', 'tournaments.results.standings.write', 'tournaments.results.undo.write',
    'tournaments.results.unvoid.write', 'tournaments.results.void.write', 'tournaments.results.walkover.write'
  ]::TEXT[],
  'tournaments'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.permission_baselines (id, name, capabilities, builtin_role)
VALUES (
  '5eed0060-0000-4000-8000-000000000103',
  'Internal',
  ARRAY[
    'players.approve.write', 'players.ban.write', 'players.create.write',
    'players.editor.varsitynotes.write', 'players.page', 'players.read',
    'players.reinstate.write', 'players.update.write', 'players.waiver.resign.write',
    'seasons.activate.write', 'seasons.create.write', 'seasons.end.write',
    'seasons.page'
  ]::TEXT[],
  'internal'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.permission_baselines (id, name, capabilities, builtin_role)
VALUES (
  '5eed0060-0000-4000-8000-000000000104',
  'External',
  ARRAY[
    'announcements.create.write', 'announcements.delete.write', 'announcements.page',
    'announcements.update.write', 'legal.page', 'legal.reacceptance.write'
  ]::TEXT[],
  'external'
)
ON CONFLICT (id) DO NOTHING;

-- 4. TODAY'S ROLE HOLDERS -------------------------------------------------
--
-- Rows still storing permission_role = 'finance' resolve through the hard-coded
-- ROLE_DEFAULTS, which is now the SEED and not the answer. Left alone they are
-- a second Finance with a different value — the same word meaning two things,
-- which is the one outcome this feature must not produce. So they are rewritten
-- to the copy-on-assign shape every new assignment uses.
--
-- EQUIVALENT, NOT MERELY SIMILAR. See the header: 'custom' has an empty base, so
-- unioning the role's defaults into the grants reproduces exactly the set the
-- role would have formed. Nobody's access moves.
--
-- TWO CASES, AND THE SPLIT IS THE CAREFUL PART:
--
--   4a. UNADJUSTED HOLDERS (no grants, no revokes) become the baseline
--       verbatim, and get its LABEL. They are exactly what the row says, so a
--       future edit to Finance should reach them — which is what the label is
--       for.
--
--   4b. ADJUSTED HOLDERS ('Finance with 3 granted and 1 revoked') become a
--       HAND-PICKED set with NO label. They resolve identically, and they must
--       not be labelled: permission_baseline_id means "this row IS the
--       baseline", and propagation writes the baseline verbatim over every
--       holder. Labelling an adjusted row would mean the next edit to Finance
--       silently discarded the adjustments somebody made deliberately — a
--       narrowing produced by somebody else's edit to something else, which is
--       the failure 00093 already refuses to build.
--
--       The cost, stated plainly: an adjusted holder stops tracking Finance.
--       That is a change in nothing, because before this migration there was no
--       way to edit Finance at all.
--
-- BOTH COLUMNS IN ONE UPDATE. players_permission_baseline_needs_custom_check
-- (00093) refuses permission_baseline_id unless permission_role = 'custom', so
-- setting the label in a separate statement would fail on the constraint.

-- 4a. Unadjusted — the baseline verbatim, labelled.
UPDATE public.players p
SET permission_role = 'custom',
    permission_grants = b.capabilities,
    permission_baseline_id = b.id
FROM public.permission_baselines b
WHERE b.builtin_role = p.permission_role
  AND cardinality(p.permission_grants) = 0
  AND cardinality(p.permission_revokes) = 0;

-- 4b. Adjusted — the same resolved set, hand-picked, unlabelled.
--
-- The union is written with a scalar subquery rather than a join so the
-- de-duplication is visible: a grant that duplicated one of the role's defaults
-- was normalised away on save, but a row written before that rule existed could
-- still carry one, and ARRAY(SELECT DISTINCT ...) makes the result the same set
-- either way. Sorted, so the stored array reads the way every other stored
-- capability array in this schema does.
UPDATE public.players p
SET permission_role = 'custom',
    permission_grants = ARRAY(
      SELECT DISTINCT capability
      FROM (
        SELECT unnest(b.capabilities) AS capability
        UNION
        SELECT unnest(p.permission_grants) AS capability
      ) merged
      ORDER BY capability
    )
FROM public.permission_baselines b
WHERE b.builtin_role = p.permission_role
  AND (cardinality(p.permission_grants) > 0 OR cardinality(p.permission_revokes) > 0);

-- 5. NOTHING TO GRANT -----------------------------------------------------
--
-- No new table and no new player column: RLS and the REVOKE from anon and
-- authenticated set up by 00093 already cover permission_baselines, and a new
-- column on it inherits both. guard_player_privileged_columns() is likewise
-- untouched — this migration adds no privileged player column, and the four it
-- already names (role, grants, revokes, baseline_id) are the four part 4 writes,
-- through the service-role console which the guard's first branch lets past.

COMMENT ON TABLE public.permission_baselines IS
  'Named capability sets the club runs on. Two kinds: the four VP jobs seeded by 00104 (builtin_role IS NOT NULL — editable and renameable, resettable to their shipped default, never deletable) and the ones the club writes for itself (00093). NOT consulted by the resolver: assigning one COPIES its capabilities into players.permission_grants with permission_role = ''custom'', so the person''s row says what they hold and resolvePermissions stays pure and synchronous. Editing one re-copies to every holder in one audited act. Written only by the admin console, which enforces grant closure against the author''s own set and caps contents at EDITOR_OFFERABLE.';

-- 6. SCHEMA RELOAD --------------------------------------------------------
--
-- A new column reached through PostgREST by the console's service-role client.
-- Without this it exists in Postgres while every request gets PGRST204 and the
-- Baselines list renders empty. Cheap and idempotent.
NOTIFY pgrst, 'reload schema';
