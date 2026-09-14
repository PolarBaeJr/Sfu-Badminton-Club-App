-- ============================================================
-- 00232 THE CONSOLE MAY LINK A DISCORD ACCOUNT
--
-- WHAT IS ADDED: one string, `players.discordlink.write`, taking the
-- vocabulary from 120 to 121.
--
-- WHY IT IS A MIGRATION AT ALL, and this is the whole file. The vocabulary
-- CHECKs below enumerate every valid capability string, on
-- players.permission_grants / permission_revokes and on
-- permission_baselines.capabilities. A string the CHECK does not know is a
-- string the database REFUSES, so shipping the code without this means the
-- capability exists in TypeScript and every row granting it fails on save.
-- 00223 is the last file to have moved these lists; this one supersedes it.
--
-- WHAT THE CAPABILITY IS. 00165 gave a member `/link`: the member runs it,
-- spends a single-use token, and their Discord account is attached to their
-- roster row. That is still the ordinary path and nothing here relaxes it.
-- What did not exist was any way for an officer to do it FOR somebody, so a
-- member who will not or cannot walk that flow could not be linked at all.
-- This is the key on that second path.
--
-- IT IS NOT A SECOND WAY TO MERGE, which is why it is its own string rather
-- than a reuse of `players.merge.write`. Merging folds two roster rows into a
-- single member. This attaches an EXTERNAL identity to a roster row that is
-- already whole: no column on `players` is touched, and the row it writes
-- lives in `player_discord_links`, which the console otherwise never writes.
-- Reusing the merge string would have handed everybody holding it a second act
-- sharing none of the bounds that made the first one safe.
--
-- IT IS NOT A NEW AREA. A `discord` area would need a `discord.page`, and
-- there is no Discord page to open: the panel lives on a member's record,
-- behind `players.page`.
--
-- ------------------------------------------------------------
-- WHERE IT SITS RELATIVE TO THE BASELINES
-- ------------------------------------------------------------
-- NOT IN EXEC_BASELINE, NOT IN EXEC_ASSIGNABLE, AND IN NONE OF THE FOUR
-- ROLE_DEFAULTS. Nobody holds it by default and no built-in role hands it out.
--
-- AND NOT IN EDITOR_OFFERABLE EITHER, which is the OPPOSITE of what 00223
-- chose for its string, and is chosen deliberately rather than inherited from
-- the template. Check 5 of setPlayerPermissions refuses any stored grant
-- outside that ceiling and both editors build their tick boxes by iterating
-- it, so a capability left out of it cannot be put in a baseline and is not
-- rendered anywhere. 00223 argued that leaving a string out makes "admin-only"
-- mean "admin-only forever". That is accepted here and taken anyway, because
-- of who this act reaches: re-linking a member DISPLACES whatever Discord
-- account was attached to them, and the displaced account loses its club roles
-- on the next sweep without ever being consulted. It is the posture
-- `players.merge.write` and `players.remove.write` already have, for the same
-- reason they have it. Widening it later is a migration plus a deliberate edit
-- to that ceiling, which is the point.
--
-- So it is reachable exactly one way: an explicit per-person grant, by an
-- admin, on one named officer.
--
-- ------------------------------------------------------------
-- PURELY ADDITIVE
-- ------------------------------------------------------------
-- Nothing is removed and nothing is renamed, so no stored array is rewritten.
-- An unknown string in a stored `grants` array is harmless, since the resolver
-- drops it, but a capability deleted from the code while a stored REVOKE still
-- names it is a revoke that silently stops biting, and that is the one way
-- this model can widen somebody by accident. The same claim 00089, 00097,
-- 00098, 00105 and 00223 made, held by the same chained test in
-- capability-storage.test.ts.
--
-- NOBODY'S ACCESS CHANGES WHEN THIS IS APPLIED. No row is written. The new
-- string is in no baseline, in no ROLE_DEFAULTS and in no grant, so no
-- existing person resolves to it.
--
-- NO TABLE, FUNCTION OR COLUMN IS CREATED HERE, so there is no BEGIN/COMMIT:
-- two ALTERs that each drop and re-add one CHECK, exactly as 00223 shipped.
-- ============================================================

-- 1. THE PLAYER COLUMNS ----------------------------------------------------
--
-- Dropped by name and re-added, never edited in place: 00223 is recorded as
-- applied on both databases, so an in-place edit there would never re-run and
-- the two would diverge. The predicate is 00089's, unchanged.
ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_permission_vocabulary_check;
ALTER TABLE public.players ADD CONSTRAINT players_permission_vocabulary_check
  CHECK (
    (permission_grants || permission_revokes) <@ ARRAY[
    'players.page', 'players.read', 'players.approve.write',
    'players.create.write', 'players.update.write', 'players.waiver.resign.write',
    'players.ban.write', 'players.reinstate.write', 'players.editor.varsitynotes.write',
    'players.deletion.cancel.write', 'players.remove.write', 'players.merge.write',
    'players.reliability.write', 'players.privilegedfields.write', 'players.consoleaccess.write',
    'players.discordlink.write',
    'seasons.page', 'seasons.create.write', 'seasons.activate.write',
    'seasons.end.write', 'seasons.fees.write', 'sessions.page',
    'sessions.reminders.write', 'sessions.create.write', 'sessions.update.write',
    'sessions.archive.write', 'sessions.checkin.token.write', 'sessions.attendance.write',
    'sessions.delete.write', 'matches.page', 'matches.void.write',
    'matches.convert.write', 'matches.create.write', 'challenges.page',
    'challenges.create.write', 'challenges.expire.write', 'announcements.page',
    'announcements.create.write', 'announcements.update.write', 'announcements.delete.write',
    'announcements.discord.write', 'tournaments.page', 'tournaments.manage.create.write',
    'tournaments.manage.update.write', 'tournaments.manage.status.write', 'tournaments.manage.suspend.write',
    'tournaments.manage.resume.write', 'tournaments.manage.archive.write', 'tournaments.manage.delete.write',
    'tournaments.manage.event.create.write', 'tournaments.manage.event.update.write', 'tournaments.manage.event.delete.write',
    'tournaments.manage.event.status.write', 'tournaments.draw.participants.add.write', 'tournaments.draw.participants.remove.write',
    'tournaments.draw.checkin.token.write', 'tournaments.draw.checkin.mark.write', 'tournaments.draw.noshow.write',
    'tournaments.draw.exit.write', 'tournaments.draw.pairs.add.write', 'tournaments.draw.pairs.remove.write',
    'tournaments.draw.seed.set.write', 'tournaments.draw.seed.auto.write', 'tournaments.draw.seed.clear.write',
    'tournaments.draw.generate.write', 'tournaments.draw.lock.write', 'tournaments.draw.unlock.write',
    'tournaments.draw.waivers.read', 'tournaments.draw.entrycounts.read', 'tournaments.results.enter.write',
    'tournaments.results.walkover.write', 'tournaments.results.void.write', 'tournaments.results.unvoid.write',
    'tournaments.results.undo.write', 'tournaments.results.edit.write', 'tournaments.results.entry.write',
    'tournaments.results.doublenoshow.write', 'tournaments.results.bonuses.write', 'tournaments.results.standings.write',
    'tournaments.results.finalize.write', 'tournaments.fees.read', 'tournaments.fees.tier.create.write',
    'tournaments.fees.tier.update.write', 'tournaments.fees.tier.delete.write', 'tournaments.fees.markpaid.write',
    'tournaments.fees.markunpaid.write', 'fees.page', 'fees.expenses.read',
    'fees.expenses.add.write', 'fees.expenses.update.write', 'fees.expenses.reimburse.write',
    'fees.expenses.remove.write', 'fees.otherincome.read', 'fees.otherincome.add.write',
    'fees.otherincome.remove.write', 'fees.clubfees.read', 'fees.clubfees.markpaid.write',
    'fees.clubfees.markunpaid.write', 'fees.clubfees.waive.write', 'fees.clubfees.addmanual.write',
    'fees.clubfees.removemanual.write', 'fees.reinstatements.read', 'fees.reinstatements.write',
    'fees.netposition.read', 'fees.playerflags.write', 'legal.page',
    'legal.reacceptance.write', 'legal.documents.write', 'legal.waivertemplate.write',
    'walkovers.page', 'walkovers.confirm.write', 'walkovers.reject.write',
    'disputes.page', 'disputes.resolve.write', 'permissions.page',
    'permissions.write', 'audit.page', 'ratings.page',
    'accounts.page', 'platform.page', 'platform.settings.write'
    ]::TEXT[]
  );

-- 2. THE BASELINES TABLE ---------------------------------------------------
--
-- The second copy of the same list (00093). Two copies in SQL can drift, and
-- the direction this one drifts in is a baseline storing a string the code
-- does not know and therefore handing out nothing. Pinned against the same
-- array, and against each other, by capability-storage.test.ts.
--
-- ADMITTED HERE TOO, even though EDITOR_OFFERABLE does not contain it and so
-- no baseline can legitimately carry it today. This CHECK only decides whether
-- the string is SPELLABLE; baselineCapabilityRefusal() is what decides whether
-- it may be stored. Keeping the two lists identical is what the test pins, and
-- letting them diverge here to express a rule that is enforced in TypeScript
-- would put a second, weaker copy of that rule in SQL.
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
    'players.discordlink.write',
    'seasons.page', 'seasons.create.write', 'seasons.activate.write',
    'seasons.end.write', 'seasons.fees.write', 'sessions.page',
    'sessions.reminders.write', 'sessions.create.write', 'sessions.update.write',
    'sessions.archive.write', 'sessions.checkin.token.write', 'sessions.attendance.write',
    'sessions.delete.write', 'matches.page', 'matches.void.write',
    'matches.convert.write', 'matches.create.write', 'challenges.page',
    'challenges.create.write', 'challenges.expire.write', 'announcements.page',
    'announcements.create.write', 'announcements.update.write', 'announcements.delete.write',
    'announcements.discord.write', 'tournaments.page', 'tournaments.manage.create.write',
    'tournaments.manage.update.write', 'tournaments.manage.status.write', 'tournaments.manage.suspend.write',
    'tournaments.manage.resume.write', 'tournaments.manage.archive.write', 'tournaments.manage.delete.write',
    'tournaments.manage.event.create.write', 'tournaments.manage.event.update.write', 'tournaments.manage.event.delete.write',
    'tournaments.manage.event.status.write', 'tournaments.draw.participants.add.write', 'tournaments.draw.participants.remove.write',
    'tournaments.draw.checkin.token.write', 'tournaments.draw.checkin.mark.write', 'tournaments.draw.noshow.write',
    'tournaments.draw.exit.write', 'tournaments.draw.pairs.add.write', 'tournaments.draw.pairs.remove.write',
    'tournaments.draw.seed.set.write', 'tournaments.draw.seed.auto.write', 'tournaments.draw.seed.clear.write',
    'tournaments.draw.generate.write', 'tournaments.draw.lock.write', 'tournaments.draw.unlock.write',
    'tournaments.draw.waivers.read', 'tournaments.draw.entrycounts.read', 'tournaments.results.enter.write',
    'tournaments.results.walkover.write', 'tournaments.results.void.write', 'tournaments.results.unvoid.write',
    'tournaments.results.undo.write', 'tournaments.results.edit.write', 'tournaments.results.entry.write',
    'tournaments.results.doublenoshow.write', 'tournaments.results.bonuses.write', 'tournaments.results.standings.write',
    'tournaments.results.finalize.write', 'tournaments.fees.read', 'tournaments.fees.tier.create.write',
    'tournaments.fees.tier.update.write', 'tournaments.fees.tier.delete.write', 'tournaments.fees.markpaid.write',
    'tournaments.fees.markunpaid.write', 'fees.page', 'fees.expenses.read',
    'fees.expenses.add.write', 'fees.expenses.update.write', 'fees.expenses.reimburse.write',
    'fees.expenses.remove.write', 'fees.otherincome.read', 'fees.otherincome.add.write',
    'fees.otherincome.remove.write', 'fees.clubfees.read', 'fees.clubfees.markpaid.write',
    'fees.clubfees.markunpaid.write', 'fees.clubfees.waive.write', 'fees.clubfees.addmanual.write',
    'fees.clubfees.removemanual.write', 'fees.reinstatements.read', 'fees.reinstatements.write',
    'fees.netposition.read', 'fees.playerflags.write', 'legal.page',
    'legal.reacceptance.write', 'legal.documents.write', 'legal.waivertemplate.write',
    'walkovers.page', 'walkovers.confirm.write', 'walkovers.reject.write',
    'disputes.page', 'disputes.resolve.write', 'permissions.page',
    'permissions.write', 'audit.page', 'ratings.page',
    'accounts.page', 'platform.page', 'platform.settings.write'
    ]::TEXT[]
  );

-- A CHECK constraint is not in the schema cache, but the tables it sits on are,
-- and a reload costs nothing. Consistent with every other migration here.
NOTIFY pgrst, 'reload schema';
