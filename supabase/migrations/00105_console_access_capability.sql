-- ============================================================
-- 00105 — GIVING SOMEBODY THE CONSOLE IS A CAPABILITY
--
-- "also make role change a permission" — the club owner. Two different things
-- are called a role in this console and only one of them was admin-only:
--
--   * permission_role (Finance / Tournaments / Internal / External /
--     Hand-picked) has been a capability since 00087 — setPlayerPermissions is
--     gated on `permissions.write`. Nothing here touches it.
--   * CONSOLE ACCESS — players.role, players.is_exec, players.is_trainer, i.e.
--     making somebody an executive, a varsity trainer or an admin — was
--     `permissions.write` PLUS an explicit isAdminActor() check inside
--     setConsoleAccess. That check is what this migration's capability replaces.
--
-- WHAT IS ADDED: one string, `players.consoleaccess.write`, taking the
-- vocabulary from 118 to 119.
--
-- WHY IT IS A MIGRATION AT ALL. The vocabulary CHECKs below enumerate every
-- valid capability string, on players.permission_grants / permission_revokes and
-- on permission_baselines.capabilities. Shipping the code without this file
-- means the database refuses every row that grants the new string — the
-- capability would exist, be offered by the editor, and fail on save.
--
-- ------------------------------------------------------------
-- THE LINE THIS DOES NOT CROSS
-- ------------------------------------------------------------
-- THE CAPABILITY MAY HAND OUT `executive` AND `trainer`. IT MAY NEVER HAND OUT
-- `admin`. setConsoleAccess still requires isAdminActor() for two branches that
-- no capability opens: setting the level to admin, and changing anybody who is
-- already one. If a capability could mint an admin, holding it would be
-- equivalent to being an admin, and PLAYER_FIELD_FLOOR — the list in
-- apps/admin/src/lib/player-field-access.ts that no capability reaches — would
-- be decorative.
--
-- The floor itself is UNMOVED. role, is_exec, is_trainer and the three
-- permission_* columns are still refused to everybody below admin by
-- assertPlayerFieldAccess, which is what stands in front of updatePlayer() and
-- therefore in front of the member Edit dialog. The capability is read in one
-- place only, setConsoleAccess, where the act is bounded by grant closure on
-- both sides: what the target holds now must be inside the actor's own set, and
-- what they would hold afterwards must be too.
--
-- WHAT THAT BOUND BUYS, concretely: an unrestricted executive resolves to
-- EXEC_BASELINE's 73 capabilities and an unrestricted varsity trainer to
-- TRAINER_BASELINE's 3. So a holder whose own set is trainer-sized may promote
-- somebody to varsity trainer and is refused when they try to promote to
-- executive. That is why this is ONE capability rather than two: the graduation
-- between the two levels is a consequence of the baselines rather than a second
-- tick box that would have to be kept in step with them.
--
-- ------------------------------------------------------------
-- WHERE IT SITS RELATIVE TO THE BASELINES
-- ------------------------------------------------------------
-- NOT IN EXEC_BASELINE, and that list does not move. The club owner: "exec
-- baseline shouldn't really be too much." Putting it there would hand every
-- executive in the club the ability to make more executives, with nobody
-- choosing it.
--
-- NOT IN TRAINER_BASELINE and in none of the four ROLE_DEFAULTS, for the same
-- reason.
--
-- IN EDITOR_OFFERABLE, which is the ceiling on what an admin may compose
-- somebody UP to rather than anybody's baseline. It has to be, or the feature is
-- a decoration: check 5 of setPlayerPermissions refuses any stored grant outside
-- that list, and both editors build their tick boxes by iterating it, so a
-- capability that is not there cannot be granted, cannot be put in a baseline
-- and cannot even be rendered. It is the FIRST write on that list — the four
-- entries before it are the /fees reads 00104 added.
--
-- So it is reachable exactly two ways, both deliberate: an explicit per-person
-- grant, or a baseline (including one of the four editable built-in roles) that
-- somebody deliberately puts it in.
--
-- NOTE ON THE AREA. It is `players.consoleaccess.write` and not
-- `permissions.console.write` because `permissions.write` is the vocabulary's
-- only bare <area>.write, so every permissions.<x>.write would have it as a
-- strict prefix at the same mode — the shape the no-prefix rule refuses, and
-- refuses for exactly this hazard: a coarse permissions.write reading as though
-- it implied the finer console act. It belongs in `players` anyway: what it
-- writes is three columns on a player row, beside players.privilegedfields.write
-- which is the other slice off the same floor.
--
-- ------------------------------------------------------------
-- PURELY ADDITIVE
-- ------------------------------------------------------------
-- Nothing is removed and nothing is renamed, so no stored array is rewritten.
-- An unknown string in a stored `grants` array is harmless — the resolver drops
-- it and nobody gains anything — but a capability deleted from the code while a
-- stored REVOKE still names it is a revoke that silently stops biting, and that
-- is the one way this model can widen somebody by accident. The same claim
-- 00089, 00097 and 00098 made, held by the same chained test in
-- capability-storage.test.ts.
--
-- NOBODY'S ACCESS CHANGES WHEN THIS IS APPLIED. No row is written. The new
-- string is in no baseline and in no ROLE_DEFAULTS, so no existing person
-- resolves to it, and the capability-equivalence table pins the new row at
-- admin ✓ exec ✗ trainer ✗ — which is what the isAdminActor() check it replaces
-- answered — with no existing row's answer moved.
-- ============================================================

-- 1. THE PLAYER COLUMNS ----------------------------------------------------
--
-- Dropped by name and re-added, never edited in place: staging has 00098
-- recorded as applied, so an in-place edit would never re-run there and the two
-- databases would diverge. The predicate is 00089's, unchanged.
ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_permission_vocabulary_check;
ALTER TABLE public.players ADD CONSTRAINT players_permission_vocabulary_check
  CHECK (
    (permission_grants || permission_revokes) <@ ARRAY[
    'players.page', 'players.read', 'players.approve.write',
    'players.create.write', 'players.update.write', 'players.waiver.resign.write',
    'players.ban.write', 'players.reinstate.write', 'players.editor.varsitynotes.write',
    'players.deletion.cancel.write', 'players.remove.write', 'players.merge.write',
    'players.reliability.write', 'players.privilegedfields.write', 'players.consoleaccess.write',
    'seasons.page', 'seasons.create.write', 'seasons.activate.write',
    'seasons.end.write', 'seasons.fees.write', 'sessions.page',
    'sessions.reminders.write', 'sessions.create.write', 'sessions.update.write',
    'sessions.archive.write', 'sessions.checkin.token.write', 'sessions.attendance.write',
    'sessions.delete.write', 'matches.page', 'matches.void.write',
    'matches.convert.write', 'matches.create.write', 'challenges.page',
    'challenges.create.write', 'challenges.expire.write', 'announcements.page',
    'announcements.create.write', 'announcements.update.write', 'announcements.delete.write',
    'tournaments.page', 'tournaments.manage.create.write', 'tournaments.manage.update.write',
    'tournaments.manage.status.write', 'tournaments.manage.suspend.write', 'tournaments.manage.resume.write',
    'tournaments.manage.archive.write', 'tournaments.manage.delete.write', 'tournaments.manage.event.create.write',
    'tournaments.manage.event.update.write', 'tournaments.manage.event.delete.write', 'tournaments.manage.event.status.write',
    'tournaments.draw.participants.add.write', 'tournaments.draw.participants.remove.write', 'tournaments.draw.checkin.token.write',
    'tournaments.draw.checkin.mark.write', 'tournaments.draw.noshow.write', 'tournaments.draw.exit.write',
    'tournaments.draw.pairs.add.write', 'tournaments.draw.pairs.remove.write', 'tournaments.draw.seed.set.write',
    'tournaments.draw.seed.auto.write', 'tournaments.draw.seed.clear.write', 'tournaments.draw.generate.write',
    'tournaments.draw.lock.write', 'tournaments.draw.unlock.write', 'tournaments.draw.waivers.read',
    'tournaments.draw.entrycounts.read', 'tournaments.results.enter.write', 'tournaments.results.walkover.write',
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

-- 2. THE BASELINES TABLE ---------------------------------------------------
--
-- The second copy of the same list (00093). Two copies in SQL can drift, and the
-- direction this one drifts in is a baseline storing a string the code does not
-- know and therefore handing out nothing. Pinned against the same array, and
-- against each other, by capability-storage.test.ts.
--
-- The new string is admitted here as well as on the player columns, and that is
-- deliberate rather than incidental: EDITOR_OFFERABLE contains it, so a baseline
-- — including one of the four editable built-in roles — may legitimately carry
-- it. baselineCapabilityRefusal() is what decides whether it may; this CHECK
-- only decides whether the string is spellable.
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
    'players.reliability.write', 'players.privilegedfields.write', 'players.consoleaccess.write',
    'seasons.page', 'seasons.create.write', 'seasons.activate.write',
    'seasons.end.write', 'seasons.fees.write', 'sessions.page',
    'sessions.reminders.write', 'sessions.create.write', 'sessions.update.write',
    'sessions.archive.write', 'sessions.checkin.token.write', 'sessions.attendance.write',
    'sessions.delete.write', 'matches.page', 'matches.void.write',
    'matches.convert.write', 'matches.create.write', 'challenges.page',
    'challenges.create.write', 'challenges.expire.write', 'announcements.page',
    'announcements.create.write', 'announcements.update.write', 'announcements.delete.write',
    'tournaments.page', 'tournaments.manage.create.write', 'tournaments.manage.update.write',
    'tournaments.manage.status.write', 'tournaments.manage.suspend.write', 'tournaments.manage.resume.write',
    'tournaments.manage.archive.write', 'tournaments.manage.delete.write', 'tournaments.manage.event.create.write',
    'tournaments.manage.event.update.write', 'tournaments.manage.event.delete.write', 'tournaments.manage.event.status.write',
    'tournaments.draw.participants.add.write', 'tournaments.draw.participants.remove.write', 'tournaments.draw.checkin.token.write',
    'tournaments.draw.checkin.mark.write', 'tournaments.draw.noshow.write', 'tournaments.draw.exit.write',
    'tournaments.draw.pairs.add.write', 'tournaments.draw.pairs.remove.write', 'tournaments.draw.seed.set.write',
    'tournaments.draw.seed.auto.write', 'tournaments.draw.seed.clear.write', 'tournaments.draw.generate.write',
    'tournaments.draw.lock.write', 'tournaments.draw.unlock.write', 'tournaments.draw.waivers.read',
    'tournaments.draw.entrycounts.read', 'tournaments.results.enter.write', 'tournaments.results.walkover.write',
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

-- Nothing else moves. The role list (00091), the not-null and disjointness
-- CHECKs, the deltas-need-a-role CHECK, guard_player_privileged_columns(),
-- guard_last_admin_role() and admin_access_level() are all unchanged — this
-- migration touches the two vocabulary CHECKs and nothing else.
--
-- guard_last_admin_role() is worth naming explicitly because this change adds a
-- second writer of role/is_exec/is_trainer in the application. It is a BEFORE
-- UPDATE OR DELETE trigger on public.players, so it fires on that statement
-- exactly as it fires on updatePlayer's. It could not be reached from the new
-- path anyway: demoting an admin requires isAdminActor(), and the new writer
-- only runs when the actor is not one.
--
-- No NOTIFY: no column, function or signature changed, so PostgREST's cached
-- schema is still correct.
