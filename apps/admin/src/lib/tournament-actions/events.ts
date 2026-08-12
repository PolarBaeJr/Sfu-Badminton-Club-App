'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import { runAction, type ActionResult } from '../action-result';
import {
  CUSTOM_FORMAT_BOUNDS,
  ExpectedError,
  isPoolToBracket,
  playsRoundRobin,
  statusStepsFor,
  currentPhase,
} from '@badminton/shared';
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

// The group shape (00106). The CHECK constraints are the real enforcement, same
// as the typed format above; this turns a violation into a sentence and pins
// the two rules the database cannot see:
//
//   * A KNOCKOUT HAS NO GROUPS. 00106 has a row-level CHECK for this, but
//     Postgres would report it as a constraint name — and the exec who hit it
//     picked "Single Elimination" three fields higher up.
//   * QUALIFIERS CANNOT EXCEED THE GROUP. Asking three out of a group of two is
//     not a format, and it is the kind of typo that only shows up as a bracket
//     with byes in it a week later. The group SIZE is not known yet at creation
//     time — nobody has entered — so this can only bound it against the ceiling
//     the schema allows, and the generator's own "fewer than 2 entries" refusal
//     catches the rest on the day.
function normalizeGroupShape(
  format: TournamentEventFormat | string | undefined,
  groupCount?: number | null,
  qualifiersPerGroup?: number | null,
): { group_count: number | null; qualifiers_per_group: number | null } {
  const g = groupCount == null || Number.isNaN(groupCount) ? null : Math.trunc(groupCount);
  const q = qualifiersPerGroup == null || Number.isNaN(qualifiersPerGroup) ? null : Math.trunc(qualifiersPerGroup);

  if (g !== null && (g < 1 || g > 32)) {
    throw new ExpectedError('Group count must be between 1 and 32. Leave it blank for an ordinary round robin.');
  }
  if (q !== null && (q < 1 || q > 16)) {
    throw new ExpectedError('Qualifiers per group must be between 1 and 16.');
  }
  if (g !== null && g > 1 && !playsRoundRobin(format)) {
    throw new ExpectedError('Only a round robin can be split into groups. A single-elimination event is one bracket.');
  }
  // Stored only when it means something, exactly as seed_by is: a
  // qualifiers-per-group left behind on a flat round robin is a stale choice
  // waiting to be read the day somebody sets a group count.
  //
  // A POOL-TO-BRACKET EVENT ALWAYS MEANS SOMETHING BY IT (00107), including
  // with no groups at all: its bracket phase is seeded out of its own pool, so
  // "how many qualify" has to be recorded whether the pool is flat or split.
  // A flat pool IS one group, so the same column says it — there is no second
  // column that could disagree, which is the whole reason not to add one.
  // The default differs because the question differs: 2 out of each of several
  // groups is the usual group stage, whereas 2 out of one flat pool is a final
  // and nothing else, so a flat pool defaults to a 4-strong knockout.
  if (isPoolToBracket(format)) {
    return { group_count: g, qualifiers_per_group: q ?? (g !== null && g > 1 ? 2 : 4) };
  }
  return { group_count: g, qualifiers_per_group: g !== null && g > 1 ? (q ?? 2) : null };
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
    group_count?: number | null;
    qualifiers_per_group?: number | null;
    max_participants?: number;
    seeding_method?: TournamentSeedingMethod;
    elo_multiplier?: number;
    placement_bonus_enabled?: boolean;
  }
) {
  const admin = await requireCapability('tournaments.manage.event.create.write');
  const adminClient = createAdminClient();

  const typedFormat = normalizeTypedFormat(config.games_per_match, config.points_per_game);
  const groupShape = normalizeGroupShape(config.format, config.group_count, config.qualifiers_per_group);
  // A pool_to_bracket event seeds from ITSELF — that is the format — so an
  // external source would be a second, contradictory field for the same
  // bracket. Refused rather than ignored: silently dropping a link the exec set
  // is how an event ends up drawn from a pool nobody expected.
  if (config.seeded_from_event_id && isPoolToBracket(config.format)) {
    throw new ExpectedError(
      'A Round Robin + Knockout event already plays its own pool, so it cannot also be seeded from another one. '
      + 'Use Single Elimination if the field is meant to come from a separate pool event.',
    );
  }
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
    //
    // A POOL-TO-BRACKET EVENT ALWAYS SETS IT (00107), and that is the fix for
    // the documented trap: assignPositionsAndPoints calls
    // computeRoundRobinStandings with no seedBy, so it defaults to 'wins',
    // while the bracket is seeded by seed_by. Across TWO events those can
    // disagree and final_position — which drives the placement-bonus ledger —
    // then comes from a different order than the draw did. Here there is ONE
    // row, so the column is always populated and both readers pass it. The
    // two-event path is deliberately left exactly as it is.
    seed_by: (config.seeded_from_event_id || isPoolToBracket(config.format))
      ? (config.seed_by ?? 'wins')
      : null,
    ...groupShape,
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
    group_count?: number | null;
    qualifiers_per_group?: number | null;
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

  /**
   * THE SEEDING METHOD IS NOT A FORMAT, and gating it like one made the draw's
   * only opt-out unreachable at the exact moment an exec wants it.
   *
   * Since the draw is made at random within the seeding tiers, `manual` is what
   * an exec picks when they have hand-set every seed and want the bracket those
   * numbers describe, redraw after redraw. They discover they want it by
   * pressing Regenerate and seeing a draw move — which is to say, AFTER a draw
   * exists, at which point both gates below refuse and the remedy on offer
   * ("void the matches first") is the very thing they were trying to avoid
   * doing twice.
   *
   * It is safe to let through because it changes nothing about the matches that
   * exist: unlike the match format or the pool it seeds from, it is read once,
   * by the NEXT generation, and generation has its own guards (a finalised
   * event refuses, an event with results refuses). Only on its own, though —
   * bundled with a format change it would carry that change past the gate.
   */
  const seedingMethodOnly = Object.keys(updates).length === 1 && 'seeding_method' in updates;

  // The old gate was status === 'registration', which locked the match format
  // the moment check-in opened — the exact point at which an exec discovers the
  // day is running late and wants to shorten the games. What actually must not
  // change is a format the draw has already been played under, so the gate is
  // now the existence of matches: no bracket, still editable.
  if (!seedingMethodOnly) {
    const { count: matchCount } = await adminClient.from('tournament_matches')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', eventId);
    if ((matchCount ?? 0) > 0) {
      throw new ExpectedError('This event already has a draw. Regenerate it after voiding the matches if the format really has to change.');
    }
    if (event.status !== 'registration' && event.status !== 'checkin') {
      throw new ExpectedError('Can only update events before the draw is made');
    }
  } else if (event.status === 'completed') {
    // A finalised event's draw can never be rebuilt (assertNotFinalised), so
    // changing how the next one would be made is a setting with no next one.
    throw new ExpectedError('This event has been finalised, so how its draw is made can no longer be changed.');
  }

  const patch: Record<string, unknown> = { ...updates };

  if ('games_per_match' in updates || 'points_per_game' in updates) {
    Object.assign(patch, normalizeTypedFormat(updates.games_per_match, updates.points_per_game));
  }

  // NO seeding_method-style carve-out for the group shape, deliberately. That
  // exemption exists because the seeding method is read once, by the next
  // generation, and changes nothing about the matches that already exist. The
  // group count is the opposite: the fixtures ARE the groups, so lowering it
  // would leave people playing a group the event says does not exist and the
  // standings partitioning differently from the schedule. The unmodified gate
  // above — no draw, still editable — is the right one, and its remedy
  // (regenerate the round robin) is the honest one here.
  if ('group_count' in updates || 'qualifiers_per_group' in updates) {
    Object.assign(patch, normalizeGroupShape(
      event.format as TournamentEventFormat,
      'group_count' in updates ? updates.group_count : (event as { group_count?: number | null }).group_count,
      'qualifiers_per_group' in updates ? updates.qualifiers_per_group : (event as { qualifiers_per_group?: number | null }).qualifiers_per_group,
    ));
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

  // Validate status transitions.
  //
  // DERIVED FROM statusStepsFor RATHER THAN WRITTEN OUT (00107), so the stepper
  // the exec looks at and the transitions the server allows are the same list.
  // A pool_to_bracket event has two more steps in the middle; every other
  // format's path is character for character what it was.
  //
  // Still forward-only and still one step at a time — that property is what
  // stops a redraw sending a running event backwards, and it now also stops a
  // pool being skipped: `checkin -> live` is not a transition on this format.
  const steps = statusStepsFor(event.format as string);
  const here = steps.indexOf(event.status as TournamentEventStatus);
  if (here < 0 || steps[here + 1] !== status) {
    throw new Error(`Invalid transition from ${event.status} to ${status}`);
  }

  // Guard: do not start a phase that has no matches.
  //
  // COUNTED WITHIN THE PHASE (00107). A pool_to_bracket event reaching `live`
  // already has a pool's worth of completed matches sitting in the same table,
  // so an unfiltered count would say "a draw exists" for a knockout that was
  // never generated, and the event would go live with nothing to play. The two
  // other formats have one phase and their matches carry phase NULL, so the
  // filter below is a no-op for them.
  const startingPhase = currentPhase(event.format as string, status);
  if (status === 'live' || status === 'pool_live') {
    let q = adminClient.from('tournament_matches')
      .select('*', { count: 'exact', head: true })
      .eq('event_id', eventId);
    if (startingPhase) q = q.eq('phase', startingPhase);
    const { count: matchCount } = await q;
    if (!matchCount || matchCount === 0) {
      throw new Error(
        startingPhase === 'pool'
          ? 'Cannot start the pool — no fixtures have been generated for it'
          : 'Cannot go live — no bracket has been generated for this event',
      );
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
  //
  // RUN AT BOTH pool_live AND live ON A POOL-TO-BRACKET EVENT, and that is not
  // a double forfeit. forfeitOpenMatchesForEntry only touches matches that are
  // still OPEN, so by the time the knockout starts every pool match it already
  // settled is completed or walked over and is skipped. What the second run
  // catches is the people who left BETWEEN the pool ending and the knockout
  // starting — they are in the bracket (the field is fixed when it is drawn)
  // and nothing else would ever forfeit them out of it.
  let sweep = { forfeited: 0, unresolved: 0 };
  if (status === 'live' || status === 'pool_live') {
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
