-- ============================================================
-- 00238 THE VOCABULARY LEARNS THE DATA API'S KEYS
--
-- WHAT IS ADDED: three strings, `accounts.apikey.read`,
-- `accounts.apikey.mint.write` and `accounts.apikey.revoke.write`, taking the
-- vocabulary from 121 to 124.
--
-- WHY IT IS A MIGRATION AT ALL. The two CHECKs below enumerate every valid
-- capability string, on players.permission_grants / permission_revokes and on
-- permission_baselines.capabilities. A string the CHECK does not know is a
-- string the database REFUSES, so shipping the code without this means the
-- capability exists in TypeScript and every row naming it fails on save. 00232
-- is the last file to have moved these lists; this one supersedes it.
--
-- WHAT THE CAPABILITIES ARE. A read-only external data API serves player and
-- rating data to anything outside the console, and it authenticates with keys
-- minted from a panel on /accounts. Three strings and not one, because seeing
-- which keys exist, minting a new one and taking an existing one back are three
-- different questions and the club's case is somebody who may see the list and
-- hand nothing out.
--
-- THE NAMES ARE NOT THE ONES ASKED FOR, and the reason is grammar rather than
-- taste. The request was `accounts.apikey.mint` and `accounts.apikey.delete`.
-- Every string in these lists ends in `page`, `read` or `write`, pinned by a
-- test, so a bare `.mint` is not a string this vocabulary can hold. The verb
-- moves one segment left and the mode goes on the end;
-- `fees.expenses.add.write` / `fees.expenses.remove.write` is the precedent for
-- splitting creating a thing from taking it away.
--
-- REVOKE RATHER THAN DELETE, because that is the act. Revoking a key sets
-- `revoked_at` and KEEPS THE ROW, so the record of who minted what, and when it
-- stopped working, outlives the key. A capability called `delete` would name
-- something the panel does not do.
--
-- ------------------------------------------------------------
-- WHERE THEY SIT RELATIVE TO THE BASELINES
-- ------------------------------------------------------------
-- IN NO BASELINE, ASSIGNABLE TO NOBODY. Not in EXEC_BASELINE, not in
-- EXEC_ASSIGNABLE, in none of the four ROLE_DEFAULTS and NOT IN
-- EDITOR_OFFERABLE. An admin holds them by level, the way an admin holds
-- everything; no grant, no custom baseline and no VP role can reach them.
--
-- AND THAT IS A REVERSAL, recorded here rather than left to the diff. The
-- capabilities were first written to be exec-assignable, on the stated wish
-- that execs run the API's keys. They are admin-only instead, because of what a
-- key IS. Every other capability in these lists acts INSIDE the console, where
-- the actor is a session, the act is one audit row, and taking the grant away
-- takes the access away. A minted key is none of those things: it reads the
-- club's roster and ratings from outside every gate in access-level.ts, with no
-- session behind it and no audit row per read, and it keeps answering after the
-- person who minted it has lost their console entirely. Manufacturing access
-- that outlives the grant is the one act on this list that a grant cannot bound,
-- which is the posture `players.merge.write` and `players.remove.write` already
-- have. Widening it is two lines in access-level.ts and its own reviewable diff.
--
-- ADMITTED BY THESE CHECKS ANYWAY, which is not a contradiction. A CHECK
-- decides whether a string is SPELLABLE in a stored array. Whether it may be
-- stored is decided in TypeScript, by check 5 of setPlayerPermissions and by
-- baselineCapabilityRefusal(). `permissions.write` has sat in both these lists
-- since 00087 on exactly that footing: in the vocabulary, offerable to nobody.
-- Letting the lists diverge here to express a rule that is enforced above them
-- would put a second, weaker copy of that rule in SQL.
--
-- ------------------------------------------------------------
-- PURELY ADDITIVE
-- ------------------------------------------------------------
-- Nothing is removed and nothing is renamed, so no stored array is rewritten.
-- An unknown string in a stored `grants` array is harmless, since the resolver
-- drops it, but a capability deleted from the code while a stored REVOKE still
-- names it is a revoke that silently stops biting, and that is the one way this
-- model can widen somebody by accident. The same claim 00089, 00097, 00098,
-- 00105, 00223 and 00232 made, held by the same chained test in
-- capability-storage.test.ts.
--
-- NOBODY'S ACCESS CHANGES WHEN THIS IS APPLIED. No row is written. The three
-- strings are in no baseline, in no ROLE_DEFAULTS and in no grant, so no
-- existing person resolves to any of them.
--
-- NO TABLE, FUNCTION OR COLUMN IS CREATED HERE, so there is no BEGIN/COMMIT:
-- two ALTERs that each drop and re-add one CHECK, exactly as 00232 shipped.
-- ============================================================

-- 1. THE PLAYER COLUMNS ----------------------------------------------------
--
-- Dropped by name and re-added, never edited in place: 00232 is recorded as
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
    'accounts.page', 'accounts.apikey.read', 'accounts.apikey.mint.write',
    'accounts.apikey.revoke.write', 'platform.page', 'platform.settings.write'
    ]::TEXT[]
  );

-- 2. THE BASELINES TABLE ---------------------------------------------------
--
-- The second copy of the same list (00093). Two copies in SQL can drift, and
-- the direction this one drifts in is a baseline storing a string the code
-- does not know and therefore handing out nothing. Pinned against the same
-- array, and against each other, by capability-storage.test.ts.
--
-- ADMITTED HERE TOO, even though EDITOR_OFFERABLE contains none of the three
-- and so no baseline can legitimately carry them. This CHECK only decides
-- whether a string is SPELLABLE; baselineCapabilityRefusal() is what decides
-- whether it may be stored. Keeping the two lists identical is what the test
-- pins, and letting them diverge here to express a rule that is enforced in
-- TypeScript would put a second, weaker copy of that rule in SQL.
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
    'accounts.apikey.revoke.write', 'platform.page', 'platform.settings.write'
    ]::TEXT[]
  );

-- A CHECK constraint is not in the schema cache, but the tables it sits on are,
-- and a reload costs nothing. Consistent with every other migration here.
NOTIFY pgrst, 'reload schema';
