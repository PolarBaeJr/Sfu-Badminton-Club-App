'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import { runAction, type ActionResult } from '../action-result';
import { CUSTOM_FORMAT_BOUNDS, ExpectedError } from '@badminton/shared';
import type {
  TournamentEventType,
  TournamentEventFormat,
  TournamentMatchFormat,
  TournamentSeedingMethod,
  TournamentEventStatus,
  SeedBy,
} from '@badminton/shared';
import { isDoublesEvent } from '@badminton/shared';
import {
  requireCapability,
  revalidateEventPaths,
  assertTournamentNotSuspended,
  forfeitOutOfEventEntries,
} from './_internal';

// ============================================================
// Event Management
// ============================================================

// Typed match format (00046). The CHECK constraint is the real enforcement;
// this exists so a typo comes back as a sentence instead of a Postgres
// constraint name, and so a half-filled pair is caught here rather than
// silently meaning "custom points, preset games".
function normalizeTypedFormat(games?: number | null, points?: number | null): { games_per_match: number | null; points_per_game: number | null } {
  const g = games == null || Number.isNaN(games) ? null : Math.trunc(games);
  const p = points == null || Number.isNaN(points) ? null : Math.trunc(points);
  const { minGames, maxGames, minPoints, maxPoints } = CUSTOM_FORMAT_BOUNDS;
  if (g !== null && (g < minGames || g > maxGames || g % 2 === 0)) {
    throw new ExpectedError(`Games per match must be an odd number between ${minGames} and ${maxGames} — an even best-of cannot be decided.`);
  }
  if (p !== null && (p < minPoints || p > maxPoints)) {
    throw new ExpectedError(`Points per game must be between ${minPoints} and ${maxPoints}.`);
  }
  return { games_per_match: g, points_per_game: p };
}

// A seeding link is only meaningful within one tournament, and the self-seed
// case would deadlock generation on standings it is supposed to produce.
async function assertSeedSourceUsable(
  adminClient: ReturnType<typeof createAdminClient>,
  tournamentId: string,
  eventId: string | null,
  sourceId: string,
) {
  if (eventId && sourceId === eventId) throw new ExpectedError('An event cannot seed from itself.');
  const { data: source } = await adminClient.from('tournament_events')
    .select('id, tournament_id, seeded_from_event_id')
    .eq('id', sourceId)
    .maybeSingle();
  if (!source) throw new ExpectedError('That pool event does not exist.');
  if (source.tournament_id !== tournamentId) throw new ExpectedError('A pool must belong to the same tournament.');
  // One hop is all the model supports; a source that itself seeds from
  // somewhere could be pointed back at this event and make a cycle.
  if (eventId && source.seeded_from_event_id === eventId) {
    throw new ExpectedError('Those two events would seed from each other.');
  }
}

async function createTournamentEventImpl(
  tournamentId: string,
  config: {
    event_type: TournamentEventType;
    format: TournamentEventFormat;
    match_format?: TournamentMatchFormat;
    games_per_match?: number | null;
    points_per_game?: number | null;
    seeded_from_event_id?: string | null;
    seed_by?: SeedBy | null;
    max_participants?: number;
    seeding_method?: TournamentSeedingMethod;
    elo_multiplier?: number;
    placement_bonus_enabled?: boolean;
  }
) {
  const admin = await requireCapability('tournaments.manage.event.create.write');
  const adminClient = createAdminClient();

  const typedFormat = normalizeTypedFormat(config.games_per_match, config.points_per_game);
  if (config.seeded_from_event_id) {
    await assertSeedSourceUsable(adminClient, tournamentId, null, config.seeded_from_event_id);
  }

  const { data, error } = await adminClient.from('tournament_events').insert({
    tournament_id: tournamentId,
    event_type: config.event_type,
    format: config.format,
    match_format: config.match_format ?? 'best_of_3_to_21',
    ...typedFormat,
    seeded_from_event_id: config.seeded_from_event_id ?? null,
    // seed_by is only read when a source is set; storing it without one would
    // leave a stale choice behind if a source is added later.
    seed_by: config.seeded_from_event_id ? (config.seed_by ?? 'wins') : null,
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

async function updateTournamentEventImpl(
  eventId: string,
  updates: {
    match_format?: TournamentMatchFormat;
    games_per_match?: number | null;
    points_per_game?: number | null;
    seeded_from_event_id?: string | null;
    seed_by?: SeedBy | null;
    max_participants?: number | null;
    seeding_method?: TournamentSeedingMethod;
    elo_multiplier?: number;
    placement_bonus_enabled?: boolean;
  }
) {
  const admin = await requireCapability('tournaments.manage.event.update.write');
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');

  // The old gate was status === 'registration', which locked the match format
  // the moment check-in opened — the exact point at which an exec discovers the
  // day is running late and wants to shorten the games. What actually must not
  // change is a format the draw has already been played under, so the gate is
  // now the existence of matches: no bracket, still editable.
  const { count: matchCount } = await adminClient.from('tournament_matches')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', eventId);
  if ((matchCount ?? 0) > 0) {
    throw new ExpectedError('This event already has a draw. Regenerate it after voiding the matches if the format really has to change.');
  }
  if (event.status !== 'registration' && event.status !== 'checkin') {
    throw new ExpectedError('Can only update events before the draw is made');
  }

  const patch: Record<string, unknown> = { ...updates };

  if ('games_per_match' in updates || 'points_per_game' in updates) {
    Object.assign(patch, normalizeTypedFormat(updates.games_per_match, updates.points_per_game));
  }

  if ('seeded_from_event_id' in updates) {
    const sourceId = updates.seeded_from_event_id;
    if (sourceId) {
      await assertSeedSourceUsable(adminClient, event.tournament_id, eventId, sourceId);
      patch.seed_by = updates.seed_by ?? 'wins';
    } else {
      patch.seeded_from_event_id = null;
      patch.seed_by = null;
    }
  }

  const { error } = await adminClient.from('tournament_events')
    .update({ ...patch, updated_at: new Date().toISOString() })
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
    details: patch,
  });

  revalidateEventPaths(event.tournament_id, eventId);
}

// Public entry points. The format validation these two now carry is only
// useful if the exec can read it, and Next.js replaces anything thrown out of a
// Server Action in production with a generic message — so the refusal comes
// back as a value, and runAction keeps it out of Sentry.
export async function createTournamentEvent(
  tournamentId: string,
  config: Parameters<typeof createTournamentEventImpl>[1],
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const created = await createTournamentEventImpl(tournamentId, config);
    return { id: created.id as string };
  });
}

export async function updateTournamentEvent(
  eventId: string,
  updates: Parameters<typeof updateTournamentEventImpl>[1],
): Promise<ActionResult<void>> {
  return runAction(async () => { await updateTournamentEventImpl(eventId, updates); });
}

export async function deleteTournamentEvent(eventId: string) {
  const admin = await requireCapability('tournaments.manage.event.delete.write');
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
  const admin = await requireCapability('tournaments.manage.event.status.write');
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
