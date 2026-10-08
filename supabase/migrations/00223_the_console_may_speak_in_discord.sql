-- ============================================================
-- 00223 — THE CONSOLE MAY SPEAK IN DISCORD
--
-- WHAT IS ADDED: one string, `announcements.discord.write`, taking the
-- vocabulary from 119 to 120.
--
-- WHY IT IS A MIGRATION AT ALL, and this is the whole file. The vocabulary
-- CHECKs below enumerate every valid capability string, on
-- players.permission_grants / permission_revokes and on
-- permission_baselines.capabilities. Shipping the code without this means the
-- database REFUSES every row that grants the new string — the capability would
-- exist, be offered by the editor, and fail on save. 00105 is the last file to
-- have moved these lists; this one supersedes it.
--
-- WHAT THE CAPABILITY IS. 00222 gives the console an outbox the bot drains: an
-- exec writes a message and the bot posts it in the club's Discord channel.
-- This is the key on that action — the console's half of the bot's /say, which
-- in Discord is gated by MANAGE_GUILD.
--
-- IT IS NOT A FOURTH WAY TO WRITE AN ANNOUNCEMENT, which is why it is its own
-- string rather than a reuse of `announcements.create.write`. It reaches a
-- different audience by a different route — a member who never opens the
-- website is in that channel — and nothing the console offers can take a
-- posted Discord message back the way unpublishing takes an announcement down.
--
-- IT IS NOT A NEW AREA. `discord` as an area would need a `discord.page`, and
-- there is no Discord page to open: the panel lives on /announcements, behind
-- that page's key.
--
-- ------------------------------------------------------------
-- WHERE IT SITS RELATIVE TO THE BASELINES
-- ------------------------------------------------------------
-- NOT IN EXEC_BASELINE, NOT IN EXEC_ASSIGNABLE, AND IN NONE OF THE FOUR
-- ROLE_DEFAULTS. Nobody holds it by default and no built-in role hands it out.
--
-- IN EDITOR_OFFERABLE, for the structural reason 00105 spells out: check 5 of
-- setPlayerPermissions refuses any stored grant outside that ceiling, and both
-- editors build their tick boxes by iterating it — so a capability that is not
-- there cannot be granted, cannot be put in a baseline, and is not even
-- rendered. Leaving it out would make "admin-only" mean "admin-only forever"
-- rather than "not handed out by default".
--
-- So it is reachable exactly two ways, both deliberate: an explicit per-person
-- grant, or a baseline somebody deliberately puts it in. The same posture
-- `players.consoleaccess.write` has, and for the same reason — this is the act
-- with no undo.
--
-- HANDING IT TO A VP JOB IS A DIFFERENT MIGRATION. The four portfolios are
-- SEEDED ROWS (00104) and editable-roles.test.ts reads that file as text, so
-- widening one means re-seeding the row, not editing a constant. Doing it as a
-- side effect of shipping the feature is how "reset to shipped default" ends up
-- restoring something that was never shipped.
--
-- ------------------------------------------------------------
-- PURELY ADDITIVE
-- ------------------------------------------------------------
-- Nothing is removed and nothing is renamed, so no stored array is rewritten.
-- An unknown string in a stored `grants` array is harmless — the resolver drops
-- it — but a capability deleted from the code while a stored REVOKE still names
-- it is a revoke that silently stops biting, and that is the one way this model
-- can widen somebody by accident. The same claim 00089, 00097, 00098 and 00105
-- made, held by the same chained test in capability-storage.test.ts.
--
-- NOBODY'S ACCESS CHANGES WHEN THIS IS APPLIED. No row is written. The new
-- string is in no baseline and in no ROLE_DEFAULTS, so no existing person
-- resolves to it.
-- ============================================================

-- 1. THE PLAYER COLUMNS ----------------------------------------------------
--
-- Dropped by name and re-added, never edited in place: 00105 is recorded as
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
-- the direction this one drifts in is a baseline storing a string the code does
-- not know and therefore handing out nothing. Pinned against the same array,
-- and against each other, by capability-storage.test.ts.
--
-- The new string is admitted here as well as on the player columns because
-- EDITOR_OFFERABLE contains it, so a baseline may legitimately carry it. This
-- CHECK only decides whether the string is SPELLABLE;
-- baselineCapabilityRefusal() is what decides whether it may be stored.
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
