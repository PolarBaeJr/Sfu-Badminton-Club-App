-- ============================================================
-- 00097_forced_event_waiver.sql — an exec can still add anybody
-- to a tournament, but nobody plays without having signed
-- ============================================================
-- THE GAP THIS CLOSES. A member who enters a tournament themselves goes through
-- registerForEvent (apps/player), which will not proceed without the event
-- waiver and records the acceptance in event_waiver_acceptances (00015), keyed
-- to a SHA-256 hash of the exact wording shown. A member an EXEC adds —
-- addParticipantToEvent, addParticipantsToEvent, addPairToEvent (apps/admin) —
-- went through none of that. Same tournament, same contact sport, no signature
-- and nothing on any screen saying so.
--
-- The club owner's rule is permissive at entry, strict at participation:
-- adding somebody must keep working (the walk-up on the day is real), but an
-- entrant with no current acceptance must not be able to take part. So the
-- enforcement point is CHECK-IN, not the add.
--
-- ------------------------------------------------------------
-- WHY THIS MIGRATION IS ADDITIVE ONLY
-- ------------------------------------------------------------
-- event_waiver_acceptances is NOT touched beyond an index. It keeps exactly the
-- shape 00015 gave it — insert-only evidence, unique on
-- (player_id, tournament_id, waiver_hash), no UPDATE and no DELETE policy.
--
-- In particular there is deliberately NO "signed_by" or "recorded_by" column.
-- The obvious-looking version of "let an exec sign somebody in at the door" is
-- an admin action that inserts a row on the member's behalf, and a row that
-- looks like a signature but is an officer's assertion is WORSE than no row:
-- it launders the liability it was supposed to record. No column makes that
-- safe — a service-role writer fills in whatever it likes — so the guarantee is
-- structural instead. The only code in this repo that writes this table runs
-- behind requirePlayer() in the PLAYER app, against the member's own session
-- cookie, and a test pins that the set of writers is exactly those paths. An
-- officer's claim that they handed somebody a tablet is an audit fact and goes
-- to tournament_audit_log, where officer claims belong.
--
-- ------------------------------------------------------------
-- THE INDEX
-- ------------------------------------------------------------
-- 00015 indexed (player_id, tournament_id) — the right order for "has THIS
-- member signed", which was the only question anybody asked while the table was
-- write-only. The roster and the check-in board ask the other question: "who in
-- THIS tournament has signed", for a whole draw at once. That has the wrong
-- leading column, so it gets its own index rather than a sequential scan per
-- page load on a table that grows once per entrant per tournament.
CREATE INDEX IF NOT EXISTS idx_ewa_tournament_player
  ON event_waiver_acceptances(tournament_id, player_id);

COMMENT ON TABLE event_waiver_acceptances IS
  'Immutable evidence that a member accepted a tournament''s event waiver, pinned to a hash of the exact text they saw. Written ONLY by the player app behind the member''s own session — never by an admin action on their behalf. Read at check-in, which refuses an entrant with no row matching the tournament''s current waiver_text.';

-- ============================================================
-- THE CAPABILITY VOCABULARY — 116 BECOMES 117
-- ============================================================
-- The check-in refusal is useless to the officer at the door unless the roster
-- says WHO is unsigned, and that is a fetch of event_waiver_acceptances that
-- nothing did before. Every new fetch gets its own capability, so it is gated
-- on `tournaments.draw.waivers.read`.
--
-- A new capability is TWO constraints, in one migration, because the vocabulary
-- is written down three times: once in code (packages/shared/access-level.ts)
-- and once in each of these CHECKs. capability-storage.test.ts reads both of
-- them as text and asserts each against CAPABILITIES, so they cannot drift.
--
-- Both lists below were GENERATED from CAPABILITIES rather than typed, which is
-- the only way 117 strings get copied without a silent transposition.
--
-- PURELY ADDITIVE — nothing is removed. That matters: an unknown string in a
-- stored `grants` array is harmless (the resolver drops it), but a capability
-- deleted from the code while a stored REVOKE still names it is a revoke that
-- silently stops biting. There is no rename here and therefore no rewrite of
-- any stored array, which is the same claim 00089 made and the same test holds
-- it to.

ALTER TABLE public.players
  DROP CONSTRAINT IF EXISTS players_permission_vocabulary_check;
ALTER TABLE public.players
  ADD CONSTRAINT players_permission_vocabulary_check
  CHECK (
    permission_grants <@ ARRAY[
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
    'tournaments.draw.unlock.write', 'tournaments.draw.waivers.read', 'tournaments.results.enter.write',
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
    AND permission_revokes <@ ARRAY[
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
    'tournaments.draw.unlock.write', 'tournaments.draw.waivers.read', 'tournaments.results.enter.write',
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
    'tournaments.draw.unlock.write', 'tournaments.draw.waivers.read', 'tournaments.results.enter.write',
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

-- NOT RE-REPLACED HERE: guard_player_privileged_columns. 00093 owns the live
-- definition and capability-storage.test.ts reads it from that file. Copying it
-- forward for no reason would be one more place a guarded column can be dropped
-- by accident, which is the failure that test exists to catch.
