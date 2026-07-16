'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { isDoublesEvent, nextPowerOf2, getRoundName } from '@badminton/shared';
import {
  getAdminPlayer,
  revalidateEventPaths,
  notifyPlayers,
  getStandardSeedPositions,
} from './_internal';

// ============================================================
// Bracket Generation — Single Elimination
// ============================================================

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
