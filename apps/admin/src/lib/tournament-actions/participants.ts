'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { calculateTeamRating, isDoublesEvent, eventHasDraw, ExpectedError } from '@badminton/shared';
import { runAction, type ActionResult } from '../action-result';
import {
  getExecOrAdmin,
  revalidateEventPaths,
  extractEventContext,
  participantContextSelect,
  pairContextSelect,
  assertTournamentNotSuspended,
  forfeitOpenMatchesForEntry,
  FORFEIT_REASON,
  type DrawExitStatus,
} from './_internal';

// ============================================================
// Singles Participant Management
// ============================================================

export async function addParticipantToEvent(eventId: string, playerId: string) {
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.status !== 'registration' && event.status !== 'checkin') {
    throw new Error('Cannot add participants in current status');
  }
  if (event.draw_locked) throw new Error('Draw is locked. Unlock it before making changes.');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  if (isDoublesEvent(event.event_type)) {
    throw new Error('Use addPairToEvent for doubles events');
  }

  // Check max participants
  if (event.max_participants) {
    const { count } = await adminClient.from('tournament_participants')
      .select('*', { count: 'exact', head: true })
      .eq('event_id', eventId)
      .not('status', 'eq', 'withdrawn');
    if (count && count >= event.max_participants) {
      throw new Error('Event is full');
    }
  }

  // Get or create player's ratings record
  let { data: rating } = await adminClient.from('ratings').select('singles_elo').eq('player_id', playerId).maybeSingle();
  if (!rating) {
    // Player has no ratings record — create one with defaults
    const { data: newRating } = await adminClient.from('ratings').insert({
      player_id: playerId,
      singles_elo: 400,
      doubles_elo: 400,
      singles_provisional: true,
      doubles_provisional: true,
      singles_k_factor: 40,
      doubles_k_factor: 40,
    }).select('singles_elo').single();
    rating = newRating;
  }

  const { data, error } = await adminClient.from('tournament_participants').insert({
    event_id: eventId,
    player_id: playerId,
    elo_before: rating?.singles_elo ?? 400,
    added_by: admin.id,
  }).select().single();

  if (error) {
    if (error.code === '23505') throw new Error('Player already registered for this event');
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'participant_added',
    performed_by: admin.id,
    details: { player_id: playerId },
  });

  revalidateEventPaths(event.tournament_id, eventId);
  return data;
}

/** What the batch add reports back, per player, for the ones it could not take. */
export interface BatchAddFailure {
  id: string;
  message: string;
}

/**
 * Add a whole selection of players in ONE request.
 *
 * Why this exists rather than looping addParticipantToEvent: the loop was
 * sequential, and each pass paid for a full server action — authenticate, read
 * the event, check the tournament, read a rating, insert, write an audit row —
 * and then called revalidatePath, which makes the App Router re-render the event
 * page and ship the new RSC tree back in the response. Sixty players meant sixty
 * round trips to the Pi and sixty renders of a page that queries every
 * participant, pair and match in the event. Seeding a 128-slot draw took long
 * enough to look broken.
 *
 * Everything that does not depend on WHICH player is now done once, the inserts
 * go in a single statement, and the page is revalidated once at the end.
 *
 * The per-player action stays: it is still the honest shape for adding one
 * person, and other callers use it.
 */
export async function addParticipantsToEvent(eventId: string, playerIds: string[]) {
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  // Deduplicate but KEEP the caller's order. Order is not cosmetic here: when
  // the event fills mid-batch, the people who get in are the first ones the exec
  // picked, which is the same answer the sequential loop gave.
  const ids = [...new Set(playerIds)];
  if (ids.length === 0) return { added: [] as string[], failures: [] as BatchAddFailure[] };

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.status !== 'registration' && event.status !== 'checkin') {
    throw new Error('Cannot add participants in current status');
  }
  if (event.draw_locked) throw new Error('Draw is locked. Unlock it before making changes.');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  if (isDoublesEvent(event.event_type)) {
    throw new Error('Use addPairToEvent for doubles events');
  }

  const failures: BatchAddFailure[] = [];

  // Already registered, in one read. The per-player path leaned on the unique
  // violation (23505) coming back from its own insert, which cannot work for a
  // batch: one duplicate would fail the whole statement and take 59 innocent
  // rows with it. The unique index still guards the race — see below — this
  // read is what turns the common case into a per-player message.
  const { data: existing } = await adminClient
    .from('tournament_participants')
    .select('player_id')
    .eq('event_id', eventId)
    .in('player_id', ids);
  const alreadyIn = new Set((existing ?? []).map((r) => r.player_id as string));

  let candidates = ids.filter((id) => {
    if (alreadyIn.has(id)) {
      failures.push({ id, message: 'Player already registered for this event' });
      return false;
    }
    return true;
  });

  // Capacity, counted once against the WHOLE batch rather than re-read per
  // player. Everyone past the line is refused with the same sentence the
  // sequential path used, so a partial add still reads the same way.
  if (event.max_participants) {
    const { count } = await adminClient.from('tournament_participants')
      .select('*', { count: 'exact', head: true })
      .eq('event_id', eventId)
      .not('status', 'eq', 'withdrawn');
    const room = Math.max(event.max_participants - (count ?? 0), 0);
    if (candidates.length > room) {
      for (const id of candidates.slice(room)) failures.push({ id, message: 'Event is full' });
      candidates = candidates.slice(0, room);
    }
  }

  if (candidates.length === 0) return { added: [], failures };

  // elo_before is stamped at registration, so every candidate needs a rating.
  const { data: ratingRows } = await adminClient
    .from('ratings')
    .select('player_id, singles_elo')
    .in('player_id', candidates);
  const eloByPlayer = new Map<string, number>(
    (ratingRows ?? []).map((r) => [r.player_id as string, r.singles_elo as number]),
  );

  // Same defaults as the single-player path, deliberately including the k_factor
  // values that differ from the column defaults — this is a copy of existing
  // behaviour, not a place to correct it.
  const missing = candidates.filter((id) => !eloByPlayer.has(id));
  if (missing.length > 0) {
    const { data: created } = await adminClient.from('ratings').insert(
      missing.map((id) => ({
        player_id: id,
        singles_elo: 400,
        doubles_elo: 400,
        singles_provisional: true,
        doubles_provisional: true,
        singles_k_factor: 40,
        doubles_k_factor: 40,
      })),
    ).select('player_id, singles_elo');
    for (const r of created ?? []) eloByPlayer.set(r.player_id as string, r.singles_elo as number);
  }

  const { data: inserted, error } = await adminClient.from('tournament_participants').insert(
    candidates.map((id) => ({
      event_id: eventId,
      player_id: id,
      elo_before: eloByPlayer.get(id) ?? 400,
      added_by: admin.id,
    })),
  ).select();

  if (error) {
    // A duplicate here means somebody else registered one of these players
    // between the read above and this insert. Nothing landed, so say so plainly
    // rather than reporting a partial success that did not happen.
    if (error.code === '23505') {
      throw new ExpectedError(
        'Someone was registered while this was being submitted, so nothing was added. Try again.',
      );
    }
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  const added = (inserted ?? []).map((r) => r.player_id as string);

  // One row per player, same shape as the single-player path writes, in one
  // statement. Collapsing the batch into a single row with a list would change
  // what `details.player_id` means for everything that reads this table.
  if (added.length > 0) {
    await adminClient.from('tournament_audit_log').insert(
      added.map((id) => ({
        tournament_id: event.tournament_id,
        event_id: eventId,
        match_id: null,
        action: 'participant_added',
        performed_by: admin.id,
        details: { player_id: id },
      })),
    );
  }

  revalidateEventPaths(event.tournament_id, eventId);
  return { added, failures };
}

export async function removeParticipantFromEvent(participantId: string) {
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { data: participant } = await adminClient.from('tournament_participants')
    .select('*, event:tournament_events(*)')
    .eq('id', participantId)
    .single();
  if (!participant) throw new Error('Participant not found');

  const event = participant.event as Record<string, unknown>;
  if (event.status !== 'registration') {
    throw new Error('Cannot remove participants after registration closes');
  }
  if (event.draw_locked) throw new Error('Draw is locked. Unlock it before making changes.');

  const { error } = await adminClient.from('tournament_participants').delete().eq('id', participantId);
  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: participant.event_id,
    action: 'participant_removed',
    performed_by: admin.id,
    details: { player_id: participant.player_id },
  });

  revalidateEventPaths(event.tournament_id as string, participant.event_id as string);
}

export async function checkInParticipant(participantId: string) {
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { data: participant } = await adminClient.from('tournament_participants')
    .select(participantContextSelect)
    .eq('id', participantId)
    .single();

  const participantCtx = extractEventContext(participant);
  if (participantCtx) await assertTournamentNotSuspended(adminClient, participantCtx.tid);

  const { error } = await adminClient.from('tournament_participants')
    .update({
      status: 'checked_in',
      checked_in_at: new Date().toISOString(),
      checked_in_by: admin.id,
    })
    .eq('id', participantId);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  if (participant) {
    const tournamentId = (participant.event as unknown as { tournament_id: string } | null)?.tournament_id;
    if (tournamentId) revalidateEventPaths(tournamentId, participant.event_id as string);
  }
}

export async function markParticipantNoShow(participantId: string) {
  await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { data, error } = await adminClient.from('tournament_participants')
    .update({ status: 'no_show' })
    .eq('id', participantId)
    .select(participantContextSelect)
    .single();

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  const ctx = extractEventContext(data);
  if (ctx) revalidateEventPaths(ctx.tid, ctx.eventId);
}

// ============================================================
// Taking an entry OUT of the event
// ============================================================
// Withdrawal and disqualification are the same operation with different
// paperwork: the entry stops being part of the event. Once a draw exists that
// has to reach the bracket as well, because bracket generation only ever saw a
// point-in-time snapshot of who was in — leave it at a status change and the
// entry stays seeded, their match stays READY, and someone turns up to play a
// player who is not coming.

export interface DrawExitResult {
  /** Matches forfeited to an opponent right now. */
  forfeited: number;
  /**
   * Matches whose opposing slot is still TBD. They are settled automatically
   * the moment the feeder match resolves.
   */
  unresolved: number;
  /**
   * The draw exists but the event has not started, so nothing was forfeited.
   * Regenerating the bracket is the cleaner fix at this stage; failing that,
   * going live sweeps them.
   */
  deferredToGoLive: boolean;
}

async function exitDrawImpl(
  entryId: string,
  isPair: boolean,
  status: DrawExitStatus,
  reason?: string,
): Promise<DrawExitResult> {
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const table = isPair ? 'tournament_pairs' : 'tournament_participants';
  const { data: entry } = await adminClient.from(table)
    .select('id, status, event_id, event:tournament_events(id, status, event_type, tournament_id)')
    .eq('id', entryId)
    .maybeSingle();
  if (!entry) throw new ExpectedError('Entry not found');

  const event = (Array.isArray(entry.event) ? entry.event[0] : entry.event) as {
    id: string; status: string; event_type: string; tournament_id: string;
  } | null;
  if (!event) throw new ExpectedError('Entry is not attached to an event');

  // A finished event's results and Elo are already settled. Pulling someone out
  // now would forfeit nothing and only contradict the standings.
  if (event.status === 'completed') {
    throw new ExpectedError('This event is finished — void the affected matches instead.');
  }
  // A repeat press is normally nothing to do — but on a live event it is also
  // the only way to finish a forfeit cascade that stopped partway, and that is
  // now reachable: applyTournamentMatchElo raises a failed rating write instead
  // of swallowing it, so an entry can end up marked withdrawn with some of its
  // matches still open. The status is written before the cascade runs, so the
  // old unconditional guard would have refused the very retry that fixes it —
  // the same trap finalizeEvent used to set.
  //
  // Forfeiting only ever touches matches that are still open, so re-running it
  // is idempotent. If there was genuinely nothing left, the original refusal
  // still stands (below, once we know).
  const alreadyOut = entry.status === status;
  if (alreadyOut && event.status !== 'live') {
    throw new ExpectedError(status === 'withdrawn' ? 'Already withdrawn.' : 'Already disqualified.');
  }

  if (!alreadyOut) {
    const { error } = await adminClient.from(table)
      .update({ status, notes: reason ?? null })
      .eq('id', entryId);
    if (error) {
      Sentry.captureException(error);
      throw new Error(error.message);
    }
  }

  // Only a live event gets its matches forfeited. Between bracket generation
  // and the first serve nothing has been played: a walkover there could not be
  // rated, and recording one counts as a result, which would block the admin
  // from simply regenerating the draw without this entry. setEventStatus
  // sweeps whatever is still outstanding when the event goes live.
  let outcome: DrawExitResult = {
    forfeited: 0,
    unresolved: 0,
    deferredToGoLive: eventHasDraw(event.status),
  };
  if (event.status === 'live') {
    outcome = {
      ...await forfeitOpenMatchesForEntry(
        adminClient, event.id, entryId, isPair, FORFEIT_REASON[status], admin.id,
      ),
      deferredToGoLive: false,
    };
  }

  // Nothing was left over after all — so this really was just a second press,
  // and it gets the answer it always got.
  if (alreadyOut && outcome.forfeited === 0) {
    throw new ExpectedError(status === 'withdrawn' ? 'Already withdrawn.' : 'Already disqualified.');
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: event.id,
    action: status === 'withdrawn' ? 'participant_withdrawn' : 'participant_disqualified',
    performed_by: admin.id,
    details: { entry_id: entryId, is_pair: isPair, reason: reason ?? null, ...outcome },
  });

  revalidateEventPaths(event.tournament_id, event.id);
  return outcome;
}

// These return ActionResult rather than throwing: Next.js redacts errors thrown
// out of a Server Action in production, so "This event is finished" would reach
// the exec as an opaque banner. Same contract the result actions already use.
export async function withdrawParticipant(participantId: string, reason?: string): Promise<ActionResult<DrawExitResult>> {
  return runAction(() => exitDrawImpl(participantId, false, 'withdrawn', reason));
}

export async function disqualifyParticipant(participantId: string, reason?: string): Promise<ActionResult<DrawExitResult>> {
  return runAction(() => exitDrawImpl(participantId, false, 'disqualified', reason));
}

export async function withdrawPair(pairId: string, reason?: string): Promise<ActionResult<DrawExitResult>> {
  return runAction(() => exitDrawImpl(pairId, true, 'withdrawn', reason));
}

export async function disqualifyPair(pairId: string, reason?: string): Promise<ActionResult<DrawExitResult>> {
  return runAction(() => exitDrawImpl(pairId, true, 'disqualified', reason));
}

// ============================================================
// Doubles Pair Management
// ============================================================

export async function addPairToEvent(eventId: string, player1Id: string, player2Id: string) {
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.status !== 'registration' && event.status !== 'checkin') {
    throw new Error('Cannot add pairs in current status');
  }

  if (event.draw_locked) throw new Error('Draw is locked. Unlock it before making changes.');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  if (!isDoublesEvent(event.event_type)) {
    throw new Error('Use addParticipantToEvent for singles events');
  }

  if (event.max_participants) {
    const { count } = await adminClient.from('tournament_pairs')
      .select('*', { count: 'exact', head: true })
      .eq('event_id', eventId)
      .not('status', 'eq', 'withdrawn');
    if (count && count >= event.max_participants) {
      throw new Error('Event is full');
    }
  }

  // Get both players' Elo and names
  const { data: ratings } = await adminClient.from('ratings')
    .select('player_id, doubles_elo')
    .in('player_id', [player1Id, player2Id]);

  const { data: players } = await adminClient.from('players')
    .select('id, full_name')
    .in('id', [player1Id, player2Id]);

  const p1Rating = ratings?.find(r => r.player_id === player1Id)?.doubles_elo ?? 400;
  const p2Rating = ratings?.find(r => r.player_id === player2Id)?.doubles_elo ?? 400;
  const combinedElo = calculateTeamRating([p1Rating, p2Rating]);

  const p1Name = players?.find(p => p.id === player1Id)?.full_name ?? '';
  const p2Name = players?.find(p => p.id === player2Id)?.full_name ?? '';

  const { data, error } = await adminClient.from('tournament_pairs').insert({
    event_id: eventId,
    player1_id: player1Id,
    player2_id: player2Id,
    pair_name: `${p1Name} / ${p2Name}`,
    combined_elo: combinedElo,
    added_by: admin.id,
  }).select().single();

  if (error) {
    if (error.code === '23505') throw new Error('This pair is already registered');
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'pair_added',
    performed_by: admin.id,
    details: { player1_id: player1Id, player2_id: player2Id },
  });

  revalidateEventPaths(event.tournament_id, eventId);
  return data;
}

export async function removePairFromEvent(pairId: string) {
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { data: pair } = await adminClient.from('tournament_pairs')
    .select('*, event:tournament_events(*)')
    .eq('id', pairId)
    .single();
  if (!pair) throw new Error('Pair not found');

  const event = pair.event as Record<string, unknown>;
  if (event.status !== 'registration') {
    throw new Error('Cannot remove pairs after registration closes');
  }
  if (event.draw_locked) throw new Error('Draw is locked. Unlock it before making changes.');

  const { error } = await adminClient.from('tournament_pairs').delete().eq('id', pairId);
  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  revalidateEventPaths(event.tournament_id as string, pair.event_id as string);
}

export async function checkInPair(pairId: string) {
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { data: pair } = await adminClient.from('tournament_pairs')
    .select(pairContextSelect)
    .eq('id', pairId)
    .single();

  const pairCtx = extractEventContext(pair);
  if (pairCtx) await assertTournamentNotSuspended(adminClient, pairCtx.tid);

  const { data, error } = await adminClient.from('tournament_pairs')
    .update({
      status: 'checked_in',
      checked_in_at: new Date().toISOString(),
      checked_in_by: admin.id,
    })
    .eq('id', pairId)
    .select(pairContextSelect)
    .single();

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  const ctx = extractEventContext(data);
  if (ctx) revalidateEventPaths(ctx.tid, ctx.eventId);
}

export async function markPairNoShow(pairId: string) {
  await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { data, error } = await adminClient.from('tournament_pairs')
    .update({ status: 'no_show' })
    .eq('id', pairId)
    .select(pairContextSelect)
    .single();

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  const ctx = extractEventContext(data);
  if (ctx) revalidateEventPaths(ctx.tid, ctx.eventId);
}

// ============================================================
// Bulk check-in
// ============================================================

export async function bulkCheckIn(eventId: string, type: 'participants' | 'pairs') {
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const table = type === 'pairs' ? 'tournament_pairs' : 'tournament_participants';

  const { data: event } = await adminClient.from('tournament_events').select('tournament_id').eq('id', eventId).single();
  if (event) await assertTournamentNotSuspended(adminClient, event.tournament_id);

  const { error } = await adminClient.from(table)
    .update({
      status: 'checked_in',
      checked_in_at: new Date().toISOString(),
      checked_in_by: admin.id,
    })
    .eq('event_id', eventId)
    .eq('status', 'registered');

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  if (event) revalidateEventPaths(event.tournament_id, eventId);
}
