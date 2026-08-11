-- ============================================================
-- 00098_event_entry_cap.sql — a tournament may limit how many of
-- its events any one member enters
-- ============================================================
-- "we would be trying to limit people allowing x amount of event allowed"
-- — the club owner. A tournament runs several events (singles, doubles,
-- mixed). One strong player entering every one of them crowds out the rest of
-- the club and, at a club this size, decides the whole tournament.
--
-- This is `tournament_events.max_participants` one level up. That column caps a
-- single event's FIELD; this one caps one PERSON across the tournament. The
-- third member of the family is `platform_settings.session_caps`, which caps
-- rated matches per player per session — same idea, different unit.
--
-- ------------------------------------------------------------
-- NULL IS UNCAPPED, AND NULL IS THE DEFAULT
-- ------------------------------------------------------------
-- Every tournament that exists today keeps behaving exactly as it does now, and
-- a tournament created without touching the field is uncapped. A default of any
-- number would silently impose a rule on tournaments nobody set it for --
-- including tournaments already open for registration when this is applied.
--
-- The CHECK refuses zero and below. A cap of zero is "nobody may enter
-- anything", which is what closing registration is for; if it were storable,
-- every entry path in both apps would have to distinguish it from NULL, and the
-- first one that got it wrong would bar an entire tournament. It is not
-- storable, so they do not have to.

ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS max_events_per_player INTEGER;

ALTER TABLE public.tournaments
  DROP CONSTRAINT IF EXISTS tournaments_max_events_per_player_positive;
ALTER TABLE public.tournaments
  ADD CONSTRAINT tournaments_max_events_per_player_positive
  CHECK (max_events_per_player IS NULL OR max_events_per_player > 0);

COMMENT ON COLUMN public.tournaments.max_events_per_player IS
  'How many of this tournament''s events one member may enter. NULL means uncapped, which is the default. Counted as tournament_participants rows plus tournament_pairs rows where the member is EITHER half, both joined through tournament_events, both excluding status IN (''withdrawn'',''disqualified'') so that leaving an event gives the slot back. The single implementation of that count is packages/shared/src/utils/tournament-entry-cap.ts; it is enforced in all four entry paths (admin add-one, add-many, add-pair, and the player app''s own registration).';

-- ------------------------------------------------------------
-- WHY THERE IS NO DATABASE-LEVEL ENFORCEMENT OF THE CAP
-- ------------------------------------------------------------
-- The obvious-looking version is a trigger on tournament_participants and
-- tournament_pairs that counts and raises. It is not here, deliberately:
--
--   * The count spans two tables, so each trigger would have to read the other
--     one, and two triggers racing on the same tournament can each see a count
--     that the other is about to increment. Getting that right means locking
--     the tournament row on every entry -- serialising registration for a
--     problem that a UNIQUE index does not solve because there is no single
--     column to be unique on.
--   * A raised exception reaches the apps as an opaque SQLSTATE, and this
--     refusal has to NAME THE PERSON at fault -- especially for a pair, where
--     "at the cap" without a name tells the exec the team is broken but not
--     which half to speak to.
--
-- So the cap is an application rule, like max_participants and
-- allowed_memberships before it, and the column carries the number. The CHECK
-- above is the only invariant the database owns: the number itself is sane.

-- ============================================================
-- THE LEGACY PARTICIPANT TABLE — CORRECTING WHAT IT CLAIMS
-- ============================================================
-- 00001_schema.sql said legacy_tournament_participants was "still read/written
-- by the admin app's legacy tournament management". That stopped being true.
--
-- The action that INSERTED into it (addTournamentParticipant) is deleted in the
-- same change as this migration: it was reached only from AddParticipantForm,
-- a dialog nothing imported and nothing rendered, and it wrote a row shape
-- ({tournament_id, player_id, partner_id, seed}) that the event-based system
-- has no place for. Worse, it was a way into a tournament that went round the
-- event-waiver enforcement 00097 added, so it was a live hole rather than
-- clutter. Its own fallback -- "if the legacy insert fails, insert the same
-- object into tournament_participants" -- could never have worked: that table
-- has neither a tournament_id nor a partner_id column.
--
-- THE TABLE ITSELF IS DELIBERATELY NOT DROPPED. It is empty on staging, but
-- staging is a synthetic reload and production carries real tournament history
-- from before the event system. Dropping it would be dropping that history on
-- the strength of a count taken somewhere else.
--
-- THE SEPARATE DECISION THIS PARAGRAPH LEFT OPEN HAS SINCE BEEN TAKEN. It said
-- only removing the last of the fallback -- removeTournamentParticipant, which
-- still DELETEd from this table -- would make "nothing touches this table"
-- true. That action has now been deleted too, in the change that also deleted
-- the participants dialog which was its only caller. So the sentence is now
-- simply true: no application code reads or writes this table. It is reachable
-- only through merge_players(), which rewrites its player_id and partner_id
-- (00026, then 00079 and 00095) and which is the reason the rows must survive.
COMMENT ON TABLE public.legacy_tournament_participants IS
  'Pre-event-system participant table, originally named tournament_participants and renamed when the event-based system (tournament_events / tournament_participants / tournament_pairs) replaced it. RETAINED FOR HISTORY ONLY: as of 00098 nothing in either app inserts into it. Retained rather than dropped because production may hold real pre-event-system tournament history; check before removing.';

-- ============================================================
-- THE CAPABILITY VOCABULARY — 117 BECOMES 118
-- ============================================================
-- The cap is useless to the exec doing the adding unless the tournament screen
-- says who is already at it -- a refusal nobody can see coming reads as a bug,
-- and the exec's next move is to go looking for a way round it. That display is
-- a fetch of tournament_participants and tournament_pairs folded into a
-- per-player count, and nothing computed it before, so it gets its own
-- capability: `tournaments.draw.entrycounts.read`.
--
-- Same two constraints as 00097, for the same reason: the vocabulary is written
-- down three times -- once in code (packages/shared/src/utils/access-level.ts)
-- and once in each CHECK below -- and capability-storage.test.ts reads both of
-- these as text and asserts each against CAPABILITIES, so they cannot drift.
--
-- Both lists below were GENERATED from CAPABILITIES rather than typed, which is
-- the only way 118 strings get copied without a silent transposition.
--
-- PURELY ADDITIVE -- nothing is removed. An unknown string in a stored `grants`
-- array is harmless (the resolver drops it), but a capability deleted from the
-- code while a stored REVOKE still names it is a revoke that silently stops
-- biting. No rename here, therefore no rewrite of any stored array -- the same
-- claim 00089 and 00097 made, held by the same chained test.

-- Dropped by name and re-added, never edited in place: staging has 00089, 00093
-- and 00097 recorded as applied, so an in-place edit would never re-run there
-- and the two databases would diverge. The predicate is 00089's, unchanged.

ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_permission_vocabulary_check;
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
    'tournaments.draw.unlock.write', 'tournaments.draw.waivers.read', 'tournaments.draw.entrycounts.read',
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
    'tournaments.draw.unlock.write', 'tournaments.draw.waivers.read', 'tournaments.draw.entrycounts.read',
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

-- NOT RE-REPLACED HERE: guard_player_privileged_columns. 00093 owns the live
-- definition and capability-storage.test.ts reads it from that file. Copying it
-- forward for no reason would be one more place a guarded column can be dropped
-- by accident, which is the failure that test exists to catch.
