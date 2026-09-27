-- ============================================================
-- 00256 THE VOCABULARY LEARNS THE AUDIT EXPORT
--
-- WHAT IS ADDED: two strings, `audit.export.read` and `audit.signins.read`,
-- taking the vocabulary from 141 to 143.
--
-- WHY IT IS A MIGRATION AT ALL. The two CHECKs below enumerate every valid
-- capability string, on players.permission_grants / permission_revokes and on
-- permission_baselines.capabilities. A string the CHECK does not know is a
-- string the database REFUSES, so shipping the code without this means the
-- capability exists in TypeScript and every row naming it fails on save. 00247
-- is the last file to have moved these lists; this one supersedes it, and each
-- list below is 00247's copied verbatim with the two appended.
--
-- WHAT THE CAPABILITIES ARE. /audit grows a log-type selector and a CSV
-- download covering console edits, sign-ins, tournament actions and in-app
-- notifications. `audit.export.read` is running a download at all;
-- `audit.signins.read` is the sign-in trail specifically, both as an option on
-- the page and as a source in the file.
--
-- TWO STRINGS AND NOT ONE, because they are different questions. The console
-- trail says what an officer DID. The sign-in trail is the identity log: it
-- carries account email addresses and the times people logged in, for members
-- as well as officers, and it names accounts that have no console access at
-- all. The club's case is somebody who may export what the console did without
-- being handed the record of who signed in and when.
--
-- THERE IS NO THIRD STRING FOR THE PANEL ITSELF. `audit.page` already decides
-- who may open /audit, and the selector is drawn inside it.
--
-- THE NAMES END IN `read` because that is what they are. Nothing here writes:
-- a download is a SELECT and a file. Every string outside the `page` area
-- ends in `page`, `read` or `write`, pinned by a test, so `audit.export` would
-- not be a string this vocabulary can hold even if a bare noun read better.
--
-- ------------------------------------------------------------
-- WHERE THEY SIT RELATIVE TO THE BASELINES
-- ------------------------------------------------------------
-- IN NO BASELINE, ASSIGNABLE TO NOBODY. Not in TRAINER_BASELINE, not in
-- EXEC_BASELINE, not in EXEC_ASSIGNABLE, in none of the four ROLE_DEFAULTS and
-- NOT IN EDITOR_OFFERABLE. An admin holds them by level, the way an admin holds
-- everything; no grant, no custom baseline and no VP role can reach them.
--
-- That is the same footing `audit.page` itself has stood on since 00088, and
-- the same footing 00238 put the three `accounts.apikey.*` strings on. It is
-- the right starting posture rather than a permanent verdict: the whole point
-- of the capability model is that an admin can hand /audit to an officer
-- without making them an admin, and widening either of these is two lines in
-- access-level.ts and its own reviewable diff. What it must not be is the
-- silent side effect of shipping a download.
--
-- WHAT A DOWNLOAD IS THAT A SCREEN IS NOT. The panel already shows console
-- edits to whoever holds `audit.page`, so `audit.export.read` is not hiding
-- anything they cannot read. What it bounds is the FILE: a CSV leaves the
-- console, outlives the session, and is forwarded. Keeping the act of producing
-- one behind its own string is what lets the club open the screen and the file
-- to different people.
--
-- ------------------------------------------------------------
-- PURELY ADDITIVE
-- ------------------------------------------------------------
-- Nothing is removed and nothing is renamed, so no stored array is rewritten.
-- An unknown string in a stored `grants` array is harmless, since the resolver
-- drops it, but a capability deleted from the code while a stored REVOKE still
-- names it is a revoke that silently stops biting, and that is the one way this
-- model can widen somebody by accident. The same claim 00089, 00097, 00098,
-- 00105, 00223, 00232, 00238, 00243, 00244 and 00247 made, held by the same
-- chained test in capability-storage.test.ts.
--
-- NOBODY'S ACCESS CHANGES WHEN THIS IS APPLIED. No row is written. The two
-- strings are in no baseline, in no ROLE_DEFAULTS and in no grant, so no
-- existing person resolves to either of them.
--
-- THE SIGN-IN LOG NEEDS 00257 AS WELL, and the two are deliberately separate
-- files. This one is two ALTERs; that one defines a function and wraps itself
-- in a transaction. Applying this alone is safe and complete on its own terms:
-- the capabilities become spellable, the console's other three log types
-- download, and the sign-ins type answers 503 with a message naming 00257 until
-- it is applied.
--
-- NO TABLE, FUNCTION OR COLUMN IS CREATED HERE, so there is no BEGIN/COMMIT:
-- two ALTERs that each drop and re-add one CHECK, exactly as 00238 shipped.
-- scripts/db-migrate.sh decides `--single-transaction` by grepping the file for
-- a top-level COMMIT, so a file without one gets the flag automatically and
-- still applies atomically.
-- ============================================================

-- 1. THE PLAYER COLUMNS ----------------------------------------------------
--
-- Dropped by name and re-added, never edited in place: 00247 is recorded as
-- applied, so an in-place edit there would never re-run and the two would
-- diverge. The predicate is 00089's, unchanged.
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
    'accounts.page', 'accounts.apikey.read', 'accounts.apikey.mint.write',
    'accounts.apikey.revoke.write', 'platform.page', 'platform.settings.write',
    'page.access.sessions', 'page.access.challenges', 'page.access.tournaments',
    'page.access.leaderboard', 'page.access.my_stats', 'page.access.announcements',
    'page.access.fees',
    'events.page', 'events.signups.read', 'events.signups.remove.write',
    'events.manage.create.write', 'events.manage.update.write',
    'events.manage.cancel.write', 'events.manage.delete.write',
    'page.access.events',
    'page.access.membership', 'page.access.socials',
    'audit.export.read', 'audit.signins.read'
    ]::TEXT[]
  );

-- 2. THE BASELINES TABLE ---------------------------------------------------
--
-- The second copy of the same list (00093). Two copies in SQL can drift, and
-- the direction this one drifts in is a baseline storing a string the code
-- does not know and therefore handing out nothing. Pinned against the same
-- array, and against each other, by capability-storage.test.ts.
--
-- ADMITTED HERE TOO, even though EDITOR_OFFERABLE contains neither string and
-- so no baseline can legitimately carry them. This CHECK only decides whether a
-- string is SPELLABLE; baselineCapabilityRefusal() is what decides whether it
-- may be stored. Keeping the two lists identical is what the test pins, and
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
    'accounts.page', 'accounts.apikey.read', 'accounts.apikey.mint.write',
    'accounts.apikey.revoke.write', 'platform.page', 'platform.settings.write',
    'page.access.sessions', 'page.access.challenges', 'page.access.tournaments',
    'page.access.leaderboard', 'page.access.my_stats', 'page.access.announcements',
    'page.access.fees',
    'events.page', 'events.signups.read', 'events.signups.remove.write',
    'events.manage.create.write', 'events.manage.update.write',
    'events.manage.cancel.write', 'events.manage.delete.write',
    'page.access.events',
    'page.access.membership', 'page.access.socials',
    'audit.export.read', 'audit.signins.read'
    ]::TEXT[]
  );

-- A CHECK constraint is not in the schema cache, but the tables it sits on are,
-- and a reload costs nothing. Consistent with every other migration here.
NOTIFY pgrst, 'reload schema';
