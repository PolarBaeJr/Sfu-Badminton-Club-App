'use server';

import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { isDoublesEvent, ExpectedError } from '@badminton/shared';
import { runAction, type ActionResult } from '../action-result';
import {
  requireCapability,
  revalidateEventPaths,
  planGroupAssignment,
  fencedRefusal,
  type GroupCandidate,
  type FencedFieldResult,
} from './_internal';

// ---------------------------------------------------------------------------
// THE SIX WRITES THAT WERE OUTSIDE THE FENCE (00209)
// ---------------------------------------------------------------------------
// 00201 made one advisory key THE fence for the event field and moved every
// field-mutating RPC onto it. This file never joined: it wrote seed_number and
// group_number straight through PostgREST, four of the six through a `table`
// variable chosen at runtime from the event's discipline — which is why the
// repo-wide census for 00201 did not surface them.
//
// Seeds are the draw's INPUT, so this is the withdrawal race's defect class
// rather than a lesser one. A seed write landing between the generator
// building a bracket and publish_event_draw accepting it produces a published
// bracket whose seeding no longer matches the rows it was built from, and
// nothing downstream notices because by then the bracket is fixtures.
//
// Each action below keeps its cheap, friendly refusals — they are what the
// exec reads, and they are made against a row fetched a round trip earlier —
// and then hands the write to an RPC that re-asks the same questions under the
// lock. Where the two disagree it is the race being caught, not the exec
// being wrong, and fencedRefusal says so.
//
// THE RPCS ALSO ENFORCE THE STATUS HALF OF THE CONSOLE'S OWN RULE, which had
// no server-side enforcement at all. participant-controls.ts gates every seed
// control on `status === 'registration' && !drawLocked`; these actions checked
// only draw_locked. The status check below is that gate finally being real,
// not a rule invented here.

/**
 * The event context both event-wide seed writes need.
 *
 * The draw-lock refusal deliberately stays at the two CALL SITES rather than
 * moving in here. "Unlock it before clearing seeds" and "Unlock it before
 * changing seeds" are different sentences at the desk, and
 * tournament-refusal-classification.test.ts reads this file as source: it
 * matches `throw new ExpectedError('<the exact sentence>')`, so a message
 * routed through a variable is a message that test can no longer classify.
 * Both reasons point the same way — keep the literal where it is thrown.
 */
async function loadSeedStage(
  adminClient: ReturnType<typeof createAdminClient>,
  eventId: string,
) {
  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new ExpectedError('Event not found.');
  return { event, doubles: isDoublesEvent(event.event_type) };
}

export async function updateParticipantSeed(participantId: string, seedNumber: number | null) {
  await requireCapability('tournaments.draw.seed.set.write');
  const adminClient = createAdminClient();

  const { data: fenced, error } = await adminClient.rpc('set_field_entry_seed', {
    p_entry_id: participantId,
    p_is_pair: false,
    p_seed: seedNumber,
  });
  if (error) throw new Error(error.message);
  const result = fenced as FencedFieldResult | null;
  if (!result?.ok) fencedRefusal(result, 'Participant not found');

  // The context comes back FROM the fence rather than from a read taken before
  // it, so the paths revalidated are the ones the write actually landed on.
  if (result.tournament_id && result.event_id) {
    revalidateEventPaths(result.tournament_id, result.event_id);
  }
}

export async function updatePairSeed(pairId: string, seedNumber: number | null) {
  await requireCapability('tournaments.draw.seed.set.write');
  const adminClient = createAdminClient();

  const { data: fenced, error } = await adminClient.rpc('set_field_entry_seed', {
    p_entry_id: pairId,
    p_is_pair: true,
    p_seed: seedNumber,
  });
  if (error) throw new Error(error.message);
  const result = fenced as FencedFieldResult | null;
  if (!result?.ok) fencedRefusal(result, 'Pair not found');

  if (result.tournament_id && result.event_id) {
    revalidateEventPaths(result.tournament_id, result.event_id);
  }
}

export async function autoSeedEventByElo(eventId: string) {
  const admin = await requireCapability('tournaments.draw.seed.auto.write');
  const adminClient = createAdminClient();
  const { event, doubles } = await loadSeedStage(adminClient, eventId);
  if (event.draw_locked) throw new ExpectedError('Draw is locked. Unlock it before changing seeds.');

  // THE ORDERING MOVED INSIDE THE FENCE, and that is the correctness change
  // rather than a performance one.
  //
  // This used to read the entrants ordered by rating and then issue one UPDATE
  // per entrant from here — so the read that decided the order and the writes
  // that recorded it were N+1 separate transactions, and a withdrawal landing
  // among them seeded a field that no longer existed. It also needed
  // settleWrites/assertWritesSucceeded to stop a half-applied seeding going
  // unnoticed, and a bulk upsert was ruled out because PostgREST would have
  // turned a one-column update into a full-row rewrite.
  //
  // One statement inside the lock has none of those problems: it cannot be
  // interleaved, it cannot half-apply, and it is one round trip instead of
  // N+1. The predicate and the order are unchanged — everyone not withdrawn or
  // disqualified, highest rating first, NULLs last, pairs on combined_elo and
  // singles on elo_before.
  const { data: fenced, error } = await adminClient.rpc('auto_seed_field_by_rating', {
    p_event_id: eventId,
    p_is_pair: doubles,
  });
  if (error) throw new Error(error.message);
  const result = fenced as FencedFieldResult | null;
  if (!result?.ok) fencedRefusal(result, 'Event not found');

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'auto_seeded',
    performed_by: admin.id,
    details: { seeded: result.seeded ?? 0 },
  });

  revalidateEventPaths(event.tournament_id, eventId);
}

// ============================================================
// Clear Seeds
// ============================================================

export async function clearSeeds(eventId: string) {
  const admin = await requireCapability('tournaments.draw.seed.clear.write');
  const adminClient = createAdminClient();
  const { event, doubles } = await loadSeedStage(adminClient, eventId);
  if (event.draw_locked) throw new ExpectedError('Draw is locked. Unlock it before clearing seeds.');

  const { data: fenced, error } = await adminClient.rpc('clear_field_seeds', {
    p_event_id: eventId,
    p_is_pair: doubles,
  });
  if (error) throw new Error(error.message);
  const result = fenced as FencedFieldResult | null;
  if (!result?.ok) fencedRefusal(result, 'Event not found');

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'seeds_cleared',
    performed_by: admin.id,
    details: { cleared: result.cleared ?? 0 },
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
  //
  // Re-asked under the lock by both group RPCs (00209), which is what stops a
  // generation committing between this read and the write.
  const { count: matchCount, error } = await adminClient.from('tournament_matches')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', eventId);
  // Same reasoning as assertDrawIsRebuildable: a discarded error here reads as
  // "no fixtures yet" and lets a live event's groups be rewritten underneath it.
  if (error) {
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
  const { data: rows, error: readError } = await adminClient.from(table)
    .select(doubles ? 'id, seed_number, combined_elo, group_number, status' : 'id, seed_number, elo_before, group_number, status')
    .eq('event_id', eventId)
    .in('status', ['registered', 'checked_in']);
  // A failed read here would deal an empty field into groups and report
  // success — the same silently-permissive shape every other discarded read in
  // this file has already been given.
  if (readError) throw new Error(`Could not read this event's entrants: ${readError.message}`);

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

  // THE PLAN STAYS HERE AND THE FIELD IT WAS MADE FROM IS VERIFIED THERE.
  // planGroupAssignment is serpentine-by-seed with a tier walk and its own
  // tests; porting it into plpgsql to gain a fence would be a second
  // implementation of the thing that decides who plays whom. So this follows
  // publish_event_draw's shape instead — the entry ids the plan covers travel
  // with it, and the RPC refuses if the eligible field under the lock is not
  // that set. Both directions matter: an arrival would be built fixtures for a
  // group nobody dealt it into, and a departure means the plan balanced group
  // sizes against somebody who has gone.
  //
  // ONE WRITE, NOT N. The previous batch of per-row updates could half-apply,
  // which is why it needed settleWrites — the generator would then have built
  // fixtures for the groups it found and some entrants would have played a
  // group they were never dealt into.
  const { data: fenced, error } = await adminClient.rpc('set_field_groups', {
    p_event_id: eventId,
    p_is_pair: doubles,
    p_assignments: Object.fromEntries(plan),
    p_expected: entries.map(e => e.id),
  });
  if (error) throw new Error(error.message);
  const result = fenced as FencedFieldResult | null;
  if (!result?.ok) fencedRefusal(result, 'Event not found');

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
  const { doubles } = await loadGroupStage(adminClient, eventId);
  // The discipline decides which table holds the entries, so an entry found in
  // the wrong one means the caller and the event disagree about what this event
  // is — write nothing.
  if (doubles !== (table === 'tournament_pairs')) {
    throw new ExpectedError('That entry does not belong to this event’s discipline.');
  }
  if (!Number.isInteger(groupNumber)) {
    throw new ExpectedError('Group must be a whole number.');
  }

  // The range check, the group-stage check and the fixtures check are all made
  // again inside the fence against the group_count it reads there — this
  // caller's copy came from a row read a round trip ago.
  const { data: fenced, error } = await adminClient.rpc('set_field_entry_group', {
    p_entry_id: entryId,
    p_is_pair: doubles,
    p_group: groupNumber,
  });
  if (error) throw new Error(error.message);
  const result = fenced as FencedFieldResult | null;
  if (!result?.ok) fencedRefusal(result, 'That entry is no longer in this event.');

  if (result.tournament_id && result.event_id) {
    revalidateEventPaths(result.tournament_id, result.event_id);
  }
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
