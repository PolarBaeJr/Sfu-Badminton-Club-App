'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import type {
  TournamentEventType,
  TournamentEventFormat,
  TournamentMatchFormat,
  TournamentSeedingMethod,
  TournamentEventStatus,
} from '@badminton/shared';
import { isDoublesEvent } from '@badminton/shared';
import {
  getExecOrAdmin,
  revalidateEventPaths,
  assertTournamentNotSuspended,
  forfeitOutOfEventEntries,
} from './_internal';

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
  const admin = await getExecOrAdmin();
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
  const admin = await getExecOrAdmin();
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
  const admin = await getExecOrAdmin();
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
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

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

  // Anyone who withdrew while the draw was merely published is still sitting in
  // the bracket — bracket generation only ever saw a point-in-time snapshot of
  // who was in. Going live is the first moment their matches can be forfeited
  // properly (a walkover is rated, and rating anything before the event starts
  // is exactly what the result actions refuse to do), so settle them here
  // rather than let a live event open with matches nobody can play.
  let sweep = { forfeited: 0, unresolved: 0 };
  if (status === 'live') {
    sweep = await forfeitOutOfEventEntries(
      adminClient,
      eventId,
      isDoublesEvent(event.event_type),
      admin.id,
    );
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: `status_changed_to_${status}`,
    performed_by: admin.id,
    details: sweep.forfeited > 0 || sweep.unresolved > 0 ? sweep : undefined,
  });

  revalidateEventPaths(event.tournament_id, eventId);
}
