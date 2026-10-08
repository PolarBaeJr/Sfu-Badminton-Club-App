-- ============================================================
-- 00088 — "may open this section" is not "may see the data in it"
--
-- 00087 shipped a vocabulary with two modes, read and write, and the route gate
-- admitted somebody to a section only on a capability ending `.read`. That made
-- one thing the club owner asked for impossible to express: a person who may
-- "access the page to add stuff, but not see the details in them". A pure-write
-- holder could not reach the screen their write lives on.
--
-- So there is a third mode. `<area>.page` is depth 2, exactly one per area, and
-- it is the only thing the route gate and the nav ever ask for. `<area>.….read`
-- keeps gating individual FETCHES, and `<area>.….write` is unchanged.
--
-- FOURTEEN CAPABILITIES ARE RENAMED and two are new, so this migration has two
-- jobs and the ORDER MATTERS IN BOTH DIRECTIONS. It is DROP, then UPDATE, then
-- ADD, and neither of the other two orders works:
--
--   * ADD before UPDATE fails, because a row still holding 'players.read' is
--     re-validated against a list that no longer has it.
--   * UPDATE before DROP fails, because 00087's constraint is still active and
--     does not contain 'players.page' — the row is re-validated on write and
--     rejected. A CHECK is enforced on every UPDATE, not only at creation, so
--     the window between the two ALTERs is the only place the rewrite can run.
--
-- Both failures are invisible today (see the UPDATE's own note on why it
-- currently matches no rows) and would land the first time somebody has been
-- narrowed, which is precisely when nobody is looking for them.
--
-- NOTHING CHANGES FOR ANYONE. Both baselines gained the page capability for
-- every area they already reached (exec 69 → 70, trainer still 2), so an
-- unrestricted exec and an unrestricted trainer resolve to exactly the access
-- they have today. Pinned by the capability-equivalence table, where every
-- pre-existing row's admin/exec/trainer answer is unmoved.
--
-- `write ⊆ read` IS GONE, and it is not coming back. 00087 put it in the
-- resolver with a note saying no CHECK could see it; the rule itself was wrong
-- — write-without-read is the state this change exists to allow — and it was
-- also broken, matching a `.read` sibling at the same path that only two of the
-- ninety-three writes ever had. What replaces it is ONE invariant: every
-- capability in an area requires that area's `.page`. That is still a property
-- of the RESOLVED set (revoking `fees.page` has to take the ledgers with it even
-- when they came from the role and are named in neither array), so it still
-- lives in resolvePermissions() and still runs after subtraction. There is
-- deliberately no SQL version of it.
-- ============================================================

-- 1. THE OLD CONSTRAINT, OUT OF THE WAY -----------------------------------
--
-- Dropped BEFORE the rewrite rather than alongside the new one, because a CHECK
-- is enforced on every UPDATE and 00087's list does not contain a single one of
-- the names the rewrite is about to write. The table is unconstrained for the
-- two statements between here and the ADD at the end; that is a transaction, and
-- nothing but this file writes to those columns while it runs.
--
-- Dropped by name rather than edited in place in 00087, for the same reason
-- 00086 was not edited: staging has 00087 recorded as applied, so an in-place
-- edit would never re-run there and the two databases would diverge.
ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_permission_vocabulary_check;

-- 2. THE STORED ARRAYS ----------------------------------------------------
--
-- A RENAME, NOT A CLEANUP. Dropping the old strings instead of mapping them
-- would be the exact hazard 00087's header is built around: an unknown element
-- in `permission_revokes` fails to REMOVE something, and the something it fails
-- to remove might be permissions.write. A stored revoke of `players.read` means
-- "this person may not open the roster", and that sentence is spelled
-- `players.page` now.
--
-- THIS IS A NO-OP ON EVERY DATABASE TODAY, and that is why it is cheap rather
-- than why it is unnecessary: players_permission_deltas_need_role_check forces
-- both arrays empty while permission_role IS NULL, and every row on staging and
-- production is still NULL. It is here so the file is correct the first time
-- somebody has been narrowed — which is the day it stops being a no-op and the
-- day nobody would think to write it.
--
-- Run against both arrays through one expression each. `unnest` + `array_agg`
-- rather than array_replace called fourteen times: fourteen nested calls is
-- unreadable and a typo in the middle of one is invisible.
WITH renamed(old_name, new_name) AS (
  VALUES
    ('players.read',            'players.page'),
    ('seasons.read',            'seasons.page'),
    ('sessions.read',           'sessions.page'),
    ('matches.read',            'matches.page'),
    ('challenges.read',         'challenges.page'),
    ('announcements.read',      'announcements.page'),
    ('tournaments.manage.read', 'tournaments.page'),
    ('legal.read',              'legal.page'),
    ('walkovers.read',          'walkovers.page'),
    ('disputes.read',           'disputes.page'),
    ('permissions.read',        'permissions.page'),
    ('audit.read',              'audit.page'),
    ('ratings.read',            'ratings.page'),
    ('accounts.read',           'accounts.page')
)
UPDATE public.players p
SET
  permission_grants = (
    SELECT COALESCE(array_agg(COALESCE(r.new_name, e)), '{}'::TEXT[])
    FROM unnest(p.permission_grants) AS e
    LEFT JOIN renamed r ON r.old_name = e
  ),
  permission_revokes = (
    SELECT COALESCE(array_agg(COALESCE(r.new_name, e)), '{}'::TEXT[])
    FROM unnest(p.permission_revokes) AS e
    LEFT JOIN renamed r ON r.old_name = e
  )
WHERE p.permission_grants && (SELECT array_agg(old_name) FROM renamed)
   OR p.permission_revokes && (SELECT array_agg(old_name) FROM renamed);

-- 3. THE VOCABULARY, RE-PINNED --------------------------------------------
--
-- All 115, replacing 00087's 113. The reasoning for having this constraint at
-- all is unchanged and is written out in 00087: it is here for the REVOKES, and
-- what it really buys is that REMOVING A CAPABILITY IS A MIGRATION — you cannot
-- delete a string from the code without editing this list, and editing this list
-- is what forces the UPDATE above to be written.
ALTER TABLE public.players ADD CONSTRAINT players_permission_vocabulary_check
  CHECK (
    (permission_grants || permission_revokes) <@ ARRAY[
    'players.page', 'players.approve.write', 'players.create.write',
    'players.update.write', 'players.waiver.resign.write', 'players.ban.write',
    'players.reinstate.write', 'players.editor.varsitynotes.write', 'players.deletion.cancel.write',
    'players.remove.write', 'players.merge.write', 'players.reliability.write',
    'players.privilegedfields.write', 'seasons.page', 'seasons.create.write',
    'seasons.activate.write', 'seasons.end.write', 'seasons.fees.write',
    'sessions.page', 'sessions.reminders.write', 'sessions.create.write',
    'sessions.update.write', 'sessions.archive.write', 'sessions.checkin.token.write',
    'sessions.attendance.write', 'sessions.delete.write', 'matches.page',
    'matches.void.write', 'matches.convert.write', 'matches.create.write',
    'challenges.page', 'challenges.create.write', 'challenges.expire.write',
    'announcements.page', 'announcements.create.write', 'announcements.update.write',
    'announcements.delete.write', 'tournaments.page', 'tournaments.manage.create.write',
    'tournaments.manage.update.write', 'tournaments.manage.status.write', 'tournaments.manage.suspend.write',
    'tournaments.manage.resume.write', 'tournaments.manage.archive.write', 'tournaments.manage.delete.write',
    'tournaments.manage.event.create.write', 'tournaments.manage.event.update.write', 'tournaments.manage.event.delete.write',
    'tournaments.manage.event.status.write', 'tournaments.draw.participants.add.write', 'tournaments.draw.participants.remove.write',
    'tournaments.draw.checkin.token.write', 'tournaments.draw.checkin.mark.write', 'tournaments.draw.noshow.write',
    'tournaments.draw.exit.write', 'tournaments.draw.pairs.add.write', 'tournaments.draw.pairs.remove.write',
    'tournaments.draw.seed.set.write', 'tournaments.draw.seed.auto.write', 'tournaments.draw.seed.clear.write',
    'tournaments.draw.generate.write', 'tournaments.draw.lock.write', 'tournaments.draw.unlock.write',
    'tournaments.results.enter.write', 'tournaments.results.walkover.write', 'tournaments.results.void.write',
    'tournaments.results.unvoid.write', 'tournaments.results.undo.write', 'tournaments.results.edit.write',
    'tournaments.results.entry.write', 'tournaments.results.doublenoshow.write', 'tournaments.results.bonuses.write',
    'tournaments.results.standings.write', 'tournaments.results.finalize.write', 'tournaments.fees.read',
    'tournaments.fees.tier.create.write', 'tournaments.fees.tier.update.write', 'tournaments.fees.tier.delete.write',
    'tournaments.fees.markpaid.write', 'tournaments.fees.markunpaid.write', 'fees.page',
    'fees.expenses.read', 'fees.expenses.add.write', 'fees.expenses.update.write',
    'fees.expenses.reimburse.write', 'fees.expenses.remove.write', 'fees.otherincome.read',
    'fees.otherincome.add.write', 'fees.otherincome.remove.write', 'fees.clubfees.read',
    'fees.clubfees.markpaid.write', 'fees.clubfees.markunpaid.write', 'fees.clubfees.waive.write',
    'fees.clubfees.addmanual.write', 'fees.clubfees.removemanual.write', 'fees.reinstatements.read',
    'fees.reinstatements.write', 'fees.netposition.read', 'fees.playerflags.write',
    'legal.page', 'legal.reacceptance.write', 'legal.documents.write',
    'legal.waivertemplate.write', 'walkovers.page', 'walkovers.confirm.write',
    'walkovers.reject.write', 'disputes.page', 'disputes.resolve.write',
    'permissions.page', 'permissions.write', 'audit.page',
    'ratings.page', 'accounts.page', 'platform.page',
    'platform.settings.write'
    ]::TEXT[]
  );

-- Nothing else from 00087 moves. The role list, the not-null and disjointness
-- CHECKs, the deltas-need-a-role CHECK, guard_player_privileged_columns() and
-- admin_console_access() are all unchanged — this migration touches the
-- vocabulary and the values written in it, and nothing else.
--
-- No NOTIFY here: no column, function or signature changed, so PostgREST's
-- cached schema is still correct.
