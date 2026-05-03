'use server';

import { createAdminClient, getAuthenticatedAdmin } from '../supabase-server';
import { revalidatePath } from 'next/cache';
import type {
  TournamentEventType,
  TournamentEventFormat,
  TournamentMatchFormat,
  TournamentSeedingMethod,
  TournamentEventStatus,
} from '@badminton/shared';
import { logError } from '@badminton/shared';
import { logAudit, revalidateEventPaths } from './_helpers';

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
  const admin = await getAuthenticatedAdmin();
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
    logError('tournament.event', error);
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
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.status !== 'registration') throw new Error('Can only update events in registration status');

  const { error } = await adminClient.from('tournament_events')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', eventId);

  if (error) {
    logError('tournament.event', error);
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
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.status !== 'registration') throw new Error('Can only delete events in registration status');

  const { error } = await adminClient.from('tournament_events').delete().eq('id', eventId);
  if (error) {
    logError('tournament.event', error);
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
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');

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
    logError('tournament.event', error);
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
