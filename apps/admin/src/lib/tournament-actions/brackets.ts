'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { runAction, type ActionResult } from '../action-result';
import { isDoublesEvent, nextPowerOf2, getRoundName, ExpectedError } from '@badminton/shared';
import type { SeedBy } from '@badminton/shared';
import {
  getExecOrAdmin,
  revalidateEventPaths,
  notifyPlayers,
  getStandardSeedPositions,
  assertTournamentNotSuspended,
  computeRoundRobinStandings,
  settleWrites,
  assertWritesSucceeded,
} from './_internal';

// Block (re)generating a draw once any match has a recorded result —
// regeneration deletes all matches for the event and would erase entered
// scores/Elo. Void those matches first to reset.
async function assertNoResultsEntered(adminClient: ReturnType<typeof createAdminClient>, eventId: string) {
  const { count } = await adminClient
    .from('tournament_matches')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', eventId)
    .in('status', ['completed', 'walkover', 'disputed']);
  if ((count ?? 0) > 0) {
    throw new Error('Results have already been entered for this event — regenerating would erase them. Void those matches first if you really need to reset the draw.');
  }
}

// ============================================================
// Pool -> bracket seeding
// ============================================================

type FieldEntry = { id: string; seed: number | null; elo: number };

// A pair may be entered with the two players in either order, so the key has to
// be order-independent or the same pair in the pool and in the bracket would
// look like two different teams.
function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

/**
 * Build the bracket's field from a finished pool's standings (00046).
 *
 * The point of pool-then-bracket is that the exec does not enter the field
 * twice: whoever finished top N of the pool IS the draw. So this promotes the
 * qualifiers into this event — reusing their existing entry when they are
 * already registered here, creating one when they are not — and returns them
 * already seeded in finishing order.
 *
 * N is max_participants, the event's own capacity. A pool with fewer finishers
 * than that is not an error: the field is simply shorter and the draw gets the
 * byes it would get for any undersized entry list.
 */
async function buildFieldFromPool(
  adminClient: ReturnType<typeof createAdminClient>,
  event: Record<string, unknown>,
  doubles: boolean,
  adminId: string,
): Promise<{ entries: FieldEntry[]; promoted: number; skipped: number }> {
  const eventId = event.id as string;
  const sourceId = event.seeded_from_event_id as string;
  const seedBy = ((event.seed_by as SeedBy | null) ?? 'wins') as SeedBy;

  const { data: source } = await adminClient.from('tournament_events')
    .select('id, tournament_id, event_type')
    .eq('id', sourceId)
    .maybeSingle();
  // The FK is ON DELETE SET NULL, so a missing source means the row was read
  // before the delete landed — either way there is nothing to seed from.
  if (!source) throw new ExpectedError('The pool this event seeds from no longer exists. Pick another pool, or clear the link.');
  if (source.tournament_id !== event.tournament_id) {
    throw new ExpectedError('That pool belongs to a different tournament.');
  }
  // Singles standings are participant rows and doubles standings are pair rows;
  // there is no sensible way to carry one into the other.
  if (isDoublesEvent(source.event_type) !== doubles) {
    throw new ExpectedError('A doubles event cannot be seeded from a singles pool, or the other way round.');
  }

  // Same definition of "played out" that finalizeEvent uses, so an exec cannot
  // be told the pool is finished by one screen and unfinished by another.
  // Empty bracket slots and byes are not real matches and never complete.
  const { data: poolMatches } = await adminClient.from('tournament_matches')
    .select('status, is_bye, participant_a_id, participant_b_id, pair_a_id, pair_b_id')
    .eq('event_id', sourceId);
  if (!poolMatches || poolMatches.length === 0) {
    throw new ExpectedError('That pool has no matches yet, so there is nothing to seed from.');
  }
  const unplayed = poolMatches.filter((m) => {
    if (['completed', 'walkover', 'voided'].includes(m.status as string) || m.is_bye) return false;
    return doubles ? (m.pair_a_id || m.pair_b_id) : (m.participant_a_id || m.participant_b_id);
  });
  if (unplayed.length > 0) {
    throw new ExpectedError(
      `${unplayed.length} pool match(es) have not been played. Seeding off a half-finished pool would produce the wrong draw — finish the pool first.`
    );
  }

  const standings = await computeRoundRobinStandings(sourceId, seedBy);
  if (standings.length === 0) throw new ExpectedError('That pool has no finishers to seed from.');

  // Source rows carry the identity (which player) and the rating to inherit;
  // the standings carry only the order.
  const sourceKeys = new Map<string, { key: string; elo: number; name: string | null; players: string[] }>();
  if (doubles) {
    const { data: pairs } = await adminClient.from('tournament_pairs')
      .select('id, player1_id, player2_id, pair_name, combined_elo')
      .eq('event_id', sourceId);
    for (const p of pairs ?? []) {
      sourceKeys.set(p.id, {
        key: pairKey(p.player1_id, p.player2_id),
        elo: p.combined_elo ?? 400,
        name: p.pair_name,
        players: [p.player1_id, p.player2_id],
      });
    }
  } else {
    const { data: parts } = await adminClient.from('tournament_participants')
      .select('id, player_id, elo_before, elo_after')
      .eq('event_id', sourceId);
    for (const p of parts ?? []) {
      // elo_after is where the pool left them; it is what the bracket should
      // inherit, with elo_before as the fallback for a player who never played.
      sourceKeys.set(p.id, { key: p.player_id, elo: p.elo_after ?? p.elo_before ?? 400, name: null, players: [p.player_id] });
    }
  }

  // Anyone already entered here — including withdrawals, which must be seen so
  // a withdrawal is skipped rather than re-created by the promotion insert.
  const existing = new Map<string, { id: string; status: string }>();
  if (doubles) {
    const { data: pairs } = await adminClient.from('tournament_pairs')
      .select('id, player1_id, player2_id, status')
      .eq('event_id', eventId);
    for (const p of pairs ?? []) existing.set(pairKey(p.player1_id, p.player2_id), { id: p.id, status: p.status });
  } else {
    const { data: parts } = await adminClient.from('tournament_participants')
      .select('id, player_id, status')
      .eq('event_id', eventId);
    for (const p of parts ?? []) existing.set(p.player_id, { id: p.id, status: p.status });
  }

  const capacity = (event.max_participants as number | null) ?? standings.length;
  // Promoted qualifiers arrive checked in: they have just finished playing the
  // pool, so they are demonstrably present. checked_in_at is set alongside the
  // status because the attendance list keys on the timestamp, not the enum —
  // status is overwritten by a later withdrawal, the timestamp is not.
  const promotedAttendance = {
    status: 'checked_in',
    checked_in_at: new Date().toISOString(),
    checked_in_by: adminId,
  };
  const entries: FieldEntry[] = [];
  let promoted = 0;
  let skipped = 0;

  for (const standing of standings) {
    if (entries.length >= capacity) break;
    const src = sourceKeys.get(standing.id);
    if (!src) continue;

    const already = existing.get(src.key);
    // A qualifier who has withdrawn from the bracket does not take a slot, and
    // is not resurrected by re-inserting them — the next finisher moves up.
    if (already && (already.status === 'withdrawn' || already.status === 'disqualified')) {
      skipped++;
      continue;
    }

    const seed = entries.length + 1;
    if (already) {
      entries.push({ id: already.id, seed, elo: src.elo });
      continue;
    }

    // Split rather than one ternary insert. With both the table name AND the
    // row shape chosen by the same condition, the client cannot narrow them
    // together — it checks the union of shapes against whichever table it
    // resolved, and rejects the pairs row for missing participant columns and
    // vice versa. Two calls, each with one table and one shape, type cleanly.
    const { data: created, error } = doubles
      ? await adminClient
          .from('tournament_pairs')
          .insert({
            event_id: eventId,
            player1_id: src.players[0],
            player2_id: src.players[1],
            pair_name: src.name,
            combined_elo: src.elo,
            ...promotedAttendance,
            seed_number: seed,
            added_by: adminId,
          })
          .select('id')
          .single()
      : await adminClient
          .from('tournament_participants')
          .insert({
            event_id: eventId,
            player_id: src.players[0],
            elo_before: src.elo,
            ...promotedAttendance,
            seed_number: seed,
            added_by: adminId,
          })
          .select('id')
          .single();
    if (error || !created) {
      Sentry.captureException(error);
      throw new Error(`Could not enter a pool qualifier into the bracket: ${error?.message ?? 'unknown error'}`);
    }
    promoted++;
    entries.push({ id: created.id, seed, elo: src.elo });
  }

  if (entries.length < 2) {
    throw new ExpectedError('The pool produced fewer than 2 available finishers, which is not a bracket.');
  }

  // Persist the pool order onto the entries that were already here — the ones
  // just created were inserted with their seed. Independent rows, no contention.
  //
  // A seed that failed to persist is not cosmetic: the pool's finishing order
  // IS the draw here, so half-written seeds produce a bracket that disagrees
  // with the pool everyone just played. Fail the generation instead — no
  // matches exist yet, so re-running it is the whole remedy.
  const { failures } = await settleWrites(
    entries.map(e => [
      `${doubles ? 'tournament_pairs' : 'tournament_participants'}.seed_number for ${e.id}`,
      adminClient.from(doubles ? 'tournament_pairs' : 'tournament_participants')
        .update({ seed_number: e.seed })
        .eq('id', e.id),
    ] as const)
  );
  assertWritesSucceeded('Seeding the bracket from the pool standings', failures);

  return { entries, promoted, skipped };
}

// ============================================================
// Bracket Generation — Single Elimination
// ============================================================

// ============================================================
// Third-place playoff
// ============================================================
//
// OPT-IN, not automatic, and the choice is made at generation.
//
// Automatic was the tempting default — it is a bracket property, so why ask?
// Because the thing being spent is court time, and the club does not always
// have it. Three reasons it has to be the exec's call:
//
//   * A 4-entry draw's "semi-finals" are round one. The third-place match is
//     then an immediate rematch between two people who have played exactly one
//     match each, on the same evening, for a placing nobody asked about. Some
//     events want that; a Tuesday social does not.
//   * A draw with byes may not produce two real semi-final losers — a bye has
//     no losing side. Generating the match regardless is right (see
//     advanceLoser), but committing every event to it regardless is not.
//   * Doing it automatically would change the shape of every event that already
//     exists the next time its draw was regenerated, silently.
//
// The choice is NOT stored on tournament_events. The generated match IS the
// record — is_third_place is what finalizeEvent and the bracket read — and a
// second column claiming an event "has" a third-place match could disagree with
// whether one exists. This module's whole defect history is a stored summary
// disagreeing with the rows underneath it.
//
// RATED, like every other match, and that took no code at all: the rating path
// keys off the result, not the round. That is the argument for it. Leaving it
// rated means the players' Elo reflects a real match with a real result, and
// exempting it would mean carving a round-shaped exception into
// applyTournamentMatchElo — which is precisely how a match ends up silently not
// counting.
const THIRD_PLACE_ROUND_NAME = '3rd Place Playoff';

/**
 * Create the third-place match and point both semi-finals' losers at it.
 *
 * Returns the match id, or null when the draw has no semi-final round to feed
 * it — a 2-entry draw is a final and nothing else. That case is skipped rather
 * than refused: the exec ticked a box, and failing the whole generation over a
 * playoff that cannot exist would be a worse answer than generating the draw
 * they actually need. The audit row records the skip.
 */
async function createThirdPlaceMatch(
  adminClient: ReturnType<typeof createAdminClient>,
  eventId: string,
  totalRounds: number,
  semiFinalIds: string[],
): Promise<string | null> {
  if (totalRounds < 2 || semiFinalIds.length !== 2) return null;

  // Same round_number as the final, so it is scheduled alongside it — which is
  // what was asked for — and a second bracket_position so the two never collide.
  // The bracket UI lifts it out of the round columns entirely rather than
  // rendering it as a sibling of the final, because a card sitting in the final's
  // column with a connector into it would say it feeds the final. It feeds
  // nothing: winner_to_match_id stays null.
  const { data: created, error } = await adminClient.from('tournament_matches').insert({
    event_id: eventId,
    round_number: totalRounds,
    round_name: THIRD_PLACE_ROUND_NAME,
    bracket_position: 1,
    is_third_place: true,
    winner_to_match_id: null,
    winner_to_position: null,
    status: 'pending',
  }).select('id').single();

  if (error || !created) {
    Sentry.captureException(error);
    throw new Error(`Failed to create the third-place match: ${error?.message ?? 'unknown error'}`);
  }

  // Both semi-finals, or neither. A half-routed playoff would take one loser and
  // wait forever for a second that nothing sends — and would look, in the
  // bracket, exactly like a playoff whose other semi-final has not finished.
  // Nothing has been played at this point, so throwing costs only a re-run.
  const { failures } = await settleWrites(
    semiFinalIds.map((id, i) => [
      `tournament_matches.loser_to_match_id for semi-final ${id}`,
      adminClient.from('tournament_matches')
        .update({ loser_to_match_id: created.id, loser_to_position: i === 0 ? 'a' : 'b' })
        .eq('id', id),
    ] as const)
  );
  assertWritesSucceeded('Routing the semi-final losers into the third-place match', failures);

  return created.id;
}

async function generateSingleEliminationBracketImpl(eventId: string, includeThirdPlace: boolean) {
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.draw_locked) throw new Error('Draw is locked. Unlock it before generating bracket.');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);
  await assertNoResultsEntered(adminClient, eventId);

  const doubles = isDoublesEvent(event.event_type);

  // Fetch eligible participants/pairs
  let entries: FieldEntry[] = [];
  // A pool-seeded event takes its field and its order from the pool, so the
  // Elo/seed_number path below must not run — it would re-sort the draw by
  // rating and throw away the result everyone just played for.
  const seededFromPool = Boolean(event.seeded_from_event_id);
  let poolPromoted = 0;
  let poolSkipped = 0;

  if (seededFromPool) {
    const field = await buildFieldFromPool(adminClient, event, doubles, admin.id);
    entries = field.entries;
    poolPromoted = field.promoted;
    poolSkipped = field.skipped;
  } else if (doubles) {
    const { data: pairs } = await adminClient.from('tournament_pairs')
      .select('id, seed_number, combined_elo, status')
      .eq('event_id', eventId)
      .in('status', ['registered', 'checked_in'])
      .order('seed_number', { ascending: true, nullsFirst: false });
    entries = (pairs ?? []).map(p => ({ id: p.id, seed: p.seed_number, elo: p.combined_elo ?? 400 }));
  } else {
    const { data: participants } = await adminClient.from('tournament_participants')
      .select('id, seed_number, elo_before, status')
      .eq('event_id', eventId)
      .in('status', ['registered', 'checked_in'])
      .order('seed_number', { ascending: true, nullsFirst: false });
    entries = (participants ?? []).map(p => ({ id: p.id, seed: p.seed_number, elo: p.elo_before ?? 400 }));
  }

  const N = entries.length;
  if (N < 2) throw new Error('Need at least 2 participants to generate a bracket');

  // If not yet seeded, auto-seed by Elo
  const needsSeeding = !seededFromPool && entries.some(e => e.seed === null);
  if (needsSeeding) {
    entries.sort((a, b) => b.elo - a.elo);
    entries.forEach((e, i) => { e.seed = i + 1; });
    // Persist seeds in parallel — independent rows, no contention. Same
    // reasoning as the pool path: the in-memory `entries` order is what builds
    // the bracket below, so a seed that never reached the table leaves the
    // stored seeding disagreeing with the draw it produced. Nothing has been
    // created yet, so throwing here costs only a re-run.
    const seedTable = doubles ? 'tournament_pairs' : 'tournament_participants';
    const { failures } = await settleWrites(
      entries.map(e => [
        `${seedTable}.seed_number for ${e.id}`,
        adminClient.from(seedTable).update({ seed_number: e.seed }).eq('id', e.id),
      ] as const)
    );
    assertWritesSucceeded('Auto-seeding the draw by rating', failures);
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
      // The next round (closer to the final) was built in the previous loop
      // iteration since we count down from totalRounds, so index [round + 1].
      // Using [round] read the not-yet-populated current round -> every
      // winner_to_match_id was null and the bracket never advanced.
      const nextMatchId = round < totalRounds ? matchesByRound[round + 1]?.[Math.floor(pos / 2)] ?? null : null;
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

  // Created after round 1 is populated, so a failure here leaves a draw that is
  // already playable rather than one with a dangling playoff. matchesByRound
  // holds only the main draw, so the semi-final round is unambiguous.
  const thirdPlaceId = includeThirdPlace
    ? await createThirdPlaceMatch(adminClient, eventId, totalRounds, matchesByRound[totalRounds - 1] ?? [])
    : null;

  // Assign match numbers for remaining rounds — collect all (id, number) pairs
  // and issue UPDATEs in parallel.
  const matchNumberAssignments: Array<{ id: string; number: number }> = [];
  for (let round = 2; round <= totalRounds; round++) {
    for (const mId of matchesByRound[round] ?? []) {
      matchNumberAssignments.push({ id: mId, number: matchNumber++ });
    }
  }
  // Numbered last, so the playoff carries the highest match number on the card
  // and the final keeps the number it would have had without this feature.
  // An exec reading a scoresheet expects M7 to be the final of an 8-draw.
  if (thirdPlaceId) matchNumberAssignments.push({ id: thirdPlaceId, number: matchNumber++ });
  if (matchNumberAssignments.length > 0) {
    const { failures } = await settleWrites(
      matchNumberAssignments.map(a => [
        `tournament_matches.match_number for ${a.id}`,
        adminClient.from('tournament_matches').update({ match_number: a.number }).eq('id', a.id),
      ] as const)
    );
    // Thrown before the event flips to bracket_generated, which is what makes
    // this recoverable: the event stays in check-in, no result can have been
    // entered yet, and re-running generation deletes these matches and starts
    // over. A bracket with holes in its numbering is not something the exec
    // should have to notice on the day.
    assertWritesSucceeded('Numbering the bracket matches', failures);
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
    details: {
      bracket_size: bracketSize,
      participants: N,
      byes: numByes,
      // Recorded as three distinguishable states, not a boolean: "asked for and
      // created", "asked for and impossible" (a 2-entry draw has no semi-finals)
      // and "not asked for". The middle one is the only silent outcome in this
      // function, so it is the one the audit trail owes an explanation for.
      third_place_match: includeThirdPlace ? (thirdPlaceId ? 'created' : 'skipped_no_semi_finals') : 'not_requested',
      // Recorded because a pool-seeded draw is not reproducible from the event
      // row alone — the pool can be edited afterwards.
      ...(seededFromPool
        ? {
            seeded_from_event_id: event.seeded_from_event_id,
            seed_by: event.seed_by ?? 'wins',
            promoted_from_pool: poolPromoted,
            qualifiers_skipped: poolSkipped,
          }
        : {}),
    },
  });

  // Notify all participants that bracket is published. A pool-seeded event may
  // hold entries who did not make the cut, so it notifies the drawn field only
  // — telling someone their bracket is published when they are not in it is
  // worse than telling them nothing.
  const bracketPlayerIds: string[] = [];
  const fieldIds = entries.map(e => e.id);
  if (doubles) {
    let q = adminClient.from('tournament_pairs')
      .select('player1_id, player2_id').eq('event_id', eventId).in('status', ['registered', 'checked_in']);
    if (seededFromPool) q = q.in('id', fieldIds);
    const { data: allPairs } = await q;
    for (const p of allPairs ?? []) { bracketPlayerIds.push(p.player1_id, p.player2_id); }
  } else {
    let q = adminClient.from('tournament_participants')
      .select('player_id').eq('event_id', eventId).in('status', ['registered', 'checked_in']);
    if (seededFromPool) q = q.in('id', fieldIds);
    const { data: allParts } = await q;
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

async function generateRoundRobinMatchesImpl(eventId: string) {
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.draw_locked) throw new Error('Draw is locked. Unlock it before generating matches.');
  await assertNoResultsEntered(adminClient, eventId);
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

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
// Public entry points
// ============================================================
// Same reasoning as the result actions: Next.js sanitises anything thrown out
// of a Server Action in a production build, so a guard that throws is invisible
// exactly where it matters. Generation now returns its refusal as a value —
// "3 pool matches have not been played" is the whole point of the guard — and
// runAction keeps those refusals out of Sentry, which only wants real faults.

// includeThirdPlace defaults to false so an existing caller — and a stale client
// bundle mid-deploy — generates exactly the draw it generated before.
export async function generateSingleEliminationBracket(
  eventId: string,
  includeThirdPlace = false,
): Promise<ActionResult<void>> {
  return runAction(async () => { await generateSingleEliminationBracketImpl(eventId, includeThirdPlace); });
}

export async function generateRoundRobinMatches(eventId: string): Promise<ActionResult<void>> {
  return runAction(async () => { await generateRoundRobinMatchesImpl(eventId); });
}

// ============================================================
// Draw Lock/Unlock
// ============================================================

export async function lockDraw(eventId: string) {
  const admin = await getExecOrAdmin();
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
  const admin = await getExecOrAdmin();
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
