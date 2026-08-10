-- ============================================================
-- 00089 — the roster is DATA, and it now has a capability of its own
--
-- 00088 gave every area a `.page` and left `<area>.<resource>.read` gating
-- individual fetches. /fees came out of that with five reads; /players came out
-- with none, because its roster query was never gated at all — it simply
-- rendered for anybody who could open the section. So the one thing the club
-- owner actually asked for ("let somebody add a member without browsing the
-- roster") was impossible on the one page they most wanted it on.
--
-- `players.read` closes that. It gates the roster FETCH — the list on /players,
-- the member record behind /players/<id>, and the Active Players count on the
-- dashboard — and never the section, which is still `players.page`.
--
-- THE STRING `players.read` HAS EXISTED BEFORE AND MEANT SOMETHING ELSE. 00087
-- pinned it meaning "may open the roster"; 00088 renamed every stored
-- occurrence of it to `players.page` and dropped it from the vocabulary. It
-- comes back here meaning "may see the roster data". That is safe only because
-- 00088's rewrite already ran ahead of this file and no row has ever been
-- narrowed — a stored `players.read` surviving from 00087 would silently change
-- meaning, and it cannot, because there is none left to survive.
--
-- ONE JOB, SO TWO OF 00088's THREE STEPS. The ordering rule it wrote down —
-- DROP, then UPDATE, then ADD — was forced by a RENAME: the rewrite can only
-- run in the window where neither constraint is active, because a CHECK is
-- re-validated on every UPDATE and neither the old list nor the new one contains
-- both spellings.
--
-- THERE IS NO UPDATE STEP HERE, AND IT IS NOT NEEDED. This change is purely
-- ADDITIVE: every string 00088 pinned is still pinned below, so no stored
-- element can stop naming a capability the code has, and the hazard the rewrite
-- exists for — a revoke going silently inert — has nothing to bite on. A rewrite
-- would be a statement matching no rows on any list of names. The DROP is still
-- required, because a constraint is replaced rather than edited.
--
-- NOTHING CHANGES FOR ANYONE. `players.read` is in EXEC_BASELINE (70 → 71), in
-- TRAINER_BASELINE (2 → 3, and a varsity trainer reads the roster today and must
-- keep doing so) and in ROLE_DEFAULTS.internal, which is the role that owns the
-- roster. Pinned by the capability-equivalence table, where no pre-existing
-- row's admin/exec/trainer answer moved and the new row reads T/T/T because the
-- fetch it gates was reached by every level that could open the section.
-- ============================================================

-- 1. THE OLD CONSTRAINT, OUT OF THE WAY -----------------------------------
--
-- Dropped by name rather than edited in place in 00088, for the same reason
-- 00088 was not edited into 00087: staging has 00088 recorded as applied, so an
-- in-place edit would never re-run there and the two databases would diverge.
ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_permission_vocabulary_check;

-- 2. THE VOCABULARY, RE-PINNED --------------------------------------------
--
-- All 116 — 00088's 115 with `players.read` added, and nothing removed. The
-- reasoning for having this constraint at all is unchanged and is written out in
-- 00087: it is here for the REVOKES, and what it really buys is that REMOVING A
-- CAPABILITY IS A MIGRATION.
ALTER TABLE public.players ADD CONSTRAINT players_permission_vocabulary_check
  CHECK (
    (permission_grants || permission_revokes) <@ ARRAY[
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

-- Nothing else from 00087 or 00088 moves. The role list, the not-null and
-- disjointness CHECKs, the deltas-need-a-role CHECK,
-- guard_player_privileged_columns() and admin_console_access() are all
-- unchanged — this migration touches the vocabulary and nothing else.
--
-- No NOTIFY here: no column, function or signature changed, so PostgREST's
-- cached schema is still correct.
