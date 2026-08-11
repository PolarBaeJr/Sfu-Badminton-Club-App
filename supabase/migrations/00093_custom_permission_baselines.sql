-- ============================================================
-- 00093 — the club writes its own baselines
--
-- *** APPLY THIS BEFORE DEPLOYING THE CODE THAT GOES WITH IT, AND THIS ONE
-- MATTERS. *** /permissions selects players.permission_baseline_id in the same
-- statement it selects everything else. PostgREST answers an unknown column
-- with an error and no rows, so on a database without this migration the page
-- renders with NOBODY in the rail — not a missing feature, the whole screen
-- empty. (The baselines table itself fails softly, to an empty list; the column
-- is the one that bites.)
--
-- NOTHING CHANGES FOR ANYONE WHEN IT IS APPLIED. The new column is NULL on
-- every row, the new table is empty, and the resolver does not read either of
-- them — no capability anybody holds moves by one entry. Safe to apply well
-- ahead of the code, and it has to be.
--
-- WHAT THE OWNER ASKED FOR: "I should be able to create new baselines, since we
-- will have others." Today the only named starting points are the four VP jobs
-- in ROLE_DEFAULTS, which live in code — so adding a fifth is a deploy, and the
-- club's officer list changes faster than that.
--
-- ------------------------------------------------------------------
-- THE ONE DESIGN DECISION, AND IT IS THE WHOLE FILE
-- ------------------------------------------------------------------
-- resolvePermissions() is PURE and SYNCHRONOUS. It takes (role, grants,
-- revokes) and nothing else, and it is called from 22 places in the app —
-- middleware, the sidebar, twelve page shells, the field guard, the batch
-- editor, and setPlayerPermissions itself. A baseline stored in this table
-- cannot be looked up from inside it.
--
-- The obvious fix is to pass the baseline's capabilities in as a fourth
-- argument. It was rejected: every one of those 22 call sites would have to
-- find and forward it, and the failure mode of a call site that forgets is a
-- person whose whole base silently resolves to nothing. Fail-closed, but
-- fail-closed in twenty-two places is still a live hazard, and the one place it
-- would bite hardest is the middleware, where the lookup would become a second
-- round trip on every request.
--
-- SO THE ROW CARRIES THE ANSWER, NOT A POINTER TO IT. Assigning a baseline
-- writes permission_role = 'custom' (the empty base, 00091) and copies the
-- baseline's capabilities into permission_grants. The resolver is untouched —
-- not one line — and "no existing role's answer moves" is true by construction
-- rather than by test.
--
-- permission_baseline_id, added below, is therefore PROVENANCE AND NOTHING
-- ELSE. Nothing resolves through it. It records which baseline a row's grants
-- were copied from, which is what makes three things possible: showing the
-- name on the row, RE-COPYING to every holder when the baseline is edited, and
-- refusing to delete a baseline somebody still holds.
--
-- WHAT THAT COSTS, stated plainly: a baseline is a TEMPLATE PLUS EXPLICIT
-- PROPAGATION, not a live reference. Editing 'Socials VP' does not change what
-- its holders can do until the propagation writes land — and they land inside
-- the same action, each one closure-checked and each one leaving its own audit
-- row. That is strictly more auditable than ROLE_DEFAULTS, where changing what
-- 'finance' means is a code deploy that leaves no trace in this database at
-- all. It is the same trade 00091 made when it chose an empty base over a
-- borrowed name: the row says what the person holds.
--
-- ------------------------------------------------------------------
-- FIVE PARTS
--   1. permission_baselines, with the CHECKs that keep its contents honest.
--   2. players.permission_baseline_id — the provenance column.
--   3. guard_player_privileged_columns() replaced, the new column added to
--      both branches.
--   4. Grants and row security on the new table.
--   5. NOTIFY.
-- ============================================================

-- 1. THE TABLE ------------------------------------------------------------
--
-- A TABLE, NOT ROWS IN platform_settings. platform_settings is key/value TEXT
-- with a single writer and no shape: a baseline needs a name that is unique
-- case-insensitively, a capability array the database can constrain element by
-- element, an author, and two timestamps. Packing that into a JSON blob under
-- one key would put the vocabulary check, the page invariant and the uniqueness
-- rule entirely in application code, where a bad write has no second reader —
-- and it would make "which baselines exist" a parse rather than a query. It
-- would also give up the one guarantee that answers "what happens when somebody
-- deletes a baseline members still hold": a foreign key.
CREATE TABLE IF NOT EXISTS public.permission_baselines (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Shown wherever a role is shown, beside 'Finance' and 'Hand-picked'. Bounded
  -- because it is rendered in a select, a badge and an audit row, and a name
  -- long enough to break all three is not a name.
  name         TEXT NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 40),

  -- The capabilities this baseline hands out. Same element type as
  -- players.permission_grants, because that is literally where they are copied
  -- to: one vocabulary, one spelling, and no translation step between the two
  -- tables that could ever disagree.
  --
  -- NON-EMPTY. A baseline of nothing is already expressible — 'custom' with two
  -- empty arrays is a person with console access and no capabilities — and
  -- giving that state a NAME would be a named thing that does nothing, offered
  -- in a picker beside four that do.
  capabilities TEXT[] NOT NULL CHECK (cardinality(capabilities) > 0),

  -- SET NULL rather than CASCADE: a departed officer's account being cleaned up
  -- must not delete the baseline the club is still running on. The author is a
  -- fact about the baseline, not a dependency of it.
  created_by   UUID REFERENCES public.players(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   UUID REFERENCES public.players(id) ON DELETE SET NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- CASE-INSENSITIVE UNIQUE. 'Socials VP' and 'socials vp' in the same picker is
-- two rows an admin has to tell apart by capitalisation, and the one they pick
-- decides what a person can do. btrim as well, so trailing space is not a
-- second name either.
CREATE UNIQUE INDEX IF NOT EXISTS permission_baselines_name_key
  ON public.permission_baselines (lower(btrim(name)));

-- NULL ELEMENTS, refused for the same reason 00087 refuses them in the delta
-- columns: array_position compares with IS NOT DISTINCT FROM and is the one
-- cheap way to ask whether an array contains a NULL, and a NULL that reached
-- the app would be dropped silently by isCapability().
ALTER TABLE public.permission_baselines
  DROP CONSTRAINT IF EXISTS permission_baselines_capabilities_not_null_check;
ALTER TABLE public.permission_baselines
  ADD CONSTRAINT permission_baselines_capabilities_not_null_check
  CHECK (array_position(capabilities, NULL::TEXT) IS NULL);

-- THE VOCABULARY, PINNED IN SQL — the same 116 strings 00089 pins on
-- players.permission_grants, and pinned here for a sharper reason than there.
--
-- On players the constraint is mostly about REVOKES, where an unknown string is
-- a revoke that silently stops biting. This table stores no revokes, so the
-- hazard is the other one: a baseline holding a string the code does not know
-- is a baseline that hands out nothing, discovered by an officer who cannot do
-- the job they were just given.
--
-- A THIRD COPY OF THE VOCABULARY, and that is a cost paid deliberately. It is
-- kept honest the same way the second copy is: capability-storage.test.ts reads
-- BOTH constraints as text and asserts each against CAPABILITIES, so the two
-- lists cannot drift apart without the suite failing. Adding a capability now
-- edits two constraints in one migration instead of one.
ALTER TABLE public.permission_baselines
  DROP CONSTRAINT IF EXISTS permission_baselines_vocabulary_check;
ALTER TABLE public.permission_baselines
  ADD CONSTRAINT permission_baselines_vocabulary_check
  CHECK (
    capabilities <@ ARRAY[
    'players.page', 'players.read', 'players.approve.write',
    'players.create.write', 'players.update.write', 'players.waiver.resign.write',
    'players.ban.write', 'players.reinstate.write', 'players.editor.varsitynotes.write',
    'players.deletion.cancel.write', 'players.remove.write', 'players.merge.write',
    'players.reliability.write', 'players.privilegedfields.write', 'seasons.page',
    'seasons.create.write', 'seasons.activate.write', 'seasons.end.write',
    'seasons.fees.write', 'sessions.page', 'sessions.reminders.write',
    'sessions.create.write', 'sessions.update.write', 'sessions.archive.write',
    'sessions.checkin.token.write', 'sessions.attendance.write', 'sessions.delete.write',
    'matches.page', 'matches.void.write', 'matches.convert.write',
    'matches.create.write', 'challenges.page', 'challenges.create.write',
    'challenges.expire.write', 'announcements.page', 'announcements.create.write',
    'announcements.update.write', 'announcements.delete.write', 'tournaments.page',
    'tournaments.manage.create.write', 'tournaments.manage.update.write', 'tournaments.manage.status.write',
    'tournaments.manage.suspend.write', 'tournaments.manage.resume.write', 'tournaments.manage.archive.write',
    'tournaments.manage.delete.write', 'tournaments.manage.event.create.write', 'tournaments.manage.event.update.write',
    'tournaments.manage.event.delete.write', 'tournaments.manage.event.status.write', 'tournaments.draw.participants.add.write',
    'tournaments.draw.participants.remove.write', 'tournaments.draw.checkin.token.write', 'tournaments.draw.checkin.mark.write',
    'tournaments.draw.noshow.write', 'tournaments.draw.exit.write', 'tournaments.draw.pairs.add.write',
    'tournaments.draw.pairs.remove.write', 'tournaments.draw.seed.set.write', 'tournaments.draw.seed.auto.write',
    'tournaments.draw.seed.clear.write', 'tournaments.draw.generate.write', 'tournaments.draw.lock.write',
    'tournaments.draw.unlock.write', 'tournaments.results.enter.write', 'tournaments.results.walkover.write',
    'tournaments.results.void.write', 'tournaments.results.unvoid.write', 'tournaments.results.undo.write',
    'tournaments.results.edit.write', 'tournaments.results.entry.write', 'tournaments.results.doublenoshow.write',
    'tournaments.results.bonuses.write', 'tournaments.results.standings.write', 'tournaments.results.finalize.write',
    'tournaments.fees.read', 'tournaments.fees.tier.create.write', 'tournaments.fees.tier.update.write',
    'tournaments.fees.tier.delete.write', 'tournaments.fees.markpaid.write', 'tournaments.fees.markunpaid.write',
    'fees.page', 'fees.expenses.read', 'fees.expenses.add.write',
    'fees.expenses.update.write', 'fees.expenses.reimburse.write', 'fees.expenses.remove.write',
    'fees.otherincome.read', 'fees.otherincome.add.write', 'fees.otherincome.remove.write',
    'fees.clubfees.read', 'fees.clubfees.markpaid.write', 'fees.clubfees.markunpaid.write',
    'fees.clubfees.waive.write', 'fees.clubfees.addmanual.write', 'fees.clubfees.removemanual.write',
    'fees.reinstatements.read', 'fees.reinstatements.write', 'fees.netposition.read',
    'fees.playerflags.write', 'legal.page', 'legal.reacceptance.write',
    'legal.documents.write', 'legal.waivertemplate.write', 'walkovers.page',
    'walkovers.confirm.write', 'walkovers.reject.write', 'disputes.page',
    'disputes.resolve.write', 'permissions.page', 'permissions.write',
    'audit.page', 'ratings.page', 'accounts.page',
    'platform.page', 'platform.settings.write'
    ]::TEXT[]
  );

-- EVERY AREA THE BASELINE REACHES MUST CARRY THAT AREA'S PAGE — AND THAT RULE
-- IS DELIBERATELY NOT A CHECK HERE.
--
-- The rule itself is real and load-bearing: a baseline of
-- ['fees.expenses.add.write'] with no fees.page resolves to the EMPTY SET,
-- because the resolver prunes every capability whose area page is absent. It
-- would save, assign and audit, and hand out nothing, and the only symptom
-- would be an officer who cannot do the job they were just given. It is
-- enforced, in baselineCapabilityRefusal(), on every path that writes this
-- table — create and edit — and pinned three ways in
-- custom-baselines.test.ts, including by resolving everything the check accepts
-- and asserting the resolved set equals the array.
--
-- IT IS EXPRESSIBLE IN SQL, unlike the same rule on players (there it is a
-- property of the RESOLVED set, after subtraction, which no CHECK can see). But
-- expressing it needs an IMMUTABLE helper function, because a CHECK cannot
-- contain a subquery — and a CHECK constraint that depends on a user-defined
-- function is a pattern none of the other ninety-two migrations use, has known
-- ordering hazards in dump/restore, and cannot be verified from here against
-- the club's nightly pg_dump. This migration is run by hand against a live
-- database; a novelty in it that nobody has restored from is not worth a second
-- copy of a rule the only writer already enforces.
--
-- WHAT MAKES THAT SAFE, stated so the trade is visible: RLS is on with no
-- policies and every grant is revoked below, so the ONLY writer is the admin
-- console's service-role client, and it goes through baselineCapabilityRefusal.
-- The same reasoning 00087 gives for leaving its resolved-set rule to the
-- resolver.

COMMENT ON TABLE public.permission_baselines IS
  'Named capability sets the club writes for itself — the answer to "we will have others" beyond the four VP jobs hard-coded in ROLE_DEFAULTS. NOT consulted by the resolver: assigning one COPIES its capabilities into players.permission_grants with permission_role = ''custom'', so the person''s row says what they hold and resolvePermissions stays pure and synchronous. Editing a baseline re-copies to every holder in one audited act; deleting one is refused while anybody holds it (players.permission_baseline_id ON DELETE RESTRICT). Written only by the admin console, which enforces grant closure against the author''s own set and caps contents at EDITOR_OFFERABLE.';

COMMENT ON COLUMN public.permission_baselines.capabilities IS
  'The capabilities this baseline hands out, from the same vocabulary as players.permission_grants. Constrained to that vocabulary, to carrying every area page it touches, and to being non-empty. Bounded further in the app by EDITOR_OFFERABLE — the exec baseline — so no baseline can hand out admin-only work.';

-- 2. THE PROVENANCE COLUMN ------------------------------------------------
--
-- WHICH BASELINE THIS ROW'S GRANTS WERE COPIED FROM. NULL means the grants were
-- hand-picked, which is every composed row that exists today.
--
-- ON DELETE RESTRICT is the answer to "what happens to members holding a
-- baseline that is deleted". CASCADE is unavailable in any useful sense (it
-- would delete the PLAYER), SET NULL would silently orphan the label and leave
-- an admin looking at a hand-picked set nobody hand-picked, and RESTRICT
-- refuses — which is the behaviour the console then explains in words, naming
-- the holders.
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS permission_baseline_id UUID
  REFERENCES public.permission_baselines(id) ON DELETE RESTRICT;

-- A BASELINE LABEL ONLY EXISTS ON A HAND-PICKED ROW. 'custom' is the empty
-- base, so a copied baseline resolves to exactly its own capabilities; any
-- other role has defaults underneath, and a label claiming the grants came from
-- a baseline would be describing only part of the set.
ALTER TABLE public.players
  DROP CONSTRAINT IF EXISTS players_permission_baseline_needs_custom_check;
ALTER TABLE public.players
  ADD CONSTRAINT players_permission_baseline_needs_custom_check
  CHECK (permission_baseline_id IS NULL OR permission_role = 'custom');

-- Every holder of a baseline, for propagation on edit and for the refusal on
-- delete. Partial, because the overwhelming majority of rows are NULL here.
CREATE INDEX IF NOT EXISTS players_permission_baseline_id_idx
  ON public.players (permission_baseline_id)
  WHERE permission_baseline_id IS NOT NULL;

COMMENT ON COLUMN public.players.permission_baseline_id IS
  'Which custom baseline this row''s permission_grants were COPIED from, or NULL for a hand-picked set. PROVENANCE ONLY — the resolver never reads it, and clearing it takes nothing away from anybody. It exists so the console can name the baseline on the row, re-copy to every holder when the baseline is edited, and refuse to delete a baseline somebody still holds. Cleared whenever the grants are edited by hand, so the label can never claim a set the baseline does not actually say. Privileged: guarded by guard_player_privileged_columns, because a member who could point their own row at a baseline would be handed its capabilities by the next propagation.';

-- 3. THE GUARD ------------------------------------------------------------
--
-- THE FUNCTION BODY BELOW IS 00087'S, COPIED VERBATIM, WITH ONE LINE ADDED TO
-- EACH BRANCH FOR permission_baseline_id AND NOTHING ELSE CHANGED. CREATE OR
-- REPLACE takes the whole body, so a line dropped from memory is a guard
-- silently removed — see the header of 00072. **Before applying this, dump the
-- live definition and diff it against 00087's**: if anything has been changed
-- in the database since, that change is not in this file and this statement
-- will delete it.
--
-- WHY THE NEW COLUMN NEEDS GUARDING even though the resolver ignores it.
-- players_update_own (00005) lets a member PATCH their own row through
-- PostgREST. Setting permission_baseline_id there grants nothing on its own —
-- but the next time an admin edits that baseline, propagation walks every row
-- carrying its id and copies the capabilities in. A member who could write this
-- column would be queueing themselves an officer's access, to be delivered by
-- somebody else's ordinary edit.
CREATE OR REPLACE FUNCTION public.guard_player_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- auth.uid() IS NULL covers the service-role console, which has already
  -- checked the caller's level in a server action.
  IF auth.uid() IS NULL OR is_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A self-created row may only ever be an ordinary, unapproved member.
    IF COALESCE(NEW.is_exec, FALSE)
       OR COALESCE(NEW.is_trainer, FALSE)
       OR COALESCE(NEW.fee_exempt, FALSE)
       OR COALESCE(NEW.is_banned, FALSE)
       OR NEW.role IS DISTINCT FROM 'player'
       OR NEW.status IS DISTINCT FROM 'pending_approval'
       -- Added: a self-created row claiming an office is the same escalation as
       -- editing one in, and get_executives() would publish it.
       OR NEW.exec_title IS NOT NULL
       -- REPLACES 00086's portfolio line, for the same reason it existed: a
       -- self-created row cannot be an exec at all (is_exec is refused above),
       -- so permissions on one are meaningless — but they must not be a way to
       -- pre-stage values that come into force the moment an admin grants
       -- is_exec. cardinality(), not IS NOT NULL: see the note above.
       OR NEW.permission_role IS NOT NULL
       OR cardinality(COALESCE(NEW.permission_grants, '{}')) > 0
       OR cardinality(COALESCE(NEW.permission_revokes, '{}')) > 0
       -- 00093. Pre-staging in its purest form: a label that grants nothing
       -- today and is filled in by the next edit to that baseline.
       OR NEW.permission_baseline_id IS NOT NULL THEN
      RAISE EXCEPTION 'Not authorized to create a privileged player row';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.role            IS DISTINCT FROM OLD.role
     OR NEW.status       IS DISTINCT FROM OLD.status
     OR NEW.is_banned    IS DISTINCT FROM OLD.is_banned
     OR NEW.is_exec      IS DISTINCT FROM OLD.is_exec
     OR NEW.eligibility_flag IS DISTINCT FROM OLD.eligibility_flag
     OR NEW.fee_exempt   IS DISTINCT FROM OLD.fee_exempt
     OR NEW.active_flag  IS DISTINCT FROM OLD.active_flag
     OR NEW.waiver_reset_at IS DISTINCT FROM OLD.waiver_reset_at
     OR NEW.deletion_requested_at IS DISTINCT FROM OLD.deletion_requested_at
     OR NEW.membership_type IS DISTINCT FROM OLD.membership_type
     OR NEW.exec_photo_url IS DISTINCT FROM OLD.exec_photo_url
     -- Published to anonymous visitors by get_executives(), so an unguarded
     -- write is a public claim to an office the member does not hold, not a
     -- cosmetic field on their own profile.
     OR NEW.exec_title   IS DISTINCT FROM OLD.exec_title
     -- THE 00087 REPLACEMENT for 00086's portfolio line. All three, because
     -- omitting any one of them leaves a complete escalation path: the role
     -- alone chooses the base, a grant alone adds to it, and clearing a revoke
     -- alone hands back whatever the club took away.
     OR NEW.permission_role IS DISTINCT FROM OLD.permission_role
     OR NEW.permission_grants IS DISTINCT FROM OLD.permission_grants
     OR NEW.permission_revokes IS DISTINCT FROM OLD.permission_revokes
     -- 00093's fourth. See the column comment: this one is a promise of access
     -- rather than access, and the promise is kept by the next propagation.
     OR NEW.permission_baseline_id IS DISTINCT FROM OLD.permission_baseline_id
     OR NEW.is_trainer   IS DISTINCT FROM OLD.is_trainer THEN
    RAISE EXCEPTION 'Not authorized to modify privileged player fields';
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.guard_player_privileged_columns() IS
  'Blocks a member from granting themselves privilege via a direct PostgREST write to their own players row. Replaced wholesale on every change: CREATE OR REPLACE takes the whole body, so a column omitted here loses its protection silently. Dump the live definition before editing.';

-- 4. ROW SECURITY AND GRANTS ----------------------------------------------
--
-- RLS ON WITH NO POLICIES: no member-facing role reads or writes this table.
-- Everything that touches it goes through the admin console's service-role
-- client, which bypasses RLS after a server action has checked the caller's
-- capability.
ALTER TABLE public.permission_baselines ENABLE ROW LEVEL SECURITY;

-- AND THE GRANTS REVOKED AS WELL, not RLS alone — 00076's rule, stated there in
-- one line: "RLS is not a substitute for a grant that should not exist."
-- ALTER DEFAULT PRIVILEGES still hands anon and authenticated SELECT, INSERT,
-- UPDATE and DELETE on every new table in public; 00076 stripped TRUNCATE,
-- REFERENCES and TRIGGER from the defaults and deliberately kept the rest,
-- because every other table genuinely serves them through PostgREST. This one
-- does not serve them at all.
REVOKE ALL ON TABLE public.permission_baselines FROM anon, authenticated;

-- 5. SCHEMA RELOAD --------------------------------------------------------
--
-- A new table and a new column, both reached through PostgREST by the console's
-- service-role client. Without this they exist in Postgres while every request
-- gets PGRST205/PGRST204 — the Baselines tab empty with no error, and the
-- provenance column unwritable. Cheap and idempotent.
NOTIFY pgrst, 'reload schema';
