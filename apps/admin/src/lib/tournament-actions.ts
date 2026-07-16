'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient, getAuthenticatedAdmin } from './supabase-server';
import { revalidatePath } from 'next/cache';
import {
  calculateEloUpdate,
  getKFactor,
  getFormatWeight,
  calculateTeamRating,
  PLACEMENT_BONUSES,
  isDoublesEvent,
  nextPowerOf2,
  getRoundName,
  getMaxGamesForFormat,
} from '@badminton/shared';
import type {
  TournamentEventType,
  TournamentEventFormat,
  TournamentMatchFormat,
  TournamentSeedingMethod,
  TournamentEventStatus,
  MatchFormat,
} from '@badminton/shared';

async function getAdminPlayer() {
  return getAuthenticatedAdmin();
}

// Revalidate both the tournament page and the event detail page so admin UIs
// reflect mutations immediately. Pass eventId whenever it is in scope.
function revalidateEventPaths(tournamentId: string, eventId?: string) {
  revalidatePath(`/tournaments/${tournamentId}`);
  if (eventId) revalidatePath(`/tournaments/${tournamentId}/events/${eventId}`);
}

// Map tournament match format to the shared elo engine's MatchFormat
function toEloFormat(mf: TournamentMatchFormat): MatchFormat {
  switch (mf) {
    case 'best_of_3_to_21': return 'bo3_21';
    case 'one_game_21': return 'single_21';
    case 'one_game_15': return 'single_15';
    case 'one_game_11': return 'single_11';
  }
}

// ============================================================
// Notification helper
// ============================================================

async function notifyPlayers(
  adminClient: ReturnType<typeof createAdminClient>,
  playerIds: string[],
  title: string,
  body: string,
  metadata?: Record<string, unknown>,
  notificationType: 'general' | 'tournament_bracket_published' | 'tournament_match_ready' | 'tournament_match_result' | 'tournament_event_completed' | 'tournament_checkin_open' = 'general'
) {
  if (playerIds.length === 0) return;
  try {
    const rows = playerIds.map(pid => ({
      player_id: pid,
      type: notificationType,
      title,
      body,
      metadata: metadata ?? {},
    }));
    const { error } = await adminClient.from('notifications').insert(rows);
    if (error) throw error;
  } catch (err) {
    // Notifications are best-effort — never let a failure break the parent action.
    Sentry.captureException(err);
  }
}

// ============================================================
// Audit helper
// ============================================================

async function logAudit(
  adminClient: ReturnType<typeof createAdminClient>,
  params: {
    tournament_id?: string;
    event_id?: string;
    match_id?: string;
    action: string;
    performed_by: string;
    details?: Record<string, unknown>;
  }
) {
  await adminClient.from('tournament_audit_log').insert({
    tournament_id: params.tournament_id ?? null,
    event_id: params.event_id ?? null,
    match_id: params.match_id ?? null,
    action: params.action,
    performed_by: params.performed_by,
    details: params.details ?? null,
  });
}

// ============================================================
// Event Management
// ============================================================

export async function createTournamentEvent(
  tournamentId: string,
  config: {
    event_type: TournamentEventType;
    format: TournamentEventFormat;
    match_format?: TournamentMatchFormat;
    max_participants?: number;
    seeding_method?: TournamentSeedingMethod;
    elo_multiplier?: number;
    placement_bonus_enabled?: boolean;
  }
) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data, error } = await adminClient.from('tournament_events').insert({
    tournament_id: tournamentId,
    event_type: config.event_type,
    format: config.format,
    match_format: config.match_format ?? 'best_of_3_to_21',
    max_participants: config.max_participants ?? null,
    seeding_method: config.seeding_method ?? 'elo',
    elo_multiplier: config.elo_multiplier ?? 1.25,
    placement_bonus_enabled: config.placement_bonus_enabled ?? true,
  }).select().single();

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  await logAudit(adminClient, {
    tournament_id: tournamentId,
    event_id: data.id,
    action: 'event_created',
    performed_by: admin.id,
    details: config as Record<string, unknown>,
  });

  revalidatePath(`/tournaments/${tournamentId}`);
  return data;
}

export async function updateTournamentEvent(
  eventId: string,
  updates: {
    match_format?: TournamentMatchFormat;
    max_participants?: number | null;
    seeding_method?: TournamentSeedingMethod;
    elo_multiplier?: number;
    placement_bonus_enabled?: boolean;
  }
) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.status !== 'registration') throw new Error('Can only update events in registration status');

  const { error } = await adminClient.from('tournament_events')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', eventId);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'event_updated',
    performed_by: admin.id,
    details: updates as Record<string, unknown>,
  });

  revalidateEventPaths(event.tournament_id, eventId);
}

export async function deleteTournamentEvent(eventId: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.status !== 'registration') throw new Error('Can only delete events in registration status');

  const { error } = await adminClient.from('tournament_events').delete().eq('id', eventId);
  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    action: 'event_deleted',
    performed_by: admin.id,
    details: { event_type: event.event_type },
  });

  revalidatePath(`/tournaments/${event.tournament_id}`);
}

export async function setEventStatus(eventId: string, status: TournamentEventStatus) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');

  // Validate status transitions
  const validTransitions: Record<string, string[]> = {
    registration: ['checkin'],
    checkin: ['bracket_generated'],
    bracket_generated: ['live'],
    live: ['completed'],
  };

  if (!validTransitions[event.status]?.includes(status)) {
    throw new Error(`Invalid transition from ${event.status} to ${status}`);
  }

  // Guard: do not go live unless a bracket exists.
  if (status === 'live') {
    const { count: matchCount } = await adminClient.from('tournament_matches')
      .select('*', { count: 'exact', head: true })
      .eq('event_id', eventId);
    if (!matchCount || matchCount === 0) {
      throw new Error('Cannot go live — no bracket has been generated for this event');
    }
  }

  const { error } = await adminClient.from('tournament_events')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', eventId);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: `status_changed_to_${status}`,
    performed_by: admin.id,
  });

  revalidateEventPaths(event.tournament_id, eventId);
}

// ============================================================
// Singles Participant Management
// ============================================================

export async function addParticipantToEvent(eventId: string, playerId: string) {
  const admin = await getAdminPlayer();
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
  let { data: rating } = await adminClient.from('ratings').select('singles_elo').eq('player_id', playerId).single();
  if (!rating) {
    // Player has no ratings record — create one with defaults
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
  const admin = await getAdminPlayer();
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
  await getAdminPlayer();
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
  await getAdminPlayer();
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
  const admin = await getAdminPlayer();
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
  const admin = await getAdminPlayer();
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

// Pull the event/tournament context from a joined select on the UPDATE itself
// so participant/pair status mutations don't need a second round-trip just to
// figure out which paths to revalidate.
const participantContextSelect = 'event_id, event:tournament_events(tournament_id)' as const;
const pairContextSelect = 'event_id, event:tournament_events(tournament_id)' as const;

function extractEventContext(row: { event_id?: unknown; event?: unknown } | null): { tid: string; eventId: string } | null {
  if (!row) return null;
  const eventId = row.event_id as string | undefined;
  const tid = (row.event as { tournament_id?: string } | null)?.tournament_id;
  if (!eventId || !tid) return null;
  return { tid, eventId };
}

export async function markParticipantNoShow(participantId: string) {
  await getAdminPlayer();
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
  await getAdminPlayer();
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
  await getAdminPlayer();
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
  const admin = await getAdminPlayer();
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

  // Get both players' Elo and names
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
  const admin = await getAdminPlayer();
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
  const admin = await getAdminPlayer();
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
  await getAdminPlayer();
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
// Bracket Generation — Single Elimination
// ============================================================

/**
 * Standard tournament seeding positions.
 * For a bracket of size B, returns an array of length B where
 * index = bracket position, value = seed number (1-based).
 * Ensures seed 1 and 2 are on opposite halves, 3/4 in opposite quarters, etc.
 */
function getStandardSeedPositions(bracketSize: number): number[] {
  if (bracketSize < 2) return [1];

  // Start with seeds 1 and 2
  let positions = [1, 2];

  while (positions.length < bracketSize) {
    const nextRound: number[] = [];
    const sum = positions.length * 2 + 1;
    for (const seed of positions) {
      nextRound.push(seed);
      nextRound.push(sum - seed);
    }
    positions = nextRound;
  }

  return positions;
}

export async function generateSingleEliminationBracket(eventId: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.draw_locked) throw new Error('Draw is locked. Unlock it before generating bracket.');

  const doubles = isDoublesEvent(event.event_type);

  // Fetch eligible participants/pairs
  let entries: Array<{ id: string; seed: number | null; elo: number }> = [];

  if (doubles) {
    const { data: pairs } = await adminClient.from('tournament_pairs')
      .select('id, seed_number, combined_elo, status')
      .eq('event_id', eventId)
      .in('status', ['registered', 'checked_in'])
      .order('seed_number', { ascending: true, nullsFirst: false });
    entries = (pairs ?? []).map(p => ({ id: p.id, seed: p.seed_number, elo: p.combined_elo ?? 1200 }));
  } else {
    const { data: participants } = await adminClient.from('tournament_participants')
      .select('id, seed_number, elo_before, status')
      .eq('event_id', eventId)
      .in('status', ['registered', 'checked_in'])
      .order('seed_number', { ascending: true, nullsFirst: false });
    entries = (participants ?? []).map(p => ({ id: p.id, seed: p.seed_number, elo: p.elo_before ?? 1200 }));
  }

  const N = entries.length;
  if (N < 2) throw new Error('Need at least 2 participants to generate a bracket');

  // If not yet seeded, auto-seed by Elo
  const needsSeeding = entries.some(e => e.seed === null);
  if (needsSeeding) {
    entries.sort((a, b) => b.elo - a.elo);
    entries.forEach((e, i) => { e.seed = i + 1; });
    // Persist seeds in parallel — independent rows, no contention.
    const seedTable = doubles ? 'tournament_pairs' : 'tournament_participants';
    const seedResults = await Promise.allSettled(
      entries.map(e => Promise.resolve(
        adminClient.from(seedTable).update({ seed_number: e.seed }).eq('id', e.id)
      ))
    );
    for (const r of seedResults) {
      if (r.status === 'rejected') Sentry.captureException(r.reason);
    }
  } else {
    entries.sort((a, b) => (a.seed ?? 999) - (b.seed ?? 999));
  }

  const bracketSize = nextPowerOf2(N);
  const totalRounds = Math.log2(bracketSize);
  const numByes = bracketSize - N;

  // Get standard seeding positions
  const seedPositions = getStandardSeedPositions(bracketSize);

  // Map seed number to entry — seeds beyond N get a BYE (null entry)
  const bracketSlots: Array<{ id: string; seed: number } | null> = new Array(bracketSize).fill(null);
  for (let pos = 0; pos < bracketSize; pos++) {
    const seedNum = seedPositions[pos]!;
    const entry = entries.find(e => e.seed === seedNum);
    if (entry) {
      bracketSlots[pos] = { id: entry.id, seed: seedNum };
    }
  }

  // Delete any existing matches for this event
  await adminClient.from('tournament_matches').delete().eq('event_id', eventId);

  // Create all match shells from final backwards to round 1
  // matchesByRound[roundNumber] = array of match IDs in bracket_position order
  const matchesByRound: string[][] = [];

  for (let round = totalRounds; round >= 1; round--) {
    const matchCount = bracketSize / Math.pow(2, round);
    const roundName = getRoundName(round, totalRounds);
    const roundMatches: string[] = [];

    for (let pos = 0; pos < matchCount; pos++) {
      const nextMatchId = round < totalRounds ? matchesByRound[round]?.[Math.floor(pos / 2)] ?? null : null;
      const nextMatchPosition = round < totalRounds ? (pos % 2 === 0 ? 'a' : 'b') : null;

      const { data: match, error } = await adminClient.from('tournament_matches').insert({
        event_id: eventId,
        round_number: round,
        round_name: roundName,
        bracket_position: pos,
        match_number: null, // will assign later
        winner_to_match_id: nextMatchId,
        winner_to_position: nextMatchPosition,
        status: 'pending',
      }).select('id').single();

      if (error) {
        Sentry.captureException(error);
        throw new Error(`Failed to create match: ${error.message}`);
      }

      roundMatches.push(match!.id);
    }

    matchesByRound[round] = roundMatches;
  }

  // Populate Round 1 matches with participants from bracket slots
  const round1Matches = matchesByRound[1] ?? [];
  let matchNumber = 1;

  for (let matchIdx = 0; matchIdx < round1Matches.length; matchIdx++) {
    const matchId = round1Matches[matchIdx];
    const slotA = bracketSlots[matchIdx * 2];
    const slotB = bracketSlots[matchIdx * 2 + 1];

    const updateData: Record<string, unknown> = {
      match_number: matchNumber++,
    };

    if (doubles) {
      updateData.pair_a_id = slotA?.id ?? null;
      updateData.pair_b_id = slotB?.id ?? null;
    } else {
      updateData.participant_a_id = slotA?.id ?? null;
      updateData.participant_b_id = slotB?.id ?? null;
    }

    // Determine if this is a bye
    const isBye = (slotA !== null && slotB === null) || (slotA === null && slotB !== null);

    if (isBye) {
      const winner = slotA ?? slotB;
      updateData.is_bye = true;
      updateData.status = 'completed';
      if (doubles) {
        updateData.winner_pair_id = winner!.id;
      } else {
        updateData.winner_participant_id = winner!.id;
      }
    } else if (slotA !== null && slotB !== null) {
      updateData.status = 'ready';
    }

    await adminClient.from('tournament_matches').update(updateData).eq('id', matchId);

    // If bye, advance winner to next match
    if (isBye) {
      const { data: currentMatch } = await adminClient.from('tournament_matches')
        .select('winner_to_match_id, winner_to_position')
        .eq('id', matchId)
        .single();

      if (currentMatch?.winner_to_match_id) {
        const advanceField = doubles
          ? (currentMatch.winner_to_position === 'a' ? 'pair_a_id' : 'pair_b_id')
          : (currentMatch.winner_to_position === 'a' ? 'participant_a_id' : 'participant_b_id');

        await adminClient.from('tournament_matches')
          .update({ [advanceField]: (slotA ?? slotB)!.id })
          .eq('id', currentMatch.winner_to_match_id);

        // Check if next match now has both participants → set to ready
        const { data: nextMatch } = await adminClient.from('tournament_matches')
          .select('*')
          .eq('id', currentMatch.winner_to_match_id)
          .single();

        if (nextMatch) {
          const hasBoth = doubles
            ? (nextMatch.pair_a_id && nextMatch.pair_b_id)
            : (nextMatch.participant_a_id && nextMatch.participant_b_id);
          if (hasBoth) {
            await adminClient.from('tournament_matches')
              .update({ status: 'ready' })
              .eq('id', currentMatch.winner_to_match_id);
          }
        }
      }
    }
  }

  // Assign match numbers for remaining rounds — collect all (id, number) pairs
  // and issue UPDATEs in parallel.
  const matchNumberAssignments: Array<{ id: string; number: number }> = [];
  for (let round = 2; round <= totalRounds; round++) {
    for (const mId of matchesByRound[round] ?? []) {
      matchNumberAssignments.push({ id: mId, number: matchNumber++ });
    }
  }
  if (matchNumberAssignments.length > 0) {
    const numberResults = await Promise.allSettled(
      matchNumberAssignments.map(a => Promise.resolve(
        adminClient.from('tournament_matches').update({ match_number: a.number }).eq('id', a.id)
      ))
    );
    for (const r of numberResults) {
      if (r.status === 'rejected') Sentry.captureException(r.reason);
    }
  }

  // Update event status
  await adminClient.from('tournament_events')
    .update({ status: 'bracket_generated', updated_at: new Date().toISOString() })
    .eq('id', eventId);

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'bracket_generated',
    performed_by: admin.id,
    details: { bracket_size: bracketSize, participants: N, byes: numByes },
  });

  // Notify all participants that bracket is published
  const bracketPlayerIds: string[] = [];
  if (doubles) {
    const { data: allPairs } = await adminClient.from('tournament_pairs')
      .select('player1_id, player2_id').eq('event_id', eventId).in('status', ['registered', 'checked_in']);
    for (const p of allPairs ?? []) { bracketPlayerIds.push(p.player1_id, p.player2_id); }
  } else {
    const { data: allParts } = await adminClient.from('tournament_participants')
      .select('player_id').eq('event_id', eventId).in('status', ['registered', 'checked_in']);
    for (const p of allParts ?? []) { bracketPlayerIds.push(p.player_id); }
  }
  const { data: tournamentInfo } = await adminClient.from('tournaments').select('name').eq('id', event.tournament_id).single();
  await notifyPlayers(adminClient, bracketPlayerIds,
    'Bracket Published',
    `The bracket for ${tournamentInfo?.name ?? 'your tournament'} has been published. Check your matches!`,
    { event_id: eventId, tournament_id: event.tournament_id },
    'tournament_bracket_published'
  );

  revalidateEventPaths(event.tournament_id, eventId);
}

// ============================================================
// Bracket Generation — Round Robin
// ============================================================

export async function generateRoundRobinMatches(eventId: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.draw_locked) throw new Error('Draw is locked. Unlock it before generating matches.');

  const doubles = isDoublesEvent(event.event_type);

  let entries: Array<{ id: string; seed: number | null }> = [];

  if (doubles) {
    const { data: pairs } = await adminClient.from('tournament_pairs')
      .select('id, seed_number, status')
      .eq('event_id', eventId)
      .in('status', ['registered', 'checked_in'])
      .order('seed_number', { ascending: true, nullsFirst: false });
    entries = (pairs ?? []).map(p => ({ id: p.id, seed: p.seed_number }));
  } else {
    const { data: participants } = await adminClient.from('tournament_participants')
      .select('id, seed_number, status')
      .eq('event_id', eventId)
      .in('status', ['registered', 'checked_in'])
      .order('seed_number', { ascending: true, nullsFirst: false });
    entries = (participants ?? []).map(p => ({ id: p.id, seed: p.seed_number }));
  }

  const N = entries.length;
  if (N < 3) throw new Error('Need at least 3 participants for round robin');

  // Delete any existing matches
  await adminClient.from('tournament_matches').delete().eq('event_id', eventId);

  // Circle method for round robin scheduling
  // If odd number of participants, add a phantom (BYE)
  const isOdd = N % 2 !== 0;
  const paddedEntries = [...entries];
  if (isOdd) {
    paddedEntries.push({ id: 'BYE', seed: null });
  }

  const numRounds = paddedEntries.length - 1;
  const halfSize = paddedEntries.length / 2;
  let matchNumber = 1;

  // Circle method: fix first player, rotate the rest
  const indices = paddedEntries.map((_, i) => i);

  for (let round = 0; round < numRounds; round++) {
    const roundMatchPositions: Array<[number, number]> = [];

    for (let i = 0; i < halfSize; i++) {
      const home = indices[i]!;
      const away = indices[paddedEntries.length - 1 - i]!;
      if (paddedEntries[home]!.id !== 'BYE' && paddedEntries[away]!.id !== 'BYE') {
        roundMatchPositions.push([home, away]);
      }
    }

    for (let pos = 0; pos < roundMatchPositions.length; pos++) {
      const [homeIdx, awayIdx] = roundMatchPositions[pos]!;
      const insertData: Record<string, unknown> = {
        event_id: eventId,
        round_number: round + 1,
        round_name: `Round ${round + 1}`,
        bracket_position: pos,
        match_number: matchNumber++,
        status: 'pending',
      };

      if (doubles) {
        insertData.pair_a_id = paddedEntries[homeIdx]!.id;
        insertData.pair_b_id = paddedEntries[awayIdx]!.id;
      } else {
        insertData.participant_a_id = paddedEntries[homeIdx]!.id;
        insertData.participant_b_id = paddedEntries[awayIdx]!.id;
      }

      await adminClient.from('tournament_matches').insert(insertData);
    }

    // Rotate: keep index 0 fixed, rotate the rest
    const last = indices.pop()!;
    indices.splice(1, 0, last);
  }

  // Update event status
  await adminClient.from('tournament_events')
    .update({ status: 'bracket_generated', updated_at: new Date().toISOString() })
    .eq('id', eventId);

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'round_robin_generated',
    performed_by: admin.id,
    details: { participants: N, rounds: numRounds },
  });

  revalidateEventPaths(event.tournament_id, eventId);
}

// ============================================================
// Score Entry & Advancement
// ============================================================

export async function enterMatchResult(
  matchId: string,
  scores: Array<{ a: number; b: number }>,
  winnerSide: 'a' | 'b'
) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (!match) throw new Error('Match not found');
  if (match.status !== 'pending' && match.status !== 'ready' && match.status !== 'live') {
    throw new Error('Match is not in a playable state');
  }

  const event = match.event as Record<string, unknown>;
  const matchFormat = event.match_format as TournamentMatchFormat;
  const maxGames = getMaxGamesForFormat(matchFormat);
  if (scores.length > maxGames) {
    throw new Error(`Too many games for format ${matchFormat}. Max: ${maxGames}`);
  }

  const doubles = isDoublesEvent(event.event_type as TournamentEventType);

  // Determine winner and loser IDs
  let winnerIdField: string;
  let loserIdField: string;
  let winnerId: string;
  let loserId: string;

  if (doubles) {
    winnerId = winnerSide === 'a' ? match.pair_a_id : match.pair_b_id;
    loserId = winnerSide === 'a' ? match.pair_b_id : match.pair_a_id;
    winnerIdField = 'winner_pair_id';
    loserIdField = 'loser_pair_id';
  } else {
    winnerId = winnerSide === 'a' ? match.participant_a_id : match.participant_b_id;
    loserId = winnerSide === 'a' ? match.participant_b_id : match.participant_a_id;
    winnerIdField = 'winner_participant_id';
    loserIdField = 'loser_participant_id';
  }

  // Update match
  const { error } = await adminClient.from('tournament_matches').update({
    scores,
    [winnerIdField]: winnerId,
    [loserIdField]: loserId,
    status: 'completed',
    result_entered_by: admin.id,
    result_entered_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', matchId);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  // Advance winner to next match (single elimination only)
  if (match.winner_to_match_id) {
    const advanceField = doubles
      ? (match.winner_to_position === 'a' ? 'pair_a_id' : 'pair_b_id')
      : (match.winner_to_position === 'a' ? 'participant_a_id' : 'participant_b_id');

    await adminClient.from('tournament_matches')
      .update({ [advanceField]: winnerId })
      .eq('id', match.winner_to_match_id);

    // Check if next match now has both sides → set to ready
    const { data: nextMatch } = await adminClient.from('tournament_matches')
      .select('*')
      .eq('id', match.winner_to_match_id)
      .single();

    if (nextMatch) {
      const hasBoth = doubles
        ? (nextMatch.pair_a_id && nextMatch.pair_b_id)
        : (nextMatch.participant_a_id && nextMatch.participant_b_id);
      if (hasBoth) {
        await adminClient.from('tournament_matches')
          .update({ status: 'ready' })
          .eq('id', match.winner_to_match_id);
      }
    }
  }

  // Apply Elo
  await applyTournamentMatchElo(matchId);

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    action: 'result_entered',
    performed_by: admin.id,
    details: { scores, winner_side: winnerSide },
  });

  // Notify both players of match result
  const matchPlayerIds: string[] = [];
  if (doubles) {
    for (const pairId of [match.pair_a_id, match.pair_b_id].filter(Boolean)) {
      const { data: pair } = await adminClient.from('tournament_pairs').select('player1_id, player2_id').eq('id', pairId).single();
      if (pair) { matchPlayerIds.push(pair.player1_id, pair.player2_id); }
    }
  } else {
    for (const pid of [match.participant_a_id, match.participant_b_id].filter(Boolean)) {
      const { data: p } = await adminClient.from('tournament_participants').select('player_id').eq('id', pid).single();
      if (p) matchPlayerIds.push(p.player_id);
    }
  }
  await notifyPlayers(adminClient, matchPlayerIds,
    'Match Result Confirmed',
    `Your match result has been recorded. Score: ${scores.map((s: { a: number; b: number }) => `${s.a}-${s.b}`).join(', ')}`,
    { match_id: matchId, event_id: match.event_id },
    'tournament_match_result'
  );

  revalidateEventPaths(event.tournament_id as string, match.event_id as string);
}

export async function enterWalkover(
  matchId: string,
  winnerPosition: 'a' | 'b',
  reason: string
) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (!match) throw new Error('Match not found');

  const event = match.event as Record<string, unknown>;
  const doubles = isDoublesEvent(event.event_type as TournamentEventType);

  let winnerId: string;
  let loserId: string;

  if (doubles) {
    winnerId = winnerPosition === 'a' ? match.pair_a_id : match.pair_b_id;
    loserId = winnerPosition === 'a' ? match.pair_b_id : match.pair_a_id;
  } else {
    winnerId = winnerPosition === 'a' ? match.participant_a_id : match.participant_b_id;
    loserId = winnerPosition === 'a' ? match.participant_b_id : match.participant_a_id;
  }

  const winnerField = doubles ? 'winner_pair_id' : 'winner_participant_id';
  const loserField = doubles ? 'loser_pair_id' : 'loser_participant_id';

  await adminClient.from('tournament_matches').update({
    status: 'walkover',
    walkover_winner: winnerPosition,
    walkover_reason: reason,
    [winnerField]: winnerId,
    [loserField]: loserId,
    result_entered_by: admin.id,
    result_entered_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', matchId);

  // Advance winner
  if (match.winner_to_match_id) {
    const advanceField = doubles
      ? (match.winner_to_position === 'a' ? 'pair_a_id' : 'pair_b_id')
      : (match.winner_to_position === 'a' ? 'participant_a_id' : 'participant_b_id');

    await adminClient.from('tournament_matches')
      .update({ [advanceField]: winnerId })
      .eq('id', match.winner_to_match_id);

    // Check if next match is now ready
    const { data: nextMatch } = await adminClient.from('tournament_matches')
      .select('*')
      .eq('id', match.winner_to_match_id)
      .single();

    if (nextMatch) {
      const hasBoth = doubles
        ? (nextMatch.pair_a_id && nextMatch.pair_b_id)
        : (nextMatch.participant_a_id && nextMatch.participant_b_id);
      if (hasBoth) {
        await adminClient.from('tournament_matches')
          .update({ status: 'ready' })
          .eq('id', match.winner_to_match_id);
      }
    }
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    action: 'walkover_entered',
    performed_by: admin.id,
    details: { winner_position: winnerPosition, reason },
  });

  // Apply Elo for walkovers too — losing party still gets penalised, winner still gains.
  await applyTournamentMatchElo(matchId);

  revalidateEventPaths(event.tournament_id as string, match.event_id as string);
}

export async function voidMatch(matchId: string, reason: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (!match) throw new Error('Match not found');

  const event = match.event as Record<string, unknown>;

  await adminClient.from('tournament_matches').update({
    status: 'voided',
    notes: reason,
    updated_at: new Date().toISOString(),
  }).eq('id', matchId);

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    action: 'match_voided',
    performed_by: admin.id,
    details: { reason },
  });

  revalidateEventPaths(event.tournament_id as string, match.event_id as string);
}

export async function editMatchResult(
  matchId: string,
  newScores: Array<{ a: number; b: number }>,
  newWinnerSide: 'a' | 'b'
) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (!match) throw new Error('Match not found');

  // Check no downstream matches have been completed
  if (match.winner_to_match_id) {
    const { data: nextMatch } = await adminClient.from('tournament_matches')
      .select('status')
      .eq('id', match.winner_to_match_id)
      .single();

    if (nextMatch && nextMatch.status === 'completed') {
      throw new Error('Cannot edit result — downstream match already completed');
    }
  }

  const event = match.event as Record<string, unknown>;
  const doubles = isDoublesEvent(event.event_type as TournamentEventType);

  const winnerId = doubles
    ? (newWinnerSide === 'a' ? match.pair_a_id : match.pair_b_id)
    : (newWinnerSide === 'a' ? match.participant_a_id : match.participant_b_id);
  const loserId = doubles
    ? (newWinnerSide === 'a' ? match.pair_b_id : match.pair_a_id)
    : (newWinnerSide === 'a' ? match.participant_b_id : match.participant_a_id);

  const winnerField = doubles ? 'winner_pair_id' : 'winner_participant_id';
  const loserField = doubles ? 'loser_pair_id' : 'loser_participant_id';

  // Reverse any prior Elo changes so we can recompute with the corrected winner.
  if (match.elo_snapshot) {
    await reverseEloSnapshot(adminClient, match);
  }

  await adminClient.from('tournament_matches').update({
    scores: newScores,
    [winnerField]: winnerId,
    [loserField]: loserId,
    result_entered_by: admin.id,
    result_entered_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', matchId);

  // Re-advance winner if changed
  if (match.winner_to_match_id) {
    const advanceField = doubles
      ? (match.winner_to_position === 'a' ? 'pair_a_id' : 'pair_b_id')
      : (match.winner_to_position === 'a' ? 'participant_a_id' : 'participant_b_id');

    await adminClient.from('tournament_matches')
      .update({ [advanceField]: winnerId })
      .eq('id', match.winner_to_match_id);
  }

  // Reapply Elo with corrected winner. Skipped for walkovers (no Elo impact)
  // and voided matches.
  if (match.status === 'completed') {
    await applyTournamentMatchElo(matchId);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    action: 'result_edited',
    performed_by: admin.id,
    details: { old_scores: match.scores, new_scores: newScores, new_winner_side: newWinnerSide },
  });

  revalidateEventPaths(event.tournament_id as string, match.event_id as string);
}

// ============================================================
// Elo Integration
// ============================================================

async function applyTournamentMatchElo(matchId: string) {
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (!match || match.status === 'voided' || match.is_bye) return;

  const event = match.event as Record<string, unknown>;
  const doubles = isDoublesEvent(event.event_type as TournamentEventType);
  const matchFormat = event.match_format as TournamentMatchFormat;
  const eloMultiplier = Number(event.elo_multiplier) || 1.25;
  const eloFormat = toEloFormat(matchFormat);
  const formatWeight = getFormatWeight(eloFormat);

  // Per-player snapshot of this match's Elo change, persisted on the match row.
  // Enables perfect reversal in undoMatchResult / editMatchResult for both singles
  // and doubles regardless of how much state has drifted since.
  const snapshotEntries: Array<{
    player_id: string;
    before: number;
    after: number;
    delta: number;
  }> = [];
  const snapshotDiscipline: 'singles' | 'doubles' = doubles ? 'doubles' : 'singles';

  const nowIso = new Date().toISOString();

  if (doubles) {
    // For doubles, update both players in winning and losing pairs
    const winnerId = match.winner_pair_id;
    const loserId = match.loser_pair_id;
    if (!winnerId || !loserId) return;

    // Fetch both pairs in parallel.
    const [{ data: winnerPair }, { data: loserPair }] = await Promise.all([
      adminClient.from('tournament_pairs')
        .select('player1_id, player2_id, combined_elo')
        .eq('id', winnerId).single(),
      adminClient.from('tournament_pairs')
        .select('player1_id, player2_id, combined_elo')
        .eq('id', loserId).single(),
    ]);

    if (!winnerPair || !loserPair) return;

    const winnerElo = winnerPair.combined_elo ?? 1200;
    const loserElo = loserPair.combined_elo ?? 1200;

    // Single batched ratings fetch for all 4 players
    const allPlayerIds = [winnerPair.player1_id, winnerPair.player2_id, loserPair.player1_id, loserPair.player2_id];
    const { data: ratings } = await adminClient.from('ratings')
      .select('player_id, doubles_elo, doubles_provisional, doubles_matches_played')
      .in('player_id', allPlayerIds);

    const computeFor = (playerId: string, opponentElo: number, won: boolean) => {
      const rating = ratings?.find(r => r.player_id === playerId);
      const before = rating?.doubles_elo ?? 1200;
      const k = getKFactor('doubles', rating?.doubles_provisional ?? true, rating?.doubles_matches_played);
      const result = calculateEloUpdate({
        playerRating: before,
        opponentRating: opponentElo,
        kFactor: k,
        formatWeight,
        eventMultiplier: eloMultiplier,
        won,
      });
      snapshotEntries.push({ player_id: playerId, before, after: result.newRating, delta: result.delta });
      return { playerId, newRating: result.newRating };
    };

    const computed = [
      computeFor(winnerPair.player1_id, loserElo, true),
      computeFor(winnerPair.player2_id, loserElo, true),
      computeFor(loserPair.player1_id, winnerElo, false),
      computeFor(loserPair.player2_id, winnerElo, false),
    ];

    // Issue all 4 rating UPDATEs in parallel
    const updateResults = await Promise.allSettled(
      computed.map(c => adminClient.from('ratings')
        .update({ doubles_elo: c.newRating, updated_at: nowIso })
        .eq('player_id', c.playerId))
    );
    for (const r of updateResults) {
      if (r.status === 'rejected') Sentry.captureException(r.reason);
    }
  } else {
    // Singles
    const winnerId = match.winner_participant_id;
    const loserId = match.loser_participant_id;
    if (!winnerId || !loserId) return;

    // Fetch both participants in parallel
    const [{ data: winnerP }, { data: loserP }] = await Promise.all([
      adminClient.from('tournament_participants')
        .select('player_id, elo_before')
        .eq('id', winnerId).single(),
      adminClient.from('tournament_participants')
        .select('player_id, elo_before')
        .eq('id', loserId).single(),
    ]);

    if (!winnerP || !loserP) return;

    // Single batched ratings fetch
    const { data: ratings } = await adminClient.from('ratings')
      .select('player_id, singles_elo, singles_provisional, singles_matches_played')
      .in('player_id', [winnerP.player_id, loserP.player_id]);

    const winnerRating = ratings?.find(r => r.player_id === winnerP.player_id);
    const loserRating = ratings?.find(r => r.player_id === loserP.player_id);

    const winnerElo = winnerRating?.singles_elo ?? winnerP.elo_before ?? 1200;
    const loserElo = loserRating?.singles_elo ?? loserP.elo_before ?? 1200;

    const winK = getKFactor('singles', winnerRating?.singles_provisional ?? true, winnerRating?.singles_matches_played);
    const loseK = getKFactor('singles', loserRating?.singles_provisional ?? true, loserRating?.singles_matches_played);

    const winResult = calculateEloUpdate({
      playerRating: winnerElo,
      opponentRating: loserElo,
      kFactor: winK,
      formatWeight,
      eventMultiplier: eloMultiplier,
      won: true,
    });

    const loseResult = calculateEloUpdate({
      playerRating: loserElo,
      opponentRating: winnerElo,
      kFactor: loseK,
      formatWeight,
      eventMultiplier: eloMultiplier,
      won: false,
    });

    // Issue all 4 UPDATEs in parallel (2 ratings + 2 participants)
    const updateResults = await Promise.allSettled([
      adminClient.from('ratings')
        .update({ singles_elo: winResult.newRating, updated_at: nowIso })
        .eq('player_id', winnerP.player_id),
      adminClient.from('ratings')
        .update({ singles_elo: loseResult.newRating, updated_at: nowIso })
        .eq('player_id', loserP.player_id),
      adminClient.from('tournament_participants')
        .update({ elo_after: winResult.newRating, elo_change: winResult.delta })
        .eq('id', winnerId),
      adminClient.from('tournament_participants')
        .update({ elo_after: loseResult.newRating, elo_change: loseResult.delta })
        .eq('id', loserId),
    ]);
    for (const r of updateResults) {
      if (r.status === 'rejected') Sentry.captureException(r.reason);
    }

    snapshotEntries.push({ player_id: winnerP.player_id, before: winnerElo, after: winResult.newRating, delta: winResult.delta });
    snapshotEntries.push({ player_id: loserP.player_id, before: loserElo, after: loseResult.newRating, delta: loseResult.delta });
  }

  // Persist snapshot on the match row so undo/edit can reverse it perfectly.
  await adminClient.from('tournament_matches')
    .update({ elo_snapshot: { discipline: snapshotDiscipline, entries: snapshotEntries } })
    .eq('id', matchId);
}

// Reverse a previously applied Elo snapshot for a match. Resets ratings to their
// pre-match values and clears participant elo_after/elo_change for singles.
async function reverseEloSnapshot(
  adminClient: ReturnType<typeof createAdminClient>,
  match: Record<string, unknown>
) {
  const snapshot = match.elo_snapshot as {
    discipline: 'singles' | 'doubles';
    entries: Array<{ player_id: string; before: number; after: number; delta: number }>;
  } | null;
  if (!snapshot || !snapshot.entries?.length) return;

  const ratingColumn = snapshot.discipline === 'doubles' ? 'doubles_elo' : 'singles_elo';
  const playerIds = snapshot.entries.map(e => e.player_id);

  // Single batched fetch for all current ratings.
  const { data: currentRows, error: fetchErr } = await adminClient.from('ratings')
    .select(`player_id, ${ratingColumn}`)
    .in('player_id', playerIds);
  if (fetchErr) {
    Sentry.captureException(fetchErr);
    return;
  }

  const currentMap = new Map<string, number>();
  for (const row of currentRows ?? []) {
    const r = row as Record<string, unknown>;
    const elo = r[ratingColumn] as number | undefined;
    if (elo !== undefined) currentMap.set(r.player_id as string, elo);
  }

  const nowIso = new Date().toISOString();

  // Issue all reversal UPDATEs in parallel — independent rows, no contention.
  // Apply inverse delta regardless of drift so net effect is zero even if
  // intermediate matches moved the rating.
  const updatePromises = snapshot.entries
    .filter(e => currentMap.has(e.player_id))
    .map(e => adminClient.from('ratings')
      .update({ [ratingColumn]: (currentMap.get(e.player_id) as number) - e.delta, updated_at: nowIso })
      .eq('player_id', e.player_id));

  // Clear singles participant snapshots in the same parallel batch.
  if (snapshot.discipline === 'singles') {
    const participantIds = [match.winner_participant_id, match.loser_participant_id]
      .filter((x): x is string => typeof x === 'string' && x.length > 0);
    if (participantIds.length > 0) {
      updatePromises.push(adminClient.from('tournament_participants')
        .update({ elo_after: null, elo_change: null })
        .in('id', participantIds));
    }
  }

  // Clear the snapshot on the match row in the same batch.
  updatePromises.push(adminClient.from('tournament_matches')
    .update({ elo_snapshot: null })
    .eq('id', match.id as string));

  const results = await Promise.allSettled(updatePromises);
  for (const r of results) {
    if (r.status === 'rejected') Sentry.captureException(r.reason);
  }
}

// ============================================================
// Placement Bonuses & Finalize
// ============================================================

export async function applyPlacementBonuses(eventId: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.status !== 'completed') throw new Error('Event must be completed first');
  if (!event.placement_bonus_enabled) throw new Error('Placement bonuses not enabled for this event');

  const doubles = isDoublesEvent(event.event_type);
  const bonuses = doubles ? PLACEMENT_BONUSES.doubles : PLACEMENT_BONUSES.singles;

  // Pure helper — pull bonus from final_position so the batched paths below stay tidy.
  const bonusFor = (pos: number | null | undefined): number => {
    if (!pos) return 0;
    if (pos === 1) return bonuses.champion;
    if (pos === 2) return bonuses.finalist;
    if (pos <= 4) return bonuses.semifinalist;
    if (pos <= 8) return bonuses.quarterfinalist;
    return 0;
  };

  const nowIso = new Date().toISOString();

  if (doubles) {
    const { data: pairs } = await adminClient.from('tournament_pairs')
      .select('id, player1_id, player2_id, final_position')
      .eq('event_id', eventId)
      .not('final_position', 'is', null);

    // Build playerId → bonus map (a player may appear in multiple pairs, sum bonuses).
    const playerBonus = new Map<string, number>();
    for (const pair of pairs ?? []) {
      const bonus = bonusFor(pair.final_position);
      if (bonus <= 0) continue;
      for (const pid of [pair.player1_id, pair.player2_id]) {
        playerBonus.set(pid, (playerBonus.get(pid) ?? 0) + bonus);
      }
    }

    if (playerBonus.size > 0) {
      // Single batched fetch for all affected ratings.
      const playerIds = [...playerBonus.keys()];
      const { data: ratings } = await adminClient.from('ratings')
        .select('player_id, doubles_elo')
        .in('player_id', playerIds);
      const ratingMap = new Map<string, number>();
      for (const r of ratings ?? []) ratingMap.set(r.player_id, r.doubles_elo ?? 1200);

      // Parallel UPDATEs — one row per player, no contention.
      const results = await Promise.allSettled(
        [...playerBonus.entries()].map(([pid, bonus]) =>
          adminClient.from('ratings')
            .update({ doubles_elo: (ratingMap.get(pid) ?? 1200) + bonus, updated_at: nowIso })
            .eq('player_id', pid)
        )
      );
      for (const r of results) {
        if (r.status === 'rejected') Sentry.captureException(r.reason);
      }
    }
  } else {
    const { data: participants } = await adminClient.from('tournament_participants')
      .select('id, player_id, final_position, elo_change')
      .eq('event_id', eventId)
      .not('final_position', 'is', null);

    const eligible = (participants ?? [])
      .map(p => ({ ...p, bonus: bonusFor(p.final_position) }))
      .filter(p => p.bonus > 0);

    if (eligible.length > 0) {
      const playerIds = eligible.map(p => p.player_id);
      const { data: ratings } = await adminClient.from('ratings')
        .select('player_id, singles_elo')
        .in('player_id', playerIds);
      const ratingMap = new Map<string, number>();
      for (const r of ratings ?? []) ratingMap.set(r.player_id, r.singles_elo ?? 1200);

      // Parallel: rating UPDATE + participant elo_change UPDATE for each row.
      // Wrap in Promise.resolve so the Supabase thenable plays nicely with allSettled typing.
      const promises: PromiseLike<unknown>[] = [];
      for (const p of eligible) {
        promises.push(Promise.resolve(adminClient.from('ratings')
          .update({ singles_elo: (ratingMap.get(p.player_id) ?? 1200) + p.bonus, updated_at: nowIso })
          .eq('player_id', p.player_id)));
        const prevChange = (p.elo_change as number | null) ?? 0;
        promises.push(Promise.resolve(adminClient.from('tournament_participants')
          .update({ elo_change: prevChange + p.bonus })
          .eq('id', p.id)));
      }
      const results = await Promise.allSettled(promises);
      for (const r of results) {
        if (r.status === 'rejected') Sentry.captureException(r.reason);
      }
    }
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'placement_bonuses_applied',
    performed_by: admin.id,
  });

  revalidateEventPaths(event.tournament_id, eventId);
}

export async function finalizeEvent(eventId: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.status !== 'live') throw new Error('Event must be live to finalize');

  const doubles = isDoublesEvent(event.event_type);

  // Check all matches are complete — single query selects all incomplete rows
  // with the participant fields we need to filter unused bracket slots in memory.
  const { data: incompleteMatches } = await adminClient.from('tournament_matches')
    .select('id, participant_a_id, participant_b_id, pair_a_id, pair_b_id')
    .eq('event_id', eventId)
    .not('status', 'in', '("completed","walkover","voided","bye")')
    .not('is_bye', 'eq', true);

  const realIncomplete = (incompleteMatches ?? []).filter(m => {
    return doubles
      ? (m.pair_a_id || m.pair_b_id)
      : (m.participant_a_id || m.participant_b_id);
  });

  if (realIncomplete.length > 0) {
    throw new Error(`${realIncomplete.length} match(es) still incomplete`);
  }

  // Assign final positions based on tournament format. We compute the full
  // (id → position) map in memory then issue one parallel batch of UPDATEs.
  const table = doubles ? 'tournament_pairs' : 'tournament_participants';
  const positionMap = new Map<string, number>();

  if (event.format === 'single_elimination') {
    const { data: matches } = await adminClient.from('tournament_matches')
      .select('round_number, winner_pair_id, loser_pair_id, winner_participant_id, loser_participant_id')
      .eq('event_id', eventId)
      .in('status', ['completed', 'walkover'])
      .order('round_number', { ascending: false });

    if (matches && matches.length > 0) {
      const totalRounds = Math.max(...matches.map(m => m.round_number));

      for (const m of matches) {
        const roundsFromFinal = totalRounds - m.round_number;
        const loserPosition = roundsFromFinal === 0 ? 2 : Math.pow(2, roundsFromFinal) + 1;

        const loserId = (doubles ? m.loser_pair_id : m.loser_participant_id) as string | null;
        const winnerId = (doubles ? m.winner_pair_id : m.winner_participant_id) as string | null;

        // First-write-wins for losers (later rounds set position before earlier ones).
        if (loserId && !positionMap.has(loserId)) positionMap.set(loserId, loserPosition);
        if (m.round_number === totalRounds && winnerId) positionMap.set(winnerId, 1);
      }
    }
  } else {
    // Round robin: compute standings and assign positions
    const standings = await computeRoundRobinStandings(eventId);
    standings.forEach((s, i) => positionMap.set(s!.id, i + 1));
  }

  if (positionMap.size > 0) {
    const positionResults = await Promise.allSettled(
      [...positionMap.entries()].map(([id, pos]) =>
        Promise.resolve(adminClient.from(table).update({ final_position: pos }).eq('id', id))
      )
    );
    for (const r of positionResults) {
      if (r.status === 'rejected') Sentry.captureException(r.reason);
    }
  }

  // Assign points based on format. Compute (id → points) in memory then issue
  // one parallel batch of UPDATEs.
  const pointsMap = new Map<string, number>();
  if (event.format === 'single_elimination') {
    // Position-based points: 1st=100, 2nd=75, 3rd-4th=50, 5th-8th=25, else 10
    const { data: allEntries } = await adminClient.from(table)
      .select('id, final_position')
      .eq('event_id', eventId)
      .not('final_position', 'is', null);
    for (const entry of allEntries ?? []) {
      const pos = entry.final_position!;
      let pts: number;
      if (pos === 1) pts = 100;
      else if (pos === 2) pts = 75;
      else if (pos <= 4) pts = 50;
      else if (pos <= 8) pts = 25;
      else pts = 10;
      pointsMap.set(entry.id, pts);
    }
  } else {
    // Round Robin: 3 points per win, 1 point for participation
    const [rrMatchesRes, allEntriesRes] = await Promise.all([
      adminClient.from('tournament_matches')
        .select('winner_pair_id, winner_participant_id')
        .eq('event_id', eventId)
        .in('status', ['completed', 'walkover']),
      adminClient.from(table)
        .select('id')
        .eq('event_id', eventId)
        .not('status', 'in', '("withdrawn","disqualified")'),
    ]);
    for (const e of allEntriesRes.data ?? []) pointsMap.set(e.id, 1); // 1 participation point
    for (const m of rrMatchesRes.data ?? []) {
      const winnerId = (doubles ? m.winner_pair_id : m.winner_participant_id) as string | null;
      if (winnerId && pointsMap.has(winnerId)) {
        pointsMap.set(winnerId, (pointsMap.get(winnerId) ?? 0) + 3);
      }
    }
  }

  if (pointsMap.size > 0) {
    const pointsResults = await Promise.allSettled(
      [...pointsMap.entries()].map(([id, pts]) =>
        Promise.resolve(adminClient.from(table).update({ points: pts }).eq('id', id))
      )
    );
    for (const r of pointsResults) {
      if (r.status === 'rejected') Sentry.captureException(r.reason);
    }
  }

  // Set event to completed
  await adminClient.from('tournament_events')
    .update({ status: 'completed', updated_at: new Date().toISOString() })
    .eq('id', eventId);

  // Apply placement bonuses if enabled
  if (event.placement_bonus_enabled) {
    await applyPlacementBonuses(eventId);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'event_finalized',
    performed_by: admin.id,
  });

  // Notify all participants that event is completed
  const finalPlayerIds: string[] = [];
  if (doubles) {
    const { data: allPairs } = await adminClient.from('tournament_pairs')
      .select('player1_id, player2_id')
      .eq('event_id', eventId)
      .not('status', 'in', '("withdrawn","disqualified")');
    for (const pair of allPairs ?? []) {
      finalPlayerIds.push(pair.player1_id, pair.player2_id);
    }
  } else {
    const { data: allParts } = await adminClient.from('tournament_participants')
      .select('player_id')
      .eq('event_id', eventId)
      .not('status', 'in', '("withdrawn","disqualified")');
    for (const p of allParts ?? []) {
      finalPlayerIds.push(p.player_id);
    }
  }
  const { data: tInfo } = await adminClient.from('tournaments').select('name').eq('id', event.tournament_id).single();
  await notifyPlayers(adminClient, finalPlayerIds,
    'Tournament Completed',
    `${tInfo?.name ?? 'Tournament'} has been finalized. Check the results and your updated Elo rating!`,
    { event_id: eventId, tournament_id: event.tournament_id },
    'tournament_event_completed'
  );

  revalidateEventPaths(event.tournament_id, eventId);
}

// ============================================================
// Round Robin Standings (utility)
// ============================================================

async function computeRoundRobinStandings(eventId: string) {
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) return [];

  const doubles = isDoublesEvent(event.event_type);

  // Get all completed matches
  const { data: matches } = await adminClient.from('tournament_matches')
    .select('*')
    .eq('event_id', eventId)
    .in('status', ['completed', 'walkover']);

  // Get all entries
  let entries: Array<{ id: string; name: string }> = [];
  if (doubles) {
    const { data: pairs } = await adminClient.from('tournament_pairs')
      .select('id, pair_name')
      .eq('event_id', eventId)
      .not('status', 'in', '("withdrawn","disqualified")');
    entries = (pairs ?? []).map(p => ({ id: p.id, name: p.pair_name ?? 'Unnamed' }));
  } else {
    const { data: participants } = await adminClient.from('tournament_participants')
      .select('id, player:players(full_name)')
      .eq('event_id', eventId)
      .not('status', 'in', '("withdrawn","disqualified")');
    entries = (participants ?? []).map(p => ({
      id: p.id,
      name: ((p.player as unknown as Record<string, unknown>)?.full_name as string) ?? 'Unknown',
    }));
  }

  // Build standings
  const stats: Record<string, {
    id: string;
    name: string;
    wins: number;
    losses: number;
    pointsFor: number;
    pointsAgainst: number;
    gamesFor: number;
    gamesAgainst: number;
    // Head-to-head wins against every other entry — used as a tiebreaker
    // before resorting to point differentials.
    h2h: Record<string, number>;
  }> = {};

  for (const e of entries) {
    stats[e.id] = { id: e.id, name: e.name, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, gamesFor: 0, gamesAgainst: 0, h2h: {} };
  }

  for (const m of matches ?? []) {
    const aId = doubles ? m.pair_a_id : m.participant_a_id;
    const bId = doubles ? m.pair_b_id : m.participant_b_id;
    if (!aId || !bId || !stats[aId] || !stats[bId]) continue;

    const winnerId = doubles ? m.winner_pair_id : m.winner_participant_id;
    if (winnerId === aId) {
      stats[aId].wins++;
      stats[bId].losses++;
      stats[aId].h2h[bId] = (stats[aId].h2h[bId] ?? 0) + 1;
    } else if (winnerId === bId) {
      stats[bId].wins++;
      stats[aId].losses++;
      stats[bId].h2h[aId] = (stats[bId].h2h[aId] ?? 0) + 1;
    }

    // Sum points from scores
    const scores = (m.scores as Array<{ a: number; b: number }>) ?? [];
    for (const g of scores) {
      stats[aId].pointsFor += g.a;
      stats[aId].pointsAgainst += g.b;
      stats[bId].pointsFor += g.b;
      stats[bId].pointsAgainst += g.a;

      if (g.a > g.b) {
        stats[aId].gamesFor++;
        stats[bId].gamesAgainst++;
      } else if (g.b > g.a) {
        stats[bId].gamesFor++;
        stats[aId].gamesAgainst++;
      }
    }
  }

  // Sort: wins desc, head-to-head wins desc (pairwise), games differential desc,
  // point differential desc, points for desc. Head-to-head only breaks ties
  // between the two entries being compared — it's not transitive, so multi-way
  // ties fall through to the differential tiebreakers.
  return Object.values(stats).sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    const h2h = (b.h2h[a.id] ?? 0) - (a.h2h[b.id] ?? 0);
    if (h2h !== 0) return h2h;
    const aGameDiff = a.gamesFor - a.gamesAgainst;
    const bGameDiff = b.gamesFor - b.gamesAgainst;
    if (bGameDiff !== aGameDiff) return bGameDiff - aGameDiff;
    const aDiff = a.pointsFor - a.pointsAgainst;
    const bDiff = b.pointsFor - b.pointsAgainst;
    if (bDiff !== aDiff) return bDiff - aDiff;
    return b.pointsFor - a.pointsFor;
  });
}

// ============================================================
// Bulk check-in
// ============================================================

export async function bulkCheckIn(eventId: string, type: 'participants' | 'pairs') {
  const admin = await getAdminPlayer();
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
// Draw Lock/Unlock
// ============================================================

export async function lockDraw(eventId: string) {
  const admin = await getAdminPlayer();
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
  const admin = await getAdminPlayer();
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
  const admin = await getAdminPlayer();
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

// ============================================================
// Undo Match Result
// ============================================================

export async function undoMatchResult(matchId: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (!match) throw new Error('Match not found');
  if (match.status !== 'completed' && match.status !== 'walkover') {
    throw new Error('Match has no result to undo');
  }

  const event = match.event as Record<string, unknown>;
  const doubles = isDoublesEvent(event.event_type as TournamentEventType);

  // Check no downstream matches have results
  if (match.winner_to_match_id) {
    const { data: nextMatch } = await adminClient.from('tournament_matches')
      .select('status')
      .eq('id', match.winner_to_match_id)
      .single();

    if (nextMatch && (nextMatch.status === 'completed' || nextMatch.status === 'walkover')) {
      throw new Error('Cannot undo — downstream match already has a result. Undo that match first.');
    }
  }

  // Reverse Elo changes (both singles and doubles) using snapshot persisted at apply time.
  // Falls back to legacy elo_before behaviour for singles matches that pre-date the snapshot column.
  if (match.elo_snapshot) {
    await reverseEloSnapshot(adminClient, match);
  } else if (!doubles) {
    const winnerId = match.winner_participant_id;
    const loserId = match.loser_participant_id;

    if (winnerId) {
      const { data: winnerP } = await adminClient.from('tournament_participants')
        .select('player_id, elo_before')
        .eq('id', winnerId).single();
      if (winnerP?.elo_before != null) {
        await adminClient.from('ratings')
          .update({ singles_elo: winnerP.elo_before, updated_at: new Date().toISOString() })
          .eq('player_id', winnerP.player_id);
        await adminClient.from('tournament_participants')
          .update({ elo_after: null, elo_change: null })
          .eq('id', winnerId);
      }
    }

    if (loserId) {
      const { data: loserP } = await adminClient.from('tournament_participants')
        .select('player_id, elo_before')
        .eq('id', loserId).single();
      if (loserP?.elo_before != null) {
        await adminClient.from('ratings')
          .update({ singles_elo: loserP.elo_before, updated_at: new Date().toISOString() })
          .eq('player_id', loserP.player_id);
        await adminClient.from('tournament_participants')
          .update({ elo_after: null, elo_change: null })
          .eq('id', loserId);
      }
    }
  }

  // Remove winner from next match if single elimination
  if (match.winner_to_match_id) {
    const advanceField = doubles
      ? (match.winner_to_position === 'a' ? 'pair_a_id' : 'pair_b_id')
      : (match.winner_to_position === 'a' ? 'participant_a_id' : 'participant_b_id');

    await adminClient.from('tournament_matches')
      .update({ [advanceField]: null, status: 'pending' })
      .eq('id', match.winner_to_match_id);
  }

  // Reset match itself
  const resetData: Record<string, unknown> = {
    scores: null,
    status: 'ready',
    walkover_winner: null,
    walkover_reason: null,
    result_entered_by: null,
    result_entered_at: null,
    updated_at: new Date().toISOString(),
  };

  if (doubles) {
    resetData.winner_pair_id = null;
    resetData.loser_pair_id = null;
  } else {
    resetData.winner_participant_id = null;
    resetData.loser_participant_id = null;
  }

  const { error } = await adminClient.from('tournament_matches')
    .update(resetData)
    .eq('id', matchId);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    action: 'result_undone',
    performed_by: admin.id,
    details: { previous_scores: match.scores },
  });

  revalidateEventPaths(event.tournament_id as string, match.event_id as string);
}
