-- ============================================================
-- 00243 THE VOCABULARY LEARNS THE KEYS TO SWITCHED-OFF PAGES
--
-- WHAT IS ADDED: seven strings, one per club feature switch, taking the
-- vocabulary from 124 to 131:
--
--   page.access.sessions       page.access.challenges    page.access.tournaments
--   page.access.leaderboard    page.access.my_stats      page.access.announcements
--   page.access.fees
--
-- WHAT THEY ARE. The club can switch a member-facing feature off (the
-- `features` row in platform_settings). Until now anybody with console access
-- could still open a switched-off feature under a banner. The club owner asked
-- for "a permission node for access to a restricted page" instead, so each
-- feature has its own key and letting somebody into tournaments before they go
-- live no longer lets them into challenges as well. An admin holds every key by
-- level; anybody else is granted one on /permissions.
--
-- THE NAMES ARE THE OWNER'S, and they break the vocabulary's grammar on
-- purpose: they end in the feature id rather than in page/read/write, and the
-- id is used verbatim, so one carries an underscore. capabilities.test.ts
-- states both exceptions for the `page` area alone. None of that matters to
-- SQL, which only checks that a stored string is one of the list.
--
-- WHY IT IS A MIGRATION AT ALL. The two CHECKs below enumerate every valid
-- capability string, on players.permission_grants / permission_revokes and on
-- permission_baselines.capabilities. A string they do not know is a string the
-- database REFUSES, so without this every grant of one of these keys fails on
-- save. 00238 is the last file to have moved these lists; this one supersedes
-- it, and each list below is 00238's copied verbatim with the seven appended.
--
-- ------------------------------------------------------------
-- WHERE THEY SIT RELATIVE TO THE BASELINES
-- ------------------------------------------------------------
-- IN NO BASELINE. Not in EXEC_BASELINE or TRAINER_BASELINE, not in
-- EXEC_ASSIGNABLE and in none of the four ROLE_DEFAULTS: switched off means
-- off, and access is handed to one person at a time. They ARE in
-- EDITOR_OFFERABLE (through OFFERABLE_BEYOND_EXEC), which is what lets an admin
-- grant one on /permissions at all.
--
-- ------------------------------------------------------------
-- PURELY ADDITIVE, AND SAFE IN EITHER ORDER WITH THE CODE
-- ------------------------------------------------------------
-- Nothing is removed and nothing is renamed, so no stored array is rewritten;
-- the chained test in capability-storage.test.ts holds this file to that.
--
-- NOBODY'S ACCESS CHANGES WHEN THIS IS APPLIED. No row is written. Code that
-- ships BEFORE it is applied still works: an admin holds the keys by level,
-- nobody else can be granted one until the CHECK admits it, and a member
-- without one is simply kept out of a switched-off feature.
--
-- ONE TRANSACTION, so the two lists cannot end up disagreeing, with a check
-- at the end that both admit the new strings before it commits.
-- ============================================================

BEGIN;

-- 1. THE PLAYER COLUMNS ----------------------------------------------------
--
-- Dropped by name and re-added, never edited in place: 00238 is recorded as
-- applied, so an in-place edit there would never re-run. The predicate is
-- 00089's, unchanged.
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
    'page.access.fees'
    ]::TEXT[]
  );

-- 2. THE BASELINES TABLE ---------------------------------------------------
--
-- The second copy of the same list (00093), pinned against the first by
-- capability-storage.test.ts. A custom baseline may carry these keys, since
-- they are offerable, so this copy has to admit them as well.
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
    'page.access.fees'
    ]::TEXT[]
  );

-- 3. VERIFY ------------------------------------------------------------------
--
-- Both constraints exist and both admit every new key. Read back from the
-- catalogue rather than trusted from the statements above.
DO $verify$
DECLARE
  v_key TEXT;
  v_def TEXT;
BEGIN
  FOR v_def IN
    SELECT pg_get_constraintdef(c.oid)
    FROM pg_constraint c
    WHERE c.conname IN (
      'players_permission_vocabulary_check',
      'permission_baselines_vocabulary_check'
    )
  LOOP
    FOREACH v_key IN ARRAY ARRAY[
      'page.access.sessions', 'page.access.challenges', 'page.access.tournaments',
      'page.access.leaderboard', 'page.access.my_stats', 'page.access.announcements',
      'page.access.fees'
    ]::TEXT[] LOOP
      IF position(quote_literal(v_key) IN v_def) = 0 THEN
        RAISE EXCEPTION '00243: a vocabulary CHECK does not admit %', v_key;
      END IF;
    END LOOP;
  END LOOP;

  IF (
    SELECT count(*) FROM pg_constraint
    WHERE conname IN (
      'players_permission_vocabulary_check',
      'permission_baselines_vocabulary_check'
    )
  ) <> 2 THEN
    RAISE EXCEPTION '00243: expected both vocabulary CHECKs to exist';
  END IF;
END
$verify$;

COMMIT;

-- A CHECK constraint is not in the schema cache, but the tables it sits on are,
-- and a reload costs nothing. Consistent with every other migration here.
NOTIFY pgrst, 'reload schema';
