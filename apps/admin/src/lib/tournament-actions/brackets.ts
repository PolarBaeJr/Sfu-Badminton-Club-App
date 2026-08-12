'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { runAction, type ActionResult } from '../action-result';
import { isDoublesEvent, nextPowerOf2, getRoundName, ExpectedError, RESULT_MATCH_STATUSES } from '@badminton/shared';
import type { SeedBy } from '@badminton/shared';
import {
  requireCapability,
  revalidateEventPaths,
  notifyPlayers,
  getStandardSeedPositions,
  assertTournamentNotSuspended,
  assertDrawFieldEventWaiverSigned,
  assertNobodyLeftUnpaired,
  computeRoundRobinStandings,
  settleWrites,
  assertWritesSucceeded,
  drawWithinTiers,
  makeDrawRng,
  newDrawSeed,
  planGroupAssignment,
  drawAvoidingSameGroupRound1,
} from './_internal';

// Block (re)generating a draw once any match has a recorded result —
// regeneration deletes all matches for the event and would erase entered
// scores/Elo. Void those matches first to reset.
/**
 * A finished event's draw is not regenerable, full stop.
 *
 * assertNoResultsEntered only looks for live results, and `voided` is not in its
 * list — so voiding every match of a COMPLETED event unlocked regeneration while
 * the finalisation survived untouched: final_position, tournament points and the
 * placement-bonus ledger all still sat on the old players. The new draw would
 * then finalise on top of them, and the ledger would skip the people it had
 * already paid even though they now finished somewhere else.
 *
 * Nothing in the console can unwind a finalisation, so there is no safe version
 * of this. Refuse it.
 */
function assertNotFinalised(event: Record<string, unknown>, action: string) {
  if (event.status === 'completed') {
    throw new ExpectedError(
      `This event has been finalised, so its draw cannot be ${action}. ` +
      'Final positions, tournament points and any placement bonuses were awarded from the current draw and nothing here can take them back.',
    );
  }
}

/**
 * A BYE IS NOT A RESULT, and counting it as one made the draw unregenerable the
 * instant it was drawn.
 *
 * Generation writes `status: 'completed'` onto every bye it creates (see the
 * round-one loop below) because a bye has already been decided — its winner
 * advances with nothing to play. The guard then read those rows back as entered
 * results, so ANY field that is not a power of two produced a draw that answered
 * "Results have already been entered — void those matches first" about matches
 * that have no score, no Elo and no opponent to void.
 *
 * It went unnoticed because generation was reachable exactly once: the button
 * lived at `checkin` and the first press moved the event to `bracket_generated`,
 * out of the button's reach. Three of the four staging events sitting at
 * `bracket_generated` today have byes and no other completed match, so a
 * Regenerate control would have refused on three out of four.
 *
 * `NOT (is_bye IS TRUE)` and not `is_bye <> true`, because the column is
 * nullable (00001: `BOOLEAN DEFAULT false`) and under SQL's three-valued logic
 * `<>` is UNKNOWN against NULL — a `.neq` would have dropped every NULL row as
 * well, quietly excluding real matches and leaving the guard permanently
 * satisfied. `IS TRUE` is null-safe: true -> false, false -> true, null -> true.
 *
 * A walkover is still a result and still blocks: it is rated, and the go-live
 * sweep records real ones (setEventStatus -> forfeitOutOfEventEntries).
 */
async function assertNoResultsEntered(adminClient: ReturnType<typeof createAdminClient>, eventId: string) {
  const { count, error } = await adminClient
    .from('tournament_matches')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', eventId)
    // RESULT_MATCH_STATUSES, not a literal list, since the event page now counts
    // the same thing to decide whether to offer the button at all — see
    // isPlayedMatch in packages/shared. The `is_bye` half is spelt out here
    // rather than shared because it has to be expressed as a PostgREST filter.
    .in('status', [...RESULT_MATCH_STATUSES])
    .not('is_bye', 'is', true);
  // THE ERROR WAS DISCARDED, AND THIS GUARD FAILS OPEN WITHOUT IT. supabase-js
  // resolves rather than rejects on a PostgREST error and leaves `count` null,
  // so `(count ?? 0) > 0` reads a failed read as "no results" and generation
  // walks straight into `.delete().eq('event_id', eventId)` — erasing matches
  // that carry real scores and real Elo. A guard whose failure mode is the
  // exact destruction it exists to prevent has to say so out loud.
  if (error) {
    Sentry.captureException(error);
    throw new Error(`Could not check whether this event has results yet, so the draw was left alone: ${error.message}`);
  }
  // NAMES THE NUMBER, because the refusal is now reachable from a live event
  // where the exec cannot see at a glance what has been played. "Results have
  // already been entered" on a 128-match draw is not something anybody can act
  // on; "3 matches have a result" is.
  if ((count ?? 0) > 0) {
    const n = count as number;
    throw new ExpectedError(
      `${n} match${n === 1 ? '' : 'es'} in this event ${n === 1 ? 'has' : 'have'} a result, and rebuilding the draw deletes every match — including ${n === 1 ? 'that one' : 'those'}. ` +
      'Void or undo them first if the draw really has to be rebuilt. Byes do not count towards this.',
    );
  }
}

/**
 * WHAT STATUS AN EVENT IS LEFT IN BY A (RE)DRAW.
 *
 * THIS IS THE CHANGE THAT LETS THE BUTTON BE OFFERED AT `live`, not the status
 * check in participant-controls.ts. Both generators ended with an unconditional
 *
 *     .update({ status: 'bracket_generated', ... })
 *
 * which was invisible while the only caller was the check-in press — the event
 * was AT check-in, so writing `bracket_generated` was the forward step. The
 * moment a redraw is reachable from a running event it stops being a forward
 * step and becomes the only write in the whole console that sends an event
 * BACKWARDS: the header's primary button would revert from "Finalize
 * Tournament" to "Start Tournament", the players' app would stop showing the
 * event as under way, and pressing Start again would re-run the go-live
 * forfeit sweep. setEventStatus's transition table is deliberately forward-only
 * (registration -> checkin -> bracket_generated -> live -> completed) precisely
 * so that cannot happen, and this would have gone around it silently.
 *
 * REDRAWING IS NOT A STATUS CHANGE. It replaces the matches; it does not
 * un-start the event. A live event stays live.
 *
 * `completed` is not handled here because assertNotFinalised has already
 * refused it, and no other status can reach a generator with a draw to replace.
 */
function statusAfterDraw(event: Record<string, unknown>): 'live' | 'bracket_generated' {
  return event.status === 'live' ? 'live' : 'bracket_generated';
}

// ============================================================
// Pool -> bracket seeding
// ============================================================

type FieldEntry = {
  id: string;
  seed: number | null;
  elo: number;
  /**
   * The group this entrant qualified out of, and where they finished in it.
   * Both null outside a group-seeded field — an ordinary or single-pool draw
   * has neither, and the draw code checks for null rather than assuming.
   */
  group?: number | null;
  groupRank?: number | null;
};

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
 *
 * A GROUP STAGE CAPS IT FURTHER (00106). When the source is split into groups
 * the number of qualifiers is decided by the FORMAT — qualifiers_per_group out
 * of each group — and not by how many slots this event happens to have. The two
 * caps compose: the smaller wins, so an exec who sets a 16-slot bracket over 4
 * groups of 2 still gets 8 qualifiers, and one who sets a 4-slot bracket over
 * the same groups gets the best 4 of those 8.
 */
async function buildFieldFromPool(
  adminClient: ReturnType<typeof createAdminClient>,
  event: Record<string, unknown>,
  doubles: boolean,
  adminId: string,
): Promise<{ entries: FieldEntry[]; promoted: number; skipped: number; groupCount: number }> {
  const eventId = event.id as string;
  const sourceId = event.seeded_from_event_id as string;
  const seedBy = ((event.seed_by as SeedBy | null) ?? 'wins') as SeedBy;

  const { data: source } = await adminClient.from('tournament_events')
    .select('id, tournament_id, event_type, group_count, qualifiers_per_group')
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

  const srcGroupCount = (source as { group_count?: number | null }).group_count ?? 1;
  const perGroup = (source as { qualifiers_per_group?: number | null }).qualifiers_per_group ?? 2;
  // Math.min over both caps rather than a branch, so a group stage whose
  // qualifier count exceeds the bracket still respects the bracket, and a
  // bracket with no cap still respects the format.
  const capacity = Math.min(
    (event.max_participants as number | null) ?? standings.length,
    srcGroupCount >= 2 ? srcGroupCount * perGroup : standings.length,
  );
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
    // Carried from the STANDING, not from the promoted row: the bracket entry is
    // a different row in a different event and has no group of its own. This is
    // what the draw uses to keep group-mates out of round one.
    const from = {
      group: (standing as { group?: number | null }).group ?? null,
      groupRank: (standing as { groupRank?: number | null }).groupRank ?? null,
    };
    if (already) {
      entries.push({ id: already.id, seed, elo: src.elo, ...from });
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
    entries.push({ id: created.id, seed, elo: src.elo, ...from });
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

  return { entries, promoted, skipped, groupCount: srcGroupCount };
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

/**
 * @param drawSeed The seed the draw is made from. Defaulted rather than
 * required so every caller gets a fresh draw without having to think about it;
 * a caller that passes one gets that exact bracket back, which is what makes a
 * draw reproducible from its audit row.
 */
async function generateSingleEliminationBracketImpl(
  eventId: string,
  includeThirdPlace: boolean,
  drawSeed: number = newDrawSeed(),
) {
  const admin = await requireCapability('tournaments.draw.generate.write');
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.draw_locked) throw new Error('Draw is locked. Unlock it before generating bracket.');
  // The knockout half of the finalisation block, which only ever reached the
  // round-robin path (1922133 wired it into one of the two generators). The
  // reasoning applies here at least as hard: finalizeEvent reads final_position
  // off the BRACKET, so a completed knockout event whose matches were all voided
  // could be redrawn on top of a ledger that had already paid the old finishers.
  assertNotFinalised(event, 'regenerated');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);
  await assertNoResultsEntered(adminClient, eventId);

  const doubles = isDoublesEvent(event.event_type);

  // NOBODY LEFT WAITING FOR A PARTNER. Checked before the field is read, and
  // for the pool-seeded path as well as the ordinary one: the field below comes
  // from tournament_pairs only, so anyone still unpaired in THIS event would be
  // dropped from the draw without a word. See assertNobodyLeftUnpaired.
  await assertNobodyLeftUnpaired(adminClient, eventId, doubles);

  // Fetch eligible participants/pairs
  let entries: FieldEntry[] = [];
  // A pool-seeded event takes its field and its order from the pool, so the
  // Elo/seed_number path below must not run — it would re-sort the draw by
  // rating and throw away the result everyone just played for.
  const seededFromPool = Boolean(event.seeded_from_event_id);
  let poolPromoted = 0;
  let poolSkipped = 0;
  let poolGroupCount = 1;

  if (seededFromPool) {
    const field = await buildFieldFromPool(adminClient, event, doubles, admin.id);
    entries = field.entries;
    poolPromoted = field.promoted;
    poolSkipped = field.skipped;
    poolGroupCount = field.groupCount;
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

  // THE SECOND HARD BLOCK. The field above is drawn from
  // status IN ('registered','checked_in') — no check-in required — so without
  // this an unsigned entrant an exec added is handed an opponent and a court
  // having passed no gate at all.
  await assertDrawFieldEventWaiverSigned(
    adminClient, event.tournament_id, entries.map(e => e.id), doubles,
  );

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

  // ------------------------------------------------------------
  // MAKE THE DRAW. Seeding put the field in order; this decides the bracket.
  // ------------------------------------------------------------
  //
  // SEEDING AND DRAWING ARE TWO STEPS, and only now are they written as two.
  // The seed numbers persisted above are the SEEDING — the rating order, the
  // exec's hand-set order, the pool's finishing order — and they are left
  // exactly as they were. What follows shuffles the entrants within their
  // seeding tiers to produce this particular bracket, which is why pressing
  // Regenerate now yields a different draw off an unchanged field.
  //
  // TWO FIELDS ARE NOT DRAWN, and both are somebody having already said where
  // people go:
  //
  //   * seeding_method = 'manual'. An exec who hand-set every seed asked for
  //     the draw those seeds describe, and has to keep getting it. This is the
  //     opt-out, and it is the only one.
  //   * A SINGLE-POOL-seeded event. buildFieldFromPool refuses a half-played
  //     pool precisely so the bracket matches what everyone just played for;
  //     re-drawing the qualifiers would put the pool's third finisher into the
  //     second seed's half on a coin flip, which is the outcome pool seeding
  //     exists to prevent. seeding_method is not even consulted on that path,
  //     so there would be no opt-out to offer.
  //
  // A GROUP-SEEDED EVENT IS THE THIRD CASE, AND IT IS DRAWN (00106).
  //
  // The argument above does not survive the move from one pool to several, and
  // it is worth saying exactly where it breaks. With ONE pool, the finishing
  // order is a total order that everybody played for: 3rd beat 4th, or beat the
  // people 4th lost to, and swapping them would overturn a result. With SEVERAL
  // groups there is no such order between groups. "Winner of A plays runner-up
  // of B" is fixed by the format, but WHICH B is a question the group stage
  // never asked and cannot answer — the groups played disjoint fixtures. Fixing
  // it to whichever group happens to be numbered lowest is not respecting a
  // result, it is inventing one, and it makes the bracket a pure function of
  // the group numbering, which is the "REGENERATE DOESN'T CHANGE ANYTHING"
  // defect wearing a different hat.
  //
  // So it is drawn — but WITHIN QUALIFICATION TIERS, not within seeding bands.
  // See drawAvoidingSameGroupRound1 for why drawWithinTiers is the wrong
  // shuffle here (its bands straddle the winner/runner-up boundary whenever the
  // group count is not a power of two) and for how the same-group round-one
  // constraint is enforced.
  //
  // `manual` still opts out, and now it opts out of this too: an exec who
  // hand-set the seeds after the groups finished has said where people go.
  const groupSeeded = seededFromPool && poolGroupCount >= 2;
  const drawIsRandomised = event.seeding_method !== 'manual' && (!seededFromPool || groupSeeded);
  let drawAttempts = 0;
  let sameGroupR1: 'avoided' | 'unavoidable' | 'not_applicable' = 'not_applicable';

  if (drawIsRandomised && groupSeeded) {
    const drawn = drawAvoidingSameGroupRound1(entries, {
      bracketSize: nextPowerOf2(N),
      // A qualifier whose groupRank somehow did not survive promotion is put in
      // a tier of its own at the end rather than silently joining the winners.
      tierOf: (e) => e.groupRank ?? Number.MAX_SAFE_INTEGER,
      groupOf: (e) => e.group ?? null,
      seed: drawSeed,
    });
    entries = drawn.entries;
    drawAttempts = drawn.attempts;
    sameGroupR1 = drawn.conflicts === 0 ? 'avoided' : 'unavoidable';
  } else if (drawIsRandomised) {
    entries = drawWithinTiers(entries, makeDrawRng(drawSeed));
  }

  const bracketSize = nextPowerOf2(N);
  const totalRounds = Math.log2(bracketSize);
  const numByes = bracketSize - N;

  // Get standard seeding positions
  const seedPositions = getStandardSeedPositions(bracketSize);

  // ------------------------------------------------------------
  // PLACE BY RANK, NOT BY THE STORED SEED NUMBER
  // ------------------------------------------------------------
  //
  // THIS SILENTLY DROPPED PEOPLE OUT OF THE DRAW, and a redraw is exactly how
  // you reached it. The line was
  //
  //     const entry = entries.find(e => e.seed === seedPositions[pos])
  //
  // and getStandardSeedPositions returns a permutation of 1..bracketSize — so
  // it only ever looked up seeds 1..bracketSize. Stored seed numbers are NOT
  // renumbered when somebody leaves: withdraw the top seed of a 5-entry event
  // and the four who remain are seeds 2,3,4,5 in a 4-slot draw, so seed 5 was
  // never looked up and that player vanished from their own event, while seed 1
  // was looked up, found nothing, and left a phantom bye in their place. The
  // existing regression test happened to withdraw the LAST seed, which is the
  // one case where the numbers stay in range.
  //
  // It survived because generation used to be reachable once, from a field
  // that had just been auto-seeded 1..N contiguously. Every way of reaching it
  // a second time — the Regenerate button, and now a redraw at `live` — starts
  // from a field whose seeds have holes in them.
  //
  // Duplicate seeds had the mirror defect: `.find` returns the first match
  // twice, seating one entrant in two slots and dropping another. Nothing
  // stops two entries sharing a seed — there is no unique index on
  // seed_number in either table, and the seed cell is hand-editable.
  //
  // `entries` is already in the order the draw wants — sorted by seed, or by
  // rating when auto-seeding, and then drawn within its tiers just above — so
  // the rank IS the index. `seed` on the slot is therefore the DRAW rank the
  // entrant was placed at, not the seed number stored against them; nothing
  // downstream reads it, and it is kept only because the slot's shape is what
  // the round-one loop below matches on.
  const bracketSlots: Array<{ id: string; seed: number } | null> = new Array(bracketSize).fill(null);
  for (let pos = 0; pos < bracketSize; pos++) {
    const rank = seedPositions[pos]!;
    const entry = entries[rank - 1];
    if (entry) {
      bracketSlots[pos] = { id: entry.id, seed: rank };
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
    .update({ status: statusAfterDraw(event), updated_at: new Date().toISOString() })
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
      // A redraw of a RUNNING event is the one worth being able to find again
      // in the audit trail months later — it is the only case where the matches
      // this deleted had already been published to the people playing them.
      redrawn_live: event.status === 'live',
      // THE SEED THIS BRACKET WAS DRAWN FROM, and the reason the feature needed
      // no schema change. A draw that cannot be explained is a draw an exec
      // cannot defend when a player asks why they got that half — so the seed
      // goes in the audit trail, where re-running generation with it reproduces
      // the identical bracket from the identical field. `null` when the draw was
      // not randomised, which says so rather than implying a seed nobody used.
      draw_seed: drawIsRandomised ? drawSeed : null,
      draw_randomised: drawIsRandomised,
      // WHETHER THE GROUP CONSTRAINT HELD, in three states rather than a
      // boolean, for the same reason third_place_match is: "unavoidable" is the
      // only silent outcome here, and it is the one an exec will be asked about
      // when two group-mates find themselves playing again in round one.
      // `draw_attempts` says how hard it tried, which is what distinguishes a
      // genuinely impossible field from a run of bad luck.
      ...(groupSeeded
        ? { same_group_round_1: sameGroupR1, draw_attempts: drawAttempts, source_group_count: poolGroupCount }
        : {}),
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
//
// DELIBERATELY NOT RANDOMISED, and this is the note saying so rather than an
// omission. The circle method emits the COMPLETE set of pairings: everybody
// plays everybody, so there is no draw to make and nothing a shuffle could
// change about who meets whom. All it could reorder is the round each fixture
// falls in, which is a scheduling question (courts, rest between matches), not
// a fairness one — and re-rolling the order of an event that is already live
// would move people's matches around for no gain. A round robin's "Regenerate"
// producing the same fixture list is the correct answer, not the bug the
// knockout path had.
//
// STILL TRUE WITH GROUPS (00106). The randomness a group stage needs is in the
// ASSIGNMENT — who is in which group — and that is decided by seed, not by
// chance, precisely so the groups come out balanced. Inside a group the circle
// method is complete again, so there is still no draw to make.

/**
 * The circle method's fixtures for one set of entries.
 *
 * Lifted out of generateRoundRobinMatchesImpl unchanged in behaviour so it can
 * run once per group instead of once per event. It returns pairings by round
 * rather than writing them, because the caller has to interleave several
 * groups' rounds into one shared numbering — see the note at the call site.
 */
function circleMethodRounds<T>(entries: readonly T[]): Array<Array<[T, T]>> {
  // A phantom entry gives an odd field the bye it needs; the pairing it appears
  // in is dropped, which is what makes that entrant's round a rest.
  const padded: Array<T | null> = [...entries];
  if (padded.length % 2 !== 0) padded.push(null);

  const numRounds = padded.length - 1;
  const halfSize = padded.length / 2;
  const indices = padded.map((_, i) => i);
  const rounds: Array<Array<[T, T]>> = [];

  for (let round = 0; round < numRounds; round++) {
    const fixtures: Array<[T, T]> = [];
    for (let i = 0; i < halfSize; i++) {
      const home = padded[indices[i]!];
      const away = padded[indices[padded.length - 1 - i]!];
      if (home != null && away != null) fixtures.push([home, away]);
    }
    rounds.push(fixtures);
    // Rotate: keep index 0 fixed, rotate the rest.
    const last = indices.pop()!;
    indices.splice(1, 0, last);
  }

  return rounds;
}

async function generateRoundRobinMatchesImpl(eventId: string) {
  const admin = await requireCapability('tournaments.draw.generate.write');
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.draw_locked) throw new Error('Draw is locked. Unlock it before generating matches.');
  assertNotFinalised(event, 'regenerated');
  await assertNoResultsEntered(adminClient, eventId);
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  const doubles = isDoublesEvent(event.event_type);

  // Same block as the knockout path. A round robin gives every entrant a match,
  // so a member still waiting for a partner would be left out of the whole
  // event rather than out of one draw.
  await assertNobodyLeftUnpaired(adminClient, eventId, doubles);

  // group_number and the rating come back too, because a group stage assigns
  // any entry that does not yet have a group and needs the same ordering the
  // Assign Groups button uses to do it.
  let entries: Array<{ id: string; seed: number | null; elo: number; group: number | null }> = [];

  if (doubles) {
    const { data: pairs } = await adminClient.from('tournament_pairs')
      .select('id, seed_number, combined_elo, group_number, status')
      .eq('event_id', eventId)
      .in('status', ['registered', 'checked_in'])
      .order('seed_number', { ascending: true, nullsFirst: false });
    entries = (pairs ?? []).map(p => ({
      id: p.id,
      seed: p.seed_number,
      elo: p.combined_elo ?? 400,
      group: (p as { group_number?: number | null }).group_number ?? null,
    }));
  } else {
    const { data: participants } = await adminClient.from('tournament_participants')
      .select('id, seed_number, elo_before, group_number, status')
      .eq('event_id', eventId)
      .in('status', ['registered', 'checked_in'])
      .order('seed_number', { ascending: true, nullsFirst: false });
    entries = (participants ?? []).map(p => ({
      id: p.id,
      seed: p.seed_number,
      elo: p.elo_before ?? 400,
      group: (p as { group_number?: number | null }).group_number ?? null,
    }));
  }

  const N = entries.length;
  if (N < 3) throw new Error('Need at least 3 participants for round robin');

  // Same block as the knockout path, for the same reason — a round robin gives
  // every entrant a match, so an unsigned one plays the whole field.
  await assertDrawFieldEventWaiverSigned(
    adminClient, event.tournament_id, entries.map(e => e.id), doubles,
  );

  // ------------------------------------------------------------
  // GROUPS (00106). One event, several round robins inside it.
  // ------------------------------------------------------------
  //
  // group_count NULL or 1 takes the single-group path below with a group of
  // everybody, which is byte-for-byte the fixture list this function has always
  // produced — the flat behaviour is not reimplemented on top of the group one,
  // it IS the group one with one group.
  const groupCount = (event as { group_count?: number | null }).group_count ?? 1;

  if (groupCount >= 2) {
    // FILL THE GAPS, DO NOT RE-DEAL. An exec who moved somebody between groups
    // before pressing Generate meant it, and a generator that re-dealt the
    // field would throw that away without saying so. planGroupAssignment keeps
    // every valid existing group and only places the entries that have none —
    // which is the whole field the first time, and just the late entrant the
    // second time.
    const plan = planGroupAssignment(entries, groupCount);

    // CHECKED BEFORE ANYTHING IS WRITTEN, and the order is the point. A group of
    // one has nobody to play, so the event would hand that entrant no matches at
    // all and then rank them first on a record of nothing. Refusing AFTER the
    // group_number writes would leave the event carrying a half-applied
    // assignment it never asked for — a refusal has to leave the row exactly as
    // it found it. The plan is enough to count sizes; no write is needed to know.
    const planned = new Array<number>(groupCount).fill(0);
    for (const g of plan.values()) planned[g - 1]!++;
    const short = planned
      .map((size, i) => ({ size, number: i + 1 }))
      .filter(g => g.size < 2);
    if (short.length > 0) {
      throw new ExpectedError(
        `Group ${short.map(g => String.fromCharCode(64 + g.number)).join(', ')} ` +
        `${short.length === 1 ? 'has' : 'have'} fewer than 2 entries, so nobody there would have a match. ` +
        'Lower the group count or move somebody across.',
      );
    }

    const newlyAssigned = entries.filter(e => e.group !== plan.get(e.id));
    if (newlyAssigned.length > 0) {
      const table = doubles ? 'tournament_pairs' : 'tournament_participants';
      const { failures } = await settleWrites(
        newlyAssigned.map(e => [
          `${table}.group_number for ${e.id}`,
          adminClient.from(table).update({ group_number: plan.get(e.id)! }).eq('id', e.id),
        ] as const),
      );
      // The in-memory plan is what the fixtures below are built from, so a
      // group that never reached the table would leave the standings
      // partitioning one way and the schedule another. Nothing has been created
      // yet — the delete is still ahead — so refusing costs only a re-press.
      assertWritesSucceeded('Assigning the groups for this round robin', failures);
    }
    for (const e of entries) e.group = plan.get(e.id)!;
  } else {
    for (const e of entries) e.group = 1;
  }

  const groups: Array<{ number: number; entries: typeof entries }> = [];
  for (let g = 1; g <= Math.max(1, groupCount); g++) {
    groups.push({ number: g, entries: entries.filter(e => e.group === g) });
  }

  // Delete any existing matches
  await adminClient.from('tournament_matches').delete().eq('event_id', eventId);

  // ONE SHARED ROUND NUMBERING ACROSS THE GROUPS, and one shared
  // bracket_position within each round. 00081 put a UNIQUE index on
  // (event_id, round_number, bracket_position) WHERE NOT is_third_place, so
  // running the circle method per group and letting each start its positions at
  // 0 would collide on the second group's very first fixture. Positions are
  // therefore handed out by a per-round counter that spans every group.
  //
  // Rounds are shared rather than offset because Round 1 of group A and Round 1
  // of group B genuinely are the same round — they are played at the same time,
  // on different courts — and because the event page already groups its match
  // list by round_number. Groups of different sizes simply stop contributing
  // once their own circle runs out.
  const positionInRound = new Map<number, number>();
  const roundsByGroup = groups.map(g => ({ number: g.number, rounds: circleMethodRounds(g.entries) }));
  const numRounds = roundsByGroup.reduce((max, g) => Math.max(max, g.rounds.length), 0);
  let matchNumber = 1;

  for (let round = 0; round < numRounds; round++) {
    for (const group of roundsByGroup) {
      for (const [home, away] of group.rounds[round] ?? []) {
        const pos = positionInRound.get(round) ?? 0;
        positionInRound.set(round, pos + 1);

        const insertData: Record<string, unknown> = {
          event_id: eventId,
          round_number: round + 1,
          // The group is on the entries, not in the name, so RoundRobinTab's
          // existing "one heading per round_number" rendering keeps working and
          // the group is shown per fixture instead.
          round_name: `Round ${round + 1}`,
          bracket_position: pos,
          match_number: matchNumber++,
          status: 'pending',
        };

        if (doubles) {
          insertData.pair_a_id = home.id;
          insertData.pair_b_id = away.id;
        } else {
          insertData.participant_a_id = home.id;
          insertData.participant_b_id = away.id;
        }

        await adminClient.from('tournament_matches').insert(insertData);
      }
    }
  }

  // Update event status
  await adminClient.from('tournament_events')
    .update({ status: statusAfterDraw(event), updated_at: new Date().toISOString() })
    .eq('id', eventId);

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'round_robin_generated',
    performed_by: admin.id,
    details: {
      participants: N,
      rounds: numRounds,
      redrawn_live: event.status === 'live',
      // Recorded even when it is 1, so a fixture list can always be explained
      // from its own audit row without re-reading an event that may since have
      // been edited.
      group_count: groupCount,
      ...(groupCount >= 2
        ? { group_sizes: groups.map(g => g.entries.length), matches: matchNumber - 1 }
        : {}),
    },
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
  const admin = await requireCapability('tournaments.draw.lock.write');
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
  const admin = await requireCapability('tournaments.draw.unlock.write');
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
