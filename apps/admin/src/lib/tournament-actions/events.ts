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
  endsInKnockout,
  SEED_SKIP_BOUNDS,
  ELO_MULTIPLIER_BOUNDS,
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

// How many top seeds must skip the first round (00124).
//
// THE FIELD-DEPENDENT CEILING IS NOT CHECKED HERE, DELIBERATELY, and it is the
// same call normalizeGroupShape makes two functions up. The real ceiling is
// maxFirstRoundByes(entrants) — a field of 20 sits in a 32-draw and can give 12
// seeds a bye, a field of 16 can give none at all — and at creation time nobody
// has entered, so bounding against the current headcount would refuse an exec
// who sets 4 with three people registered and sixty expected. The CHECK in
// 00124 bounds what can be STORED; generateSingleEliminationBracket refuses what
// the field cannot deliver, on the day, when the number is real.
//
// The round-robin refusal IS checked here, because it does not depend on the
// field: a round robin has no first round to skip. 00124 has a row-level CHECK
// for it, but Postgres would report a constraint name to an exec who picked the
// format several fields higher up.
function normalizeSeedSkip(
  format: TournamentEventFormat | string | undefined,
  seedSkipCount?: number | null,
): { seed_skip_count: number } {
  const n = seedSkipCount == null || Number.isNaN(seedSkipCount) ? 0 : Math.trunc(seedSkipCount);
  const { min, max } = SEED_SKIP_BOUNDS;
  if (n < min || n > max) {
    throw new ExpectedError(
      `The number of seeds that skip the first round must be between ${min} and ${max}. Leave it at 0 for an ordinary draw.`,
    );
  }
  if (n > 0 && !endsInKnockout(format)) {
    throw new ExpectedError(
      'A round robin has no first round to skip — everybody plays everybody. Only an event that ends in a bracket can give its top seeds a bye.',
    );
  }
  return { seed_skip_count: n };
}

// How hard this event moves ratings, relative to a rated challenge.
//
// THE COLUMN HAS NO CHECK CONSTRAINT, which is why this exists at all: the
// number reaches apply_tournament_match_rating through eventEloMultiplier()
// (`Number(raw) || 1.25`), and that coercion is deliberately faithful to the
// rating path rather than defensive. A negative therefore inverts the whole
// event, a 0 silently becomes 1.25, and a slipped decimal point multiplies
// every delta in the draw by a hundred. See ELO_MULTIPLIER_BOUNDS for the
// argument behind each end of the range.
//
// Rounded to the column's own scale rather than refused for having three
// decimals: DECIMAL(4,2) would round 1.259 to 1.26 on the way in, so refusing
// would be pedantry about a value the database is happy to store, but rounding
// HERE means the number the exec is told about is the number that lands.
function normalizeEloMultiplier(raw?: number | null): number | undefined {
  if (raw == null) return undefined;
  const { min, max } = ELO_MULTIPLIER_BOUNDS;
  if (!Number.isFinite(raw)) {
    throw new ExpectedError('The Elo multiplier has to be a number.');
  }
  if (raw === 0) {
    // Named separately from the range refusal because 0 is the one value an
    // exec reaches for ON PURPOSE, meaning something the field cannot express —
    // and the only one whose behaviour is the opposite of how it reads.
    throw new ExpectedError(
      'An Elo multiplier of 0 does not make an event unrated — the rating path reads 0 as "not set" and uses 1.25 instead. '
      + `Set it to ${min} if this event should barely count towards ratings.`,
    );
  }
  if (raw < 0) {
    // Also worth its own sentence: the range message below would read as a
    // formatting complaint, when what a negative actually does is hand every
    // loser in the draw rating and take it off every winner.
    throw new ExpectedError(
      'An Elo multiplier cannot be negative — it would reverse every rating change in the event, '
      + 'so winners would lose rating and losers would gain it.',
    );
  }
  if (raw < min || raw > max) {
    throw new ExpectedError(
      `The Elo multiplier must be between ${min} and ${max}. A rated challenge is 1.00 and the usual tournament is 1.25.`,
    );
  }
  return Math.round(raw * 100) / 100;
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
    seed_skip_count?: number | null;
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
  const seedSkip = normalizeSeedSkip(config.format, config.seed_skip_count);
  const eloMultiplier = normalizeEloMultiplier(config.elo_multiplier);
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
    // A POOL-TO-BRACKET EVENT SETS IT AT CREATION (00107), because that format
    // reads it against its OWN pool: brackets.ts picks the qualifiers by it and
    // finalize.ts ranks the non-qualifiers by it, so the column has to exist.
    //
    // WHAT THE "seed_by TRAP" ACTUALLY IS, since it was recorded for a long time
    // in a stronger form than the code supports. The worry was that
    // assignPositionsAndPoints ranks a round robin with no seedBy — defaulting
    // to 'wins' — while a bracket is seeded by seed_by, so final_position (which
    // drives the placement-bonus ledger) could come from a different order than
    // the draw. Within ONE event that was real, and it is closed: both readers
    // take this column.
    //
    // ACROSS TWO EVENTS IT IS NOT A CONFLICT AND CANNOT BE MADE ONE. seed_by
    // belongs to the event being DRAWN, not to the pool being read: N brackets
    // may seed off one pool, each with its own value, and the pool's positions
    // exist before any of them is created. There is no function from the pool's
    // row to a single ranking criterion, so its final_position cannot be derived
    // from seed_by at all — 'wins' is the only well-defined answer, and that is
    // why the round-robin path in finalize.ts is left alone rather than "fixed".
    seed_by: (config.seeded_from_event_id || isPoolToBracket(config.format))
      ? (config.seed_by ?? 'wins')
      : null,
    ...groupShape,
    ...seedSkip,
    max_participants: config.max_participants ?? null,
    seeding_method: config.seeding_method ?? 'elo',
    elo_multiplier: eloMultiplier ?? 1.25,
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
    seed_skip_count?: number | null;
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

  // NO seeding_method-style carve-out here either, and for the group shape's
  // reason rather than the seeding method's. The seeding method is exempt
  // because it is read once, by the NEXT generation, and changes nothing about
  // matches that already exist. This number is read by the next generation too
  // — but the only draw it could describe is one that already exists, and that
  // draw's byes are already dealt. Letting it through would record a promise
  // about a bracket nobody can rebuild, which is a setting that reads as broken
  // rather than one that does nothing. The unmodified gate above (no draw, still
  // editable) refuses it with a sentence naming the reason.
  //
  // The FORMAT is the event's own, not the patch's: format is not updatable, so
  // there is no version of this call in which the two could differ.
  if ('seed_skip_count' in updates) {
    Object.assign(patch, normalizeSeedSkip(event.format as TournamentEventFormat, updates.seed_skip_count));
  }

  /**
   * THE ELO MULTIPLIER, AND WHY IT GETS NO seeding_method-STYLE CARVE-OUT.
   *
   * The number was reachable only at creation until now — createTournamentEvent
   * took it, this function took it, and no form on either dialog sent it — so an
   * event set up at the wrong weight stayed at the wrong weight for its whole
   * life. Event Settings now sends it, which is the whole of the fix.
   *
   * It is tempting to exempt it from the "no draw, still editable" gate above,
   * because unlike the match format it is not baked into the draw: it is read
   * once per RESULT, by applyTournamentMatchElo, off the event row as it stands
   * at that moment. An event that has been drawn but not played would take a new
   * value perfectly consistently.
   *
   * IT IS NOT EXEMPTED, because the same property is what makes it dangerous one
   * match later. Change it after round one has been rated and the event's early
   * rounds were rated at the old weight while its later ones take the new — and
   * nothing anywhere records which was which. `elo_snapshot` stores
   * `{discipline, entries[{before, after, delta, won, …}]}` and NOT the
   * multiplier that produced the delta, so the split is unreconstructible after
   * the fact. Meanwhile the console now PRINTS the weight per round (the bracket
   * tab's "Played to" strip and this dialog's ladder, both via
   * eloWeightBreakdown), and both read the event's current value — so every
   * already-rated round would start displaying a figure that was never applied
   * to it. That is the "silently restate history" case, and the honest options
   * are to refuse it or to record what each match was rated under. Recording it
   * needs a column, and this branch is not taking a migration.
   *
   * So the unmodified gate — no matches, still editable — is the right one here
   * too, and it is STRICTLY SAFER than "no rated matches": it refuses at the
   * draw rather than at the first result, with a sentence that names the reason.
   * Once a column exists to stamp the applied multiplier on each match, this is
   * the comment to revisit.
   */
  if ('elo_multiplier' in updates) {
    const eloMultiplier = normalizeEloMultiplier(updates.elo_multiplier);
    if (eloMultiplier === undefined) {
      // Sent as null/absent by a caller that has the key but no value. Dropped
      // rather than written, so a blank box cannot reset a configured weight to
      // the default behind the exec's back.
      delete patch.elo_multiplier;
    } else {
      patch.elo_multiplier = eloMultiplier;
    }
  }

  if ('seeded_from_event_id' in updates) {
    const sourceId = updates.seeded_from_event_id;
    if (sourceId) {
      await assertSeedSourceUsable(adminClient, event.tournament_id, eventId, sourceId);
      patch.seed_by = updates.seed_by ?? 'wins';
    } else {
      // A POOL_TO_BRACKET EVENT COMES THROUGH HERE, and it is the reason this
      // branch is no longer a flat `seed_by = null`.
      //
      // The settings dialog blanks the pool picker on any round-robin format —
      // that format has no EXTERNAL pool, and createTournamentEvent refuses the
      // combination outright — so it always sends seeded_from_event_id: null.
      // Nulling seed_by alongside it was previously described as harmless, on
      // the grounds that 00046 defines NULL as 'wins' and every reader
      // coalesces. That reasoning holds only while 'wins' is the ONLY value an
      // exec can choose. It no longer is: the form can now express 'points' on
      // this format, and a save that quietly rewrote it to NULL would send the
      // exec back to 'wins' with a success toast on screen — the choice would
      // appear to be taken and then not be.
      //
      // So the link is cleared and the criterion is KEPT, which is exactly what
      // createTournamentEvent does for the same format (`seeded_from_event_id ||
      // isPoolToBracket(format)`). The two writers now agree about when this
      // column means something. Still coalesced to 'wins' rather than left
      // undefined, so a caller that omits seed_by cannot blank a stored choice.
      patch.seeded_from_event_id = null;
      patch.seed_by = isPoolToBracket(event.format as string)
        ? (updates.seed_by ?? 'wins')
        // Every other format reaching this branch genuinely has no pool to rank:
        // a plain round robin PRODUCES standings (finalize.ts ranks it by wins,
        // because N brackets may seed off it with different criteria), and an
        // unlinked knockout seeds by Elo or by hand. A stale criterion left
        // behind would be read as a choice nobody made if a link were added
        // later.
        : null;
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
  if (event.status !== 'registration') throw new ExpectedError('Can only delete events in registration status');

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
  // `bracket_generated` is on this list for a pool_to_bracket event only, and
  // for a reason the other two formats never have: on them that status is
  // written by the generator itself and is unreachable any other way, whereas
  // here it is also the step AFTER `pool_live`, so calling this action directly
  // could mark an event "bracket generated" with no bracket. The `live` guard
  // would eventually catch it, but an event should not be able to sit in a
  // state that is a lie about its own rows in the meantime.
  const startsAPhase = status === 'live' || status === 'pool_live'
    || (status === 'bracket_generated' && isPoolToBracket(event.format as string));
  if (startsAPhase) {
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
