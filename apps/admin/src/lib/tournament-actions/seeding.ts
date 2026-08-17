'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { isDoublesEvent, ExpectedError } from '@badminton/shared';
import { runAction, type ActionResult } from '../action-result';
import {
  requireCapability,
  revalidateEventPaths,
  planGroupAssignment,
  settleWrites,
  assertWritesSucceeded,
  type GroupCandidate,
} from './_internal';

export async function updateParticipantSeed(participantId: string, seedNumber: number | null) {
  await requireCapability('tournaments.draw.seed.set.write');
  const adminClient = createAdminClient();

  const { data: participant } = await adminClient.from('tournament_participants')
    .select('event_id, event:tournament_events(tournament_id, draw_locked)')
    .eq('id', participantId)
    .single();
  const ev = (participant?.event as unknown as { tournament_id: string; draw_locked: boolean } | null);
  if (ev?.draw_locked) throw new ExpectedError('Draw is locked. Unlock it before changing seeds.');

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
  await requireCapability('tournaments.draw.seed.set.write');
  const adminClient = createAdminClient();

  const { data: pair } = await adminClient.from('tournament_pairs')
    .select('event_id, event:tournament_events(tournament_id, draw_locked)')
    .eq('id', pairId)
    .single();
  const ev = (pair?.event as unknown as { tournament_id: string; draw_locked: boolean } | null);
  if (ev?.draw_locked) throw new ExpectedError('Draw is locked. Unlock it before changing seeds.');

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
  const admin = await requireCapability('tournaments.draw.seed.auto.write');
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');

  if (event.draw_locked) throw new ExpectedError('Draw is locked. Unlock it before making changes.');

  const doubles = isDoublesEvent(event.event_type);

  // ONE ROUND TRIP PER ENTRANT, NOT ONE AFTER ANOTHER. This used to `await`
  // inside the loop, so a 32-entry draw was 32 sequential hops to the database
  // and the wall clock was N x latency. The ordering work is not the cost and
  // never was — `.order()` is a single indexed scan inside Postgres. The cost
  // is the trips.
  //
  // AND THE WRITES ARE CHECKED NOW. Every update's result was discarded, so a
  // failure was silent: an exec pressed Auto-Seed, saw no error, and got a
  // half-seeded field where some entrants kept a stale seed and others had
  // none. Seeds decide the draw, so half-applied is worse than refused —
  // settleWrites collects the failures and assertWritesSucceeded turns any into
  // one message naming what did not land.
  //
  // Deliberately NOT a bulk upsert. PostgREST would send {id, seed_number} as an
  // INSERT ... ON CONFLICT, and Postgres evaluates the insert tuple before it
  // detects the conflict — so every NOT NULL column without a default (event_id,
  // player_id) would have to be round-tripped and written back, turning a
  // one-column update into a full-row rewrite. A single UPDATE ... FROM (VALUES)
  // would be one trip, but it needs SQL this client cannot send: that is a
  // database function and a migration, and it is not worth one at club sizes.
  const table = doubles ? 'tournament_pairs' : 'tournament_participants';
  const ratingColumn = doubles ? 'combined_elo' : 'elo_before';

  const { data: entries, error: readError } = await adminClient.from(table)
    .select(`id, ${ratingColumn}`)
    .eq('event_id', eventId)
    .not('status', 'in', '("withdrawn","disqualified")')
    .order(ratingColumn, { ascending: false, nullsFirst: false });

  // A failed READ used to fall through as `if (entries)` and seed nobody, which
  // reads to the exec as "auto-seed did nothing" rather than as an error.
  if (readError) throw new Error(`Could not read this event's entrants: ${readError.message}`);

  if (entries && entries.length > 0) {
    const { failures } = await settleWrites(
      entries.map((entry, i) => [
        `${table}.seed_number for ${entry.id}`,
        adminClient.from(table).update({ seed_number: i + 1 }).eq('id', entry.id),
      ]),
    );
    assertWritesSucceeded('Auto-seed', failures);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'auto_seeded',
    performed_by: admin.id,
  });

  revalidateEventPaths(event.tournament_id, eventId);
}

// ============================================================
// Clear Seeds
// ============================================================

export async function clearSeeds(eventId: string) {
  const admin = await requireCapability('tournaments.draw.seed.clear.write');
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.draw_locked) throw new ExpectedError('Draw is locked. Unlock it before clearing seeds.');

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
// Groups (00106)
// ============================================================
//
// NO NEW CAPABILITY, AND THAT IS A DELIBERATE CHOICE RATHER THAN A SHORTCUT.
// Dealing a field into groups is the same act as making the draw — it decides
// who plays whom — so it asks `tournaments.draw.generate.write`, the key both
// generators already ask for. Moving ONE entry between groups is the same act
// as changing one seed — it moves a single person within a draw that has not
// been made — so it asks `tournaments.draw.seed.set.write`, the key
// updateParticipantSeed/updatePairSeed already ask for. Nothing new appears in
// CAPABILITIES and no row moves in capability-equivalence.test.ts.

/** The event, its group count, and the refusals that apply to both group writes. */
async function loadGroupStage(
  adminClient: ReturnType<typeof createAdminClient>,
  eventId: string,
) {
  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new ExpectedError('Event not found.');
  if (event.draw_locked) throw new ExpectedError('The draw is locked. Unlock it before changing groups.');

  const groupCount = (event as { group_count?: number | null }).group_count ?? 1;
  if (groupCount < 2) {
    throw new ExpectedError('This event is not split into groups. Set a group count on the event first.');
  }

  // GROUPS ARE FIXED THE MOMENT THE FIXTURES EXIST. The whole schedule is
  // derived from who is in which group, so moving somebody afterwards would
  // leave them playing a group they are no longer in — the standings would
  // partition one way and the matches another. Regenerating the fixtures is the
  // honest remedy, and the generator already refuses to do that over results.
  const { count: matchCount, error } = await adminClient.from('tournament_matches')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', eventId);
  // Same reasoning as assertNoResultsEntered: a discarded error here reads as
  // "no fixtures yet" and lets a live event's groups be rewritten underneath it.
  if (error) {
    Sentry.captureException(error);
    throw new Error(`Could not check whether this event has fixtures yet, so the groups were left alone: ${error.message}`);
  }
  if ((matchCount ?? 0) > 0) {
    throw new ExpectedError(
      'The fixtures for this event have already been generated, so its groups are fixed. Regenerate the round robin if the groups really have to change.',
    );
  }

  return { event, groupCount, doubles: isDoublesEvent(event.event_type) };
}

async function assignEventGroupsImpl(eventId: string) {
  const admin = await requireCapability('tournaments.draw.generate.write');
  const adminClient = createAdminClient();
  const { event, groupCount, doubles } = await loadGroupStage(adminClient, eventId);

  const table = doubles ? 'tournament_pairs' : 'tournament_participants';
  const { data: rows } = await adminClient.from(table)
    .select(doubles ? 'id, seed_number, combined_elo, group_number, status' : 'id, seed_number, elo_before, group_number, status')
    .eq('event_id', eventId)
    .in('status', ['registered', 'checked_in']);

  const entries: GroupCandidate[] = (rows ?? []).map((r) => {
    const row = r as unknown as Record<string, unknown>;
    return {
      id: row.id as string,
      seed: (row.seed_number as number | null) ?? null,
      elo: ((doubles ? row.combined_elo : row.elo_before) as number | null) ?? 400,
      group: (row.group_number as number | null) ?? null,
    };
  });

  // THE SAME RULE THE GENERATOR ENFORCES, ASKED HERE TOO. A group needs two
  // people to be a round robin. Left to the generator alone, an exec who set 8
  // groups over 9 entries would get a cheerful "dealt into 8 groups" here and
  // the refusal three screens later, at Generate, naming groups they can no
  // longer see how they got. The refusal belongs where the number was set.
  if (entries.length < groupCount * 2) {
    throw new ExpectedError(
      `There are ${entries.length} entries and ${groupCount} groups, so at least one group would have fewer than 2 people in it. ` +
      `Lower the group count to ${Math.max(1, Math.floor(entries.length / 2))} or fewer, or add entries.`,
    );
  }

  // reassignAll, because this is the button that means "deal the groups". The
  // fill-the-gaps behaviour that preserves hand-placements belongs to the
  // generator, which runs without anybody asking for a re-deal.
  const plan = planGroupAssignment(entries, groupCount, { reassignAll: true });

  const { failures } = await settleWrites(
    [...plan.entries()].map(([id, group]) => [
      `${table}.group_number for ${id}`,
      adminClient.from(table).update({ group_number: group }).eq('id', id),
    ] as const),
  );
  // A half-written assignment is not cosmetic: the generator would build
  // fixtures for the groups it finds, so some entrants would play a group they
  // were never dealt into. Nothing has been generated yet, so a refusal costs
  // only a re-press.
  assertWritesSucceeded('Dealing the field into groups', failures);

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'groups_assigned',
    performed_by: admin.id,
    details: { group_count: groupCount, entries: entries.length, method: 'serpentine_by_seed' },
  });

  revalidateEventPaths(event.tournament_id, eventId);
}

async function updateEntryGroupImpl(
  table: 'tournament_participants' | 'tournament_pairs',
  entryId: string,
  groupNumber: number,
) {
  await requireCapability('tournaments.draw.seed.set.write');
  const adminClient = createAdminClient();

  const { data: entry } = await adminClient.from(table)
    .select('event_id')
    .eq('id', entryId)
    .maybeSingle();
  if (!entry?.event_id) throw new ExpectedError('That entry is no longer in this event.');

  const eventId = entry.event_id as string;
  const { event, groupCount, doubles } = await loadGroupStage(adminClient, eventId);
  // The discipline decides which table holds the entries, so an entry found in
  // the wrong one means the caller and the event disagree about what this event
  // is — write nothing.
  if (doubles !== (table === 'tournament_pairs')) {
    throw new ExpectedError('That entry does not belong to this event’s discipline.');
  }
  if (!Number.isInteger(groupNumber) || groupNumber < 1 || groupNumber > groupCount) {
    throw new ExpectedError(`Group must be between 1 and ${groupCount}.`);
  }

  const { error } = await adminClient.from(table)
    .update({ group_number: groupNumber })
    .eq('id', entryId);
  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  revalidateEventPaths(event.tournament_id, eventId);
}

// Server actions return their refusals as values. Every guard above is a
// sentence an exec has to be able to read — "the fixtures have already been
// generated" is the whole point of the guard — and Next redacts anything thrown
// out of a Server Action in a production build.

/** Deal the whole field into groups, serpentine by seed. */
export async function assignEventGroups(eventId: string): Promise<ActionResult<void>> {
  return runAction(async () => { await assignEventGroupsImpl(eventId); });
}

/** Move one singles entrant into another group. */
export async function updateParticipantGroup(participantId: string, groupNumber: number): Promise<ActionResult<void>> {
  return runAction(async () => { await updateEntryGroupImpl('tournament_participants', participantId, groupNumber); });
}

/** Move one pair into another group. */
export async function updatePairGroup(pairId: string, groupNumber: number): Promise<ActionResult<void>> {
  return runAction(async () => { await updateEntryGroupImpl('tournament_pairs', pairId, groupNumber); });
}
