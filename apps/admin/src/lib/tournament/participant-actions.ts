'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient, getAuthenticatedAdmin } from '../supabase-server';
import { isDoublesEvent, calculateTeamRating } from '@badminton/shared';
import {
  logAudit,
  revalidateEventPaths,
  participantContextSelect,
  pairContextSelect,
  extractEventContext,
} from './_helpers';

// ============================================================
// Singles Participant Management
// ============================================================

export async function addParticipantToEvent(eventId: string, playerId: string) {
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.status !== 'registration' && event.status !== 'checkin') {
    throw new Error('Cannot add participants in current status');
  }
  if (event.draw_locked) throw new Error('Draw is locked. Unlock it before making changes.');

  if (isDoublesEvent(event.event_type)) {
    throw new Error('Use addPairToEvent for doubles events');
  }

  if (event.max_participants) {
    const { count } = await adminClient.from('tournament_participants')
      .select('*', { count: 'exact', head: true })
      .eq('event_id', eventId)
      .not('status', 'eq', 'withdrawn');
    if (count && count >= event.max_participants) {
      throw new Error('Event is full');
    }
  }

  let { data: rating } = await adminClient.from('ratings').select('singles_elo').eq('player_id', playerId).single();
  if (!rating) {
    const { data: newRating } = await adminClient.from('ratings').insert({
      player_id: playerId,
      singles_elo: 1200,
      doubles_elo: 1200,
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
    elo_before: rating?.singles_elo ?? 1200,
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

export async function removeParticipantFromEvent(participantId: string) {
  const admin = await getAuthenticatedAdmin();
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

export async function updateParticipantSeed(participantId: string, seedNumber: number | null) {
  await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: participant } = await adminClient.from('tournament_participants')
    .select('event_id, event:tournament_events(tournament_id, draw_locked)')
    .eq('id', participantId)
    .single();
  const ev = (participant?.event as unknown as { tournament_id: string; draw_locked: boolean } | null);
  if (ev?.draw_locked) throw new Error('Draw is locked. Unlock it before changing seeds.');

  const { error } = await adminClient.from('tournament_participants')
    .update({ seed_number: seedNumber })
    .eq('id', participantId);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  if (ev?.tournament_id && participant?.event_id) {
    revalidateEventPaths(ev.tournament_id, participant.event_id as string);
  }
}

export async function updatePairSeed(pairId: string, seedNumber: number | null) {
  await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: pair } = await adminClient.from('tournament_pairs')
    .select('event_id, event:tournament_events(tournament_id, draw_locked)')
    .eq('id', pairId)
    .single();
  const ev = (pair?.event as unknown as { tournament_id: string; draw_locked: boolean } | null);
  if (ev?.draw_locked) throw new Error('Draw is locked. Unlock it before changing seeds.');

  const { error } = await adminClient.from('tournament_pairs')
    .update({ seed_number: seedNumber })
    .eq('id', pairId);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  if (ev?.tournament_id && pair?.event_id) {
    revalidateEventPaths(ev.tournament_id, pair.event_id as string);
  }
}

export async function autoSeedEventByElo(eventId: string) {
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');

  if (event.draw_locked) throw new Error('Draw is locked. Unlock it before making changes.');

  const doubles = isDoublesEvent(event.event_type);

  if (doubles) {
    const { data: pairs } = await adminClient.from('tournament_pairs')
      .select('id, combined_elo')
      .eq('event_id', eventId)
      .not('status', 'in', '("withdrawn","disqualified")')
      .order('combined_elo', { ascending: false, nullsFirst: false });

    if (pairs) {
      for (let i = 0; i < pairs.length; i++) {
        await adminClient.from('tournament_pairs')
          .update({ seed_number: i + 1 })
          .eq('id', pairs[i]!.id);
      }
    }
  } else {
    const { data: participants } = await adminClient.from('tournament_participants')
      .select('id, elo_before')
      .eq('event_id', eventId)
      .not('status', 'in', '("withdrawn","disqualified")')
      .order('elo_before', { ascending: false, nullsFirst: false });

    if (participants) {
      for (let i = 0; i < participants.length; i++) {
        await adminClient.from('tournament_participants')
          .update({ seed_number: i + 1 })
          .eq('id', participants[i]!.id);
      }
    }
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'auto_seeded',
    performed_by: admin.id,
  });

  revalidateEventPaths(event.tournament_id, eventId);
}

export async function checkInParticipant(participantId: string) {
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: participant } = await adminClient.from('tournament_participants')
    .select('event_id, event:tournament_events(tournament_id)')
    .eq('id', participantId)
    .single();

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
  await getAuthenticatedAdmin();
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

export async function withdrawParticipant(participantId: string, reason?: string) {
  await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data, error } = await adminClient.from('tournament_participants')
    .update({ status: 'withdrawn', notes: reason ?? null })
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

export async function disqualifyParticipant(participantId: string, reason?: string) {
  await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data, error } = await adminClient.from('tournament_participants')
    .update({ status: 'disqualified', notes: reason ?? null })
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
// Doubles Pair Management
// ============================================================

export async function addPairToEvent(eventId: string, player1Id: string, player2Id: string) {
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.status !== 'registration' && event.status !== 'checkin') {
    throw new Error('Cannot add pairs in current status');
  }

  if (event.draw_locked) throw new Error('Draw is locked. Unlock it before making changes.');

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

  const { data: ratings } = await adminClient.from('ratings')
    .select('player_id, doubles_elo')
    .in('player_id', [player1Id, player2Id]);

  const { data: players } = await adminClient.from('players')
    .select('id, full_name')
    .in('id', [player1Id, player2Id]);

  const p1Rating = ratings?.find(r => r.player_id === player1Id)?.doubles_elo ?? 1200;
  const p2Rating = ratings?.find(r => r.player_id === player2Id)?.doubles_elo ?? 1200;
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
  await getAuthenticatedAdmin();
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
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

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
  await getAuthenticatedAdmin();
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
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const table = type === 'pairs' ? 'tournament_pairs' : 'tournament_participants';

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

  const { data: event } = await adminClient.from('tournament_events').select('tournament_id').eq('id', eventId).single();
  if (event) revalidateEventPaths(event.tournament_id, eventId);
}

// ============================================================
// Draw Lock / Unlock
// ============================================================

export async function lockDraw(eventId: string) {
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');

  const { error } = await adminClient.from('tournament_events')
    .update({ draw_locked: true, updated_at: new Date().toISOString() })
    .eq('id', eventId);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'draw_locked',
    performed_by: admin.id,
  });

  revalidateEventPaths(event.tournament_id, eventId);
}

export async function unlockDraw(eventId: string) {
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');

  const { error } = await adminClient.from('tournament_events')
    .update({ draw_locked: false, updated_at: new Date().toISOString() })
    .eq('id', eventId);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'draw_unlocked',
    performed_by: admin.id,
  });

  revalidateEventPaths(event.tournament_id, eventId);
}

// ============================================================
// Clear Seeds
// ============================================================

export async function clearSeeds(eventId: string) {
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.draw_locked) throw new Error('Draw is locked. Unlock it before clearing seeds.');

  const doubles = isDoublesEvent(event.event_type);
  const table = doubles ? 'tournament_pairs' : 'tournament_participants';

  const { error } = await adminClient.from(table)
    .update({ seed_number: null })
    .eq('event_id', eventId);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'seeds_cleared',
    performed_by: admin.id,
  });

  revalidateEventPaths(event.tournament_id, eventId);
}
