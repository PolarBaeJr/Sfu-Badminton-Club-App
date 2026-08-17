'use server';

// ---------------------------------------------------------------------------
// RUNNING THE DESK — the two things an exec does to a match that are not a
// result: telling both sides which court to go to, and recording that somebody
// is standing in front of them.
//
// A DOMAIN FILE OF ITS OWN rather than three more exports in results.ts. Neither
// of these touches a score, a rating, an advancement or a standing, which is
// what every function in that file is about; and both happen at a point in the
// event where results.ts's guards (assertEventResultsMutable, the
// completed/walkover refusals) would be answering a different question. The
// barrel re-exports it beside the rest — see ../tournament-actions.ts.
// ---------------------------------------------------------------------------

import * as Sentry from '@sentry/nextjs';
import { ExpectedError } from '@badminton/shared';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { runAction, type ActionResult } from '../action-result';
import {
  requireCapability,
  revalidateEventPaths,
  assertTournamentNotSuspended,
} from './_internal';

/**
 * The same length the database enforces (00135's tournament_matches_court_len).
 *
 * TRIMMED AND CHECKED HERE TOO, and not because the CHECK might fail — it is
 * NOT VALID, so it binds this write and would refuse it. It is checked here so
 * the refusal is a sentence an exec can act on instead of a raw Postgres
 * constraint name, which is the whole point of the ExpectedError channel.
 */
const COURT_MAX = 32;

/**
 * WHICH COURT THIS MATCH IS ON.
 *
 * "give us a location setter ... so we can tell them where to play through the
 * app" — the club owner. The member's phone learns it over the Realtime channel
 * both apps already hold open on tournament_matches (00113), so this action's
 * whole job is the write and the audit trail.
 *
 * FREE TEXT, deliberately — see 00135 for the argument against modelling venues
 * and courts that nobody has asked for. Empty string clears it back to NULL,
 * which the player app renders as "Court TBC" rather than as a blank, because
 * "not assigned yet" is a real state at a live event and has to look like one.
 */
export async function setMatchCourt(matchId: string, court: string): Promise<ActionResult<void>> {
  return runAction(async () => { await setMatchCourtImpl(matchId, court); });
}

async function setMatchCourtImpl(matchId: string, court: string) {
  const admin = await requireCapability('tournaments.draw.checkin.mark.write');
  const adminClient = createAdminClient();

  const trimmed = court.trim();
  if (trimmed.length > COURT_MAX) {
    throw new ExpectedError(`A court label is at most ${COURT_MAX} characters — this is a place to walk to, not a note.`);
  }

  const { data: match } = await adminClient
    .from('tournament_matches')
    .select('id, court, event_id, event:tournament_events(tournament_id)')
    .eq('id', matchId)
    .maybeSingle();
  if (!match) throw new ExpectedError('Match not found');

  const event = match.event as { tournament_id?: string } | Array<{ tournament_id?: string }> | null;
  const tournamentId = (Array.isArray(event) ? event[0]?.tournament_id : event?.tournament_id) ?? null;
  if (!tournamentId) throw new Error('Match is not attached to a tournament');

  // A suspended tournament is not being played, so nobody should be directed
  // anywhere. This is the plain case for the suspension gate — unlike void /
  // undo / edit, which skip it precisely because they are how a suspended
  // tournament gets repaired.
  await assertTournamentNotSuspended(adminClient, tournamentId);

  const previous = (match.court as string | null) ?? null;
  const next = trimmed === '' ? null : trimmed;
  // Nothing to say, and nothing to wake twenty phones for: a no-op write would
  // still hit the WAL and nudge every subscriber of this event.
  if (previous === next) return;

  const { error } = await adminClient
    .from('tournament_matches')
    .update({ court: next, updated_at: new Date().toISOString() })
    .eq('id', matchId);
  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  // AUDITED INCLUDING THE PREVIOUS VALUE. A court that changes mid-event is the
  // case that strands somebody at the wrong net, so "who moved it, and from
  // what" is the question that gets asked afterwards.
  await logAudit(adminClient, {
    tournament_id: tournamentId,
    event_id: match.event_id as string,
    match_id: matchId,
    action: next === null ? 'match_court_cleared' : 'match_court_set',
    performed_by: admin.id,
    details: { previous_court: previous, court: next },
  });

  revalidateEventPaths(tournamentId, match.event_id as string);
}

/**
 * THE DESK MARKING SOMEBODY PRESENT — "they are standing right here and they
 * have not touched their phone."
 *
 * GATED ON tournaments.draw.checkin.mark.write, which is the key that already
 * says "you may record that this person has turned up". No new capability: this
 * is that act at match granularity instead of event granularity, and the same
 * person at the same table does both.
 *
 * AUDITED, unlike the member's own tap (apps/player/src/lib/tournament-actions.ts
 * setMyMatchReady). One person asserting something about another is exactly the
 * distinction tournament_audit_log exists to record; a member toggling their own
 * flag on a busy Saturday would write a few hundred rows saying nothing.
 */
export async function setMatchReadyForPlayer(
  matchId: string,
  playerId: string,
  ready: boolean,
): Promise<ActionResult<void>> {
  return runAction(async () => { await setMatchReadyForPlayerImpl(matchId, playerId, ready); });
}

async function setMatchReadyForPlayerImpl(matchId: string, playerId: string, ready: boolean) {
  const admin = await requireCapability('tournaments.draw.checkin.mark.write');
  const adminClient = createAdminClient();

  const { data: match } = await adminClient
    .from('tournament_matches')
    .select('id, event_id, event:tournament_events(tournament_id)')
    .eq('id', matchId)
    .maybeSingle();
  if (!match) throw new ExpectedError('Match not found');

  const event = match.event as { tournament_id?: string } | Array<{ tournament_id?: string }> | null;
  const tournamentId = (Array.isArray(event) ? event[0]?.tournament_id : event?.tournament_id) ?? null;
  if (!tournamentId) throw new Error('Match is not attached to a tournament');
  await assertTournamentNotSuspended(adminClient, tournamentId);

  // The RPC, not an .update(): it is the only writer of this column and it holds
  // the row lock across the read and the write, so a member tapping their own
  // control at the same instant cannot be erased by the desk's write. It also
  // re-checks that the player is actually in this match — an invariant that has
  // to be in the database, because a stray id in that array is data nobody can
  // see in order to fix. See 00135.
  const { error } = await adminClient.rpc('set_match_ready', {
    p_match_id: matchId,
    p_player_id: playerId,
    p_ready: ready,
  });
  if (error) {
    Sentry.captureException(error);
    throw new ExpectedError(error.message);
  }

  await logAudit(adminClient, {
    tournament_id: tournamentId,
    event_id: match.event_id as string,
    match_id: matchId,
    action: ready ? 'match_ready_marked' : 'match_ready_cleared',
    performed_by: admin.id,
    details: { player_id: playerId },
  });

  revalidateEventPaths(tournamentId, match.event_id as string);
}
