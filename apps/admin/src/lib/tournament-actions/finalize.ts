'use server';

import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import {
  isDoublesEvent,
  clampElo,
  placementBonusFor,
  ExpectedError,
  endsInKnockout,
  isPoolToBracket,
  phaseValueFor,
  isRealIncompleteMatch,
} from '@badminton/shared';
import type { SeedBy } from '@badminton/shared';
import { getTournamentBonusSettings } from '../platform-settings';
import {
  requireCapability,
  getRatingSettings,
  revalidateEventPaths,
  notifyPlayers,
  computeRoundRobinStandings,
  assertTournamentNotSuspended,
  settleWrites,
  assertWritesSucceeded,
  type LabelledWrite,
} from './_internal';

// ============================================================
// Placement Bonuses & Finalize
// ============================================================

// The audit action that doubles as the placement-bonus ledger. Rows carry, in
// `details`, exactly which ratings and which participant rows a run managed to
// write — see readBonusLedger.
const BONUS_APPLIED_ACTION = 'placement_bonuses_applied';

interface BonusLedger {
  /** player_ids whose rating has already had its bonus added. */
  ratedPlayers: Set<string>;
  /** tournament_participants ids whose elo_change has already been credited. */
  creditedParticipants: Set<string>;
}

/**
 * What a previous bonus run actually managed to write for this event.
 *
 * applyPlacementBonuses reads a rating and writes `current + bonus`, which is
 * not idempotent: run it twice and everyone is awarded twice. That was
 * unreachable only because finalizeEvent could never run a second time — and
 * "unrepairable" is not the same as "safe". Now that a partial failure is
 * raised rather than swallowed, a retry has to be able to finish the job
 * without redoing the part that landed.
 *
 * The ledger is append-only and lives in `tournament_audit_log.details`, which
 * is jsonb and already written on every successful run. That avoids inventing
 * a compensating write path (which can fail on its own, and can clobber a
 * concurrent rating change) and avoids a schema change.
 *
 * Singles has TWO non-idempotent writes per player — ratings.singles_elo and
 * tournament_participants.elo_change — and they can fail independently, so the
 * ledger tracks them separately.
 */
async function readBonusLedger(
  adminClient: ReturnType<typeof createAdminClient>,
  eventId: string,
): Promise<BonusLedger> {
  const { data, error } = await adminClient.from('tournament_audit_log')
    .select('details')
    .eq('event_id', eventId)
    .eq('action', BONUS_APPLIED_ACTION);
  // Without the ledger there is no way to tell a first run from a second, and
  // guessing wrong doubles every bonus on the event. Refuse.
  if (error) {
    throw new Error(
      `Could not read the placement-bonus history for this event (${error.message}). ` +
      `Refusing to apply bonuses — a repeat application would double every rating.`
    );
  }

  const ledger: BonusLedger = { ratedPlayers: new Set(), creditedParticipants: new Set() };
  for (const row of data ?? []) {
    const details = (row.details ?? {}) as { rated_players?: unknown; credited_participants?: unknown };
    for (const id of Array.isArray(details.rated_players) ? details.rated_players : []) {
      if (typeof id === 'string') ledger.ratedPlayers.add(id);
    }
    for (const id of Array.isArray(details.credited_participants) ? details.credited_participants : []) {
      if (typeof id === 'string') ledger.creditedParticipants.add(id);
    }
  }
  return ledger;
}

export async function applyPlacementBonuses(eventId: string) {
  const admin = await requireCapability('tournaments.results.bonuses.write');
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.status !== 'completed') throw new ExpectedError('Event must be completed first');
  if (!event.placement_bonus_enabled) throw new ExpectedError('Placement bonuses not enabled for this event');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  // Two gates, both must allow it: the global master switch in
  // platform_settings.tournament_bonuses.enabled, and the per-event column
  // checked above. The global flag existed in the settings panel but was read
  // by nothing, so the panel could say "off" while every finalise awarded
  // bonuses. Callers reaching this action directly (the admin button) get a
  // clear error; finalizeEvent checks the same flag up front so it never
  // half-finalises — see the guard there.
  const bonusSettings = await getTournamentBonusSettings(adminClient);
  if (!bonusSettings.enabled) {
    throw new ExpectedError('Placement bonuses are disabled platform-wide (Settings → Tournament Bonuses)');
  }

  const doubles = isDoublesEvent(event.event_type);
  const bonuses = doubles ? bonusSettings.doubles : bonusSettings.singles;

  // Pure helper — pull bonus from final_position so the batched paths below stay tidy.
  const bonusFor = (pos: number | null | undefined): number => placementBonusFor(pos, bonuses);

  const nowIso = new Date().toISOString();

  const ledger = await readBonusLedger(adminClient, eventId);
  // The live ceiling is 3000+, not the 1500 that clampElo falls back to. Left
  // to the fallback, a player above 1500 would be pushed DOWN by winning the
  // event — a placement bonus that demotes the champion. rating_bounds() in SQL
  // reads the same two settings, so both engines clamp to the same range.
  const ratingSettings = await getRatingSettings(adminClient);
  const bounds = { min: ratingSettings?.min_elo, max: ratingSettings?.max_elo };

  // Filled by whichever branch runs, then recorded in the ledger before any
  // failure is raised.
  const ratedPlayers: string[] = [];
  const creditedParticipants: string[] = [];
  let writeFailures: Awaited<ReturnType<typeof settleWrites>>['failures'] = [];

  if (doubles) {
    const { data: pairs } = await adminClient.from('tournament_pairs')
      .select('id, player1_id, player2_id, final_position')
      .eq('event_id', eventId)
      .not('final_position', 'is', null);

    // Build playerId → bonus map (a player may appear in multiple pairs, sum bonuses).
    const playerBonus = new Map<string, number>();
    for (const pair of pairs ?? []) {
      const bonus = bonusFor(pair.final_position);
      if (bonus <= 0) continue;
      for (const pid of [pair.player1_id, pair.player2_id]) {
        playerBonus.set(pid, (playerBonus.get(pid) ?? 0) + bonus);
      }
    }
    // Anyone a previous run already paid is skipped, so a retry finishes the
    // job rather than paying them twice.
    for (const pid of ledger.ratedPlayers) playerBonus.delete(pid);

    if (playerBonus.size > 0) {
      // Single batched fetch for all affected ratings.
      const playerIds = [...playerBonus.keys()];
      const { data: ratings } = await adminClient.from('ratings')
        .select('player_id, doubles_elo')
        .in('player_id', playerIds);
      const ratingMap = new Map<string, number>();
      for (const r of ratings ?? []) ratingMap.set(r.player_id, r.doubles_elo ?? 400);

      // Parallel UPDATEs — one row per player, no contention.
      const targets = [...playerBonus.entries()];
      const { failures, landed } = await settleWrites(
        targets.map(([pid, bonus]) => [
          `ratings.doubles_elo for player ${pid}`,
          adminClient.from('ratings')
            .update({ doubles_elo: clampElo((ratingMap.get(pid) ?? 400) + bonus, bounds), updated_at: nowIso })
            .eq('player_id', pid),
        ] as const)
      );
      writeFailures = failures;
      targets.forEach(([pid], i) => { if (landed[i]) ratedPlayers.push(pid); });
    }
  } else {
    const { data: participants } = await adminClient.from('tournament_participants')
      .select('id, player_id, final_position, elo_change, elo_after')
      .eq('event_id', eventId)
      .not('final_position', 'is', null);

    const eligible = (participants ?? [])
      .map(p => ({ ...p, bonus: bonusFor(p.final_position) }))
      .filter(p => p.bonus > 0);

    if (eligible.length > 0) {
      const playerIds = eligible.map(p => p.player_id);
      const { data: ratings } = await adminClient.from('ratings')
        .select('player_id, singles_elo')
        .in('player_id', playerIds);
      const ratingMap = new Map<string, number>();
      for (const r of ratings ?? []) ratingMap.set(r.player_id, r.singles_elo ?? 400);

      // Parallel: rating UPDATE + participant elo_change UPDATE for each row.
      // The two are ledgered separately because they can fail independently —
      // elo_change is read-modify-write just like the rating is, so a retry
      // that redid the credited half would inflate the participant's recorded
      // change while the rating stayed put.
      const writes: LabelledWrite[] = [];
      const ratingTargets: string[] = [];
      const participantTargets: string[] = [];
      for (const p of eligible) {
        if (!ledger.ratedPlayers.has(p.player_id)) {
          ratingTargets.push(p.player_id);
          writes.push([
            `ratings.singles_elo for player ${p.player_id}`,
            adminClient.from('ratings')
              .update({ singles_elo: clampElo((ratingMap.get(p.player_id) ?? 400) + p.bonus, bounds), updated_at: nowIso })
              .eq('player_id', p.player_id),
          ]);
        }
        if (!ledger.creditedParticipants.has(p.id)) {
          participantTargets.push(p.id);
          const prevChange = (p.elo_change as number | null) ?? 0;
          // elo_after MOVES WITH elo_change, and it did not before. The bonus
          // was credited to the rating and to elo_change but never to the
          // snapshot, so the results table showed a player's rating BEFORE
          // their bonus while reporting a change that included it: "1114 ->
          // 1190 (+108)" for somebody actually sitting on 1222. The ladder was
          // right; the row describing it was not.
          //
          // Clamped the same way the rating is, so the snapshot cannot claim a
          // number the rating bounds would have refused. Null elo_after means
          // this entry was never rated (no matches played), and adding a bonus
          // to nothing would invent a rating — left alone.
          const prevAfter = p.elo_after as number | null;
          writes.push([
            `tournament_participants.elo_change for ${p.id}`,
            adminClient.from('tournament_participants')
              .update({
                elo_change: prevChange + p.bonus,
                ...(prevAfter === null || prevAfter === undefined
                  ? {}
                  : { elo_after: clampElo(prevAfter + p.bonus, bounds) }),
              })
              .eq('id', p.id),
          ]);
        }
      }

      const { failures, landed } = await settleWrites(writes);
      writeFailures = failures;
      // `writes` interleaves the two kinds, so walk it once and sort the
      // landed ones back into the two ledgers by the order they were pushed.
      let ratingIdx = 0;
      let participantIdx = 0;
      writes.forEach(([label], i) => {
        const isRating = label.startsWith('ratings.');
        const id = isRating ? ratingTargets[ratingIdx++] : participantTargets[participantIdx++];
        if (!landed[i] || !id) return;
        (isRating ? ratedPlayers : creditedParticipants).push(id);
      });
    }
  }

  // The ledger row goes in BEFORE any failure is raised, and its write is
  // checked rather than best-effort: it is the only record of which bonuses
  // landed, so losing it is what makes a retry dangerous. logAudit swallows its
  // own errors by design, which is right for an audit trail and wrong for this.
  const { error: ledgerError } = await adminClient.from('tournament_audit_log').insert({
    tournament_id: event.tournament_id,
    event_id: eventId,
    match_id: null,
    action: BONUS_APPLIED_ACTION,
    performed_by: admin.id,
    details: {
      rated_players: ratedPlayers,
      credited_participants: creditedParticipants,
      failed_writes: writeFailures.length,
    },
  });
  if (ledgerError) {
    throw new Error(
      `Placement bonuses were applied to ${ratedPlayers.length} rating(s) but the record of it could not be saved ` +
      `(${ledgerError.message}). Do NOT re-run placement bonuses for this event — they would be applied twice.`
    );
  }

  assertWritesSucceeded('Applying placement bonuses', writeFailures);

  revalidateEventPaths(event.tournament_id, eventId);
}

/**
 * Work out final positions and tournament points from the draw as it stands,
 * and write them.
 *
 * Extracted from finalizeEvent so a CORRECTION can redo it. Correcting a
 * finalised event fixes the match and the ratings, and used to leave the
 * standings frozen at whatever finalisation computed — the old champion kept
 * first place, 100 points and the trophy while the bracket named someone else.
 * The dialog's advice was to "adjust those by hand", which is not a thing the
 * console can do: there is no editor for final_position or points.
 *
 * Both writes are absolute and derived entirely from the finished bracket, so
 * running this again is idempotent — that is what makes it safe to re-run on a
 * completed event.
 *
 * Placement BONUSES are deliberately not touched here. They were paid into the
 * players' ratings and there is no reversal for them, so redoing placements
 * cannot quietly redo the money; recomputeEventStandings reports when a
 * placement moved under a paid bonus and leaves that for a human.
 */
async function assignPositionsAndPoints(
  adminClient: ReturnType<typeof createAdminClient>,
  event: Record<string, unknown>,
  eventId: string,
  doubles: boolean,
  table: string,
): Promise<Map<string, number>> {
  // Positions first: the full (id → position) map is built in memory, then
  // written as one parallel batch of UPDATEs.
  const positionMap = new Map<string, number>();

  // WHICH RULE DECIDES THE PLACINGS. A pool_to_bracket event ends in a knockout
  // and is placed by it, exactly as a single_elimination event is — the pool
  // decided who got in, not who won. What it adds is everyone the knockout did
  // not contain; see the non-qualifier pass below.
  const knockout = endsInKnockout(event.format as string);
  const poolToBracket = isPoolToBracket(event.format as string);
  const bracketPhase = phaseValueFor(event.format as string, 'bracket');

  if (knockout) {
    // PHASE-FILTERED (00107), and this is not optional. The pool's matches sit
    // in this same table on a pool_to_bracket event, and every one of them has
    // a round_number in the same range as the bracket's. Unfiltered, the
    // `totalRounds = max(round_number)` line below would be computed over a
    // mixture of two draws and the "loser of the final is 2nd" rule would be
    // applied to a round-robin fixture.
    let matchQuery = adminClient.from('tournament_matches')
      // The SLOTS come back too, so the winner can be checked against them
      // below rather than taken on trust.
      .select('id, round_number, is_third_place, winner_pair_id, loser_pair_id, winner_participant_id, loser_participant_id, participant_a_id, participant_b_id, pair_a_id, pair_b_id')
      .eq('event_id', eventId)
      .in('status', ['completed', 'walkover'])
      .order('round_number', { ascending: false });
    if (bracketPhase) matchQuery = matchQuery.eq('phase', bracketPhase);
    const { data: matches } = await matchQuery;

    // Every position, point and placement bonus below is read off winner_* and
    // loser_*, and nothing had ever checked that those two are the players who
    // were actually IN the match. They can disagree: a stale result write can
    // land after another desk swapped a slot, and the draw editor will place any
    // entry from the event into any empty slot — including the third-place
    // match, whose occupants are supposed to be the two beaten semi-finalists.
    // Both produce a row that finalises cleanly and awards someone a placing
    // they did not play for.
    //
    // Refusing is right rather than repairing: this is a bracket that needs a
    // human to look at it, and quietly picking one of the two disagreeing
    // answers is how the wrong name ends up on the trophy.
    for (const m of matches ?? []) {
      const slots = doubles
        ? [m.pair_a_id, m.pair_b_id]
        : [m.participant_a_id, m.participant_b_id];
      const decided = doubles
        ? [m.winner_pair_id, m.loser_pair_id]
        : [m.winner_participant_id, m.loser_participant_id];
      for (const id of decided) {
        // A null side is normal — an unopposed walkover has no loser.
        if (id && !slots.includes(id)) {
          throw new ExpectedError(
            `Match ${m.id} records a result for an entry that is not in either of its slots. ` +
            'The draw disagrees with the result, so the final positions cannot be trusted. ' +
            'Fix that match before finalising.',
          );
        }
      }
    }

    // The third-place playoff shares round_number with the final so the two are
    // scheduled together (00080), and it MUST be held out of the loop below —
    // both of that loop's rules would misread it:
    //
    //   * its loser has roundsFromFinal 0, so the "loser of the final is 2nd"
    //     rule would award 2nd place to the player who came FOURTH;
    //   * its winner is in the final's round, and the champion line uses `set`
    //     rather than first-write-wins, so it would overwrite the actual
    //     champion with the winner of the third-place match.
    //
    // Neither is a hypothetical: they are the direct consequence of the
    // scheduling decision, which is why the split is here and not left implicit.
    const allMatches = matches ?? [];
    const bracketMatches = allMatches.filter(m => !m.is_third_place);
    const thirdPlace = allMatches.find(m => m.is_third_place);

    // Written BEFORE the loop so the first-write-wins rule for losers protects
    // them: without a playoff, both semi-final losers get joint 3rd, and that
    // rule is exactly what must not run for the two entries this match sorted.
    //
    // Each side is written only if it exists. An unopposed playoff — one
    // semi-final was a bye, so only one loser was ever routed in — has a winner
    // and no loser, and inventing a 4th place for nobody would be worse than
    // leaving the position unset.
    if (thirdPlace) {
      const w = (doubles ? thirdPlace.winner_pair_id : thirdPlace.winner_participant_id) as string | null;
      const l = (doubles ? thirdPlace.loser_pair_id : thirdPlace.loser_participant_id) as string | null;
      if (w) positionMap.set(w, 3);
      if (l) positionMap.set(l, 4);
    }

    // Guarded on the FILTERED list, not on `matches`. An event whose only
    // completed match is the playoff — the final voided, say — would otherwise
    // reach Math.max() of an empty array, which is -Infinity, and every
    // loserPosition computed from it would be garbage rather than absent.
    if (bracketMatches.length > 0) {
      const totalRounds = Math.max(...bracketMatches.map(m => m.round_number));

      for (const m of bracketMatches) {
        const roundsFromFinal = totalRounds - m.round_number;
        const loserPosition = roundsFromFinal === 0 ? 2 : Math.pow(2, roundsFromFinal) + 1;

        const loserId = (doubles ? m.loser_pair_id : m.loser_participant_id) as string | null;
        const winnerId = (doubles ? m.winner_pair_id : m.winner_participant_id) as string | null;

        // First-write-wins for losers (later rounds set position before earlier ones).
        if (loserId && !positionMap.has(loserId)) positionMap.set(loserId, loserPosition);
        if (m.round_number === totalRounds && winnerId) positionMap.set(winnerId, 1);
      }
    }

    // ------------------------------------------------------------
    // EVERYONE THE KNOCKOUT DID NOT CONTAIN (00107)
    // ------------------------------------------------------------
    //
    // On a pool_to_bracket event most of the field never enters the bracket,
    // and without this they would finish the event with final_position NULL —
    // no placing, no tournament points, and invisible to every results screen,
    // having played a full round robin. They are ordered among themselves by
    // the pool table, and they finish BEHIND every qualifier.
    //
    // THE START IS max(assigned) + 1, NOT (number of qualifiers) + 1. Knockout
    // placings are not dense: an 8-slot draw awards 1, 2, 3, 3 and then 5 to
    // all four first-round losers, so the highest number a qualifier holds is
    // bracketSize/2 + 1 and can exceed the size of the field. Starting from the
    // count would place a non-qualifier level with, or ahead of, somebody who
    // won a knockout match.
    //
    // THE ORDER COMES FROM event.seed_by, WHICH IS THE DOCUMENTED TRAP CLOSED.
    // Within one event the worry was real: the bracket half was seeded by
    // seed_by while this half defaulted to 'wins', so final_position — and
    // therefore the placement-bonus ledger — could be computed from a different
    // order than the draw was. Here there is ONE row and buildFieldFromOwnPool
    // reads the same column, so they cannot disagree.
    //
    // The `else` branch below still passes no seedBy, and that is correct
    // rather than an oversight — see the note on it.
    if (poolToBracket) {
      const seedBy = ((event.seed_by as SeedBy | null) ?? 'wins') as SeedBy;
      const poolStandings = await computeRoundRobinStandings(eventId, seedBy);
      let next = positionMap.size > 0 ? Math.max(...positionMap.values()) + 1 : 1;
      for (const s of poolStandings) {
        if (!s || positionMap.has(s.id)) continue;
        positionMap.set(s.id, next++);
      }
    }
  } else {
    // Round robin: compute standings and assign positions.
    //
    // NO seedBy, AND THAT IS THE ONLY WELL-DEFINED CHOICE — not a leftover.
    // This branch is reached only by `round_robin` (endsInKnockout covers the
    // other two formats), and a round robin's own seed_by says nothing about
    // its own table: the column means "how to rank the pool THIS event is drawn
    // from", so on a pool it is either NULL or a statement about some other
    // event entirely.
    //
    // Nor could it be made to mean that. A pool may feed several brackets, each
    // carrying its own seed_by, and its positions are assigned when IT is
    // finalised — possibly before any bracket exists. There is no single value
    // to read, so 'wins' (sortStandings' default, and what a pool table is read
    // by) is the answer. The order a bracket seeds that pool by is a property of
    // the bracket's draw, not a second opinion about the pool's result.
    const standings = await computeRoundRobinStandings(eventId);
    standings.forEach((s, i) => positionMap.set(s!.id, i + 1));
  }

  if (positionMap.size > 0) {
    const { failures } = await settleWrites(
      [...positionMap.entries()].map(([id, pos]) => [
        `${table}.final_position for ${id}`,
        adminClient.from(table).update({ final_position: pos }).eq('id', id),
      ] as const)
    );
    // Raised BEFORE the event is flipped to completed. final_position is an
    // absolute write derived from the finished bracket, so re-running finalize
    // recomputes the same map and overwrites the rows that did land — the
    // retry is idempotent. Flipping the status first is what used to make a
    // half-positioned event unfixable: finalizeEvent refuses anything that is
    // not live, so there was no second attempt to be had.
    assertWritesSucceeded('Assigning final positions', failures);
  }

  // Assign points based on format. Compute (id → points) in memory then issue
  // one parallel batch of UPDATEs.
  //
  // A pool_to_bracket event is scored on POSITION, like the knockout it ends
  // in, and not on the round robin's 3-per-win. Everybody in it now has a
  // final_position — the qualifiers from the bracket, the rest from the pool
  // table — so the position ladder covers the whole field, and it is the one
  // that reflects what the event was actually for. It also keeps the pool from
  // outscoring the knockout: five pool wins would be 16 points on the
  // round-robin rule, more than the 10 a beaten quarter-finalist takes.
  const pointsMap = new Map<string, number>();
  if (knockout) {
    // Position-based points: 1st=100, 2nd=75, 3rd=50, 4th=40, 5th-8th=25, else 10
    //
    // THIRD AND FOURTH ARE NOT THE SAME, at the club owner's instruction. They
    // used to share 50, which made the third-place play-off — a best of 3 to 21,
    // the same length as the final — decide a label and nothing else. A club
    // does not ask two people to play a deciding match for identical reward.
    //
    // 40 rather than 25: fourth still reached a semi-final and must stay clear
    // of the quarter-final band, so the gap says "you lost the play-off", not
    // "you went out a round earlier".
    //
    // Where there was NO play-off the two are genuinely unseparated, but they
    // still hold distinct final_positions (assigned by the tiebreak), so this
    // splits them anyway. That is the pre-existing behaviour of that tiebreak
    // rather than something introduced here, and it is why the RESULTS table
    // only says "3rd place" when a play-off was actually played.
    const { data: allEntries } = await adminClient.from(table)
      .select('id, final_position')
      .eq('event_id', eventId)
      .not('final_position', 'is', null);
    for (const entry of allEntries ?? []) {
      const pos = entry.final_position!;
      let pts: number;
      if (pos === 1) pts = 100;
      else if (pos === 2) pts = 75;
      else if (pos === 3) pts = 50;
      else if (pos === 4) pts = 40;
      else if (pos <= 8) pts = 25;
      else pts = 10;
      pointsMap.set(entry.id, pts);
    }
  } else {
    // Round Robin: 3 points per win, 1 point for participation
    const [rrMatchesRes, allEntriesRes] = await Promise.all([
      adminClient.from('tournament_matches')
        .select('winner_pair_id, winner_participant_id')
        .eq('event_id', eventId)
        .in('status', ['completed', 'walkover']),
      adminClient.from(table)
        .select('id')
        .eq('event_id', eventId)
        .not('status', 'in', '("withdrawn","disqualified")'),
    ]);
    for (const e of allEntriesRes.data ?? []) pointsMap.set(e.id, 1); // 1 participation point
    for (const m of rrMatchesRes.data ?? []) {
      const winnerId = (doubles ? m.winner_pair_id : m.winner_participant_id) as string | null;
      if (winnerId && pointsMap.has(winnerId)) {
        pointsMap.set(winnerId, (pointsMap.get(winnerId) ?? 0) + 3);
      }
    }
  }

  if (pointsMap.size > 0) {
    const { failures } = await settleWrites(
      [...pointsMap.entries()].map(([id, pts]) => [
        `${table}.points for ${id}`,
        adminClient.from(table).update({ points: pts }).eq('id', id),
      ] as const)
    );
    // Also absolute, also before the status flip, for the same reason.
    assertWritesSucceeded('Assigning tournament points', failures);
  }
  return positionMap;
}

/**
 * Redo a finalised event's standings after its results were corrected.
 *
 * Called automatically by the corrective actions, so nobody has to remember.
 * Positions and points are absolute writes derived from the finished bracket,
 * so this is idempotent and safe to run whenever a completed event changes.
 *
 * Returns the placements that MOVED, and whether any of them had already been
 * paid a placement bonus. Bonuses are not redone: they were added straight into
 * the players' ratings and there is no reversal for them, so quietly paying a
 * new champion (and not unpaying the old one) would be worse than saying so.
 */
export async function recomputeEventStandings(eventId: string): Promise<{
  moved: Array<{ id: string; from: number | null; to: number }>;
  bonusesAlreadyPaid: boolean;
}> {
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  // Only a finished event has standings to redo. A live one gets them when it
  // is finalised.
  if (event.status !== 'completed') return { moved: [], bonusesAlreadyPaid: false };

  const doubles = isDoublesEvent(event.event_type);
  const table = doubles ? 'tournament_pairs' : 'tournament_participants';

  const { data: before } = await adminClient.from(table)
    .select('id, final_position')
    .eq('event_id', eventId);
  const previous = new Map<string, number | null>(
    (before ?? []).map(r => [r.id as string, (r.final_position ?? null) as number | null]),
  );

  const positionMap = await assignPositionsAndPoints(adminClient, event, eventId, doubles, table);

  const moved: Array<{ id: string; from: number | null; to: number }> = [];
  for (const [id, to] of positionMap) {
    const from = previous.get(id) ?? null;
    if (from !== to) moved.push({ id, from, to });
  }

  const ledger = await readBonusLedger(adminClient, eventId);
  const bonusesAlreadyPaid = ledger.ratedPlayers.size > 0 || ledger.creditedParticipants.size > 0;

  if (moved.length > 0) {
    await logAudit(adminClient, {
      tournament_id: event.tournament_id,
      event_id: eventId,
      action: 'standings_recomputed',
      performed_by: (await requireCapability('tournaments.results.standings.write')).id,
      details: { moved, bonuses_already_paid: bonusesAlreadyPaid },
    });
  }

  revalidateEventPaths(event.tournament_id, eventId);
  return { moved, bonusesAlreadyPaid };
}

export async function finalizeEvent(eventId: string) {
  const admin = await requireCapability('tournaments.results.finalize.write');
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) throw new Error('Event not found');
  if (event.status !== 'live') throw new ExpectedError('Event must be live to finalize');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  const doubles = isDoublesEvent(event.event_type);

  // Check all matches are complete — single query selects all incomplete rows
  // with the participant fields we need to filter unused bracket slots in memory.
  const { data: incompleteMatches } = await adminClient.from('tournament_matches')
    .select('id, participant_a_id, participant_b_id, pair_a_id, pair_b_id')
    .eq('event_id', eventId)
    .not('status', 'in', '("completed","walkover","voided","bye")')
    .not('is_bye', 'eq', true);

  // THE SAME PREDICATE THE COMPLETION CLASSIFIER USES
  // (classifyEventForCompletion, shared/utils/tournament-withdrawal.ts), so the
  // console's "this event is ready to finalise" and this refusal are one piece
  // of arithmetic rather than two that agree today.
  //
  // A BEHAVIOURAL NO-OP HERE, and deliberately so. The projection above selects
  // neither `status` nor `is_bye`, so both of the predicate's first two clauses
  // read `undefined` and are inert on this call site — the query already
  // filtered the settled statuses and the byes server-side, and what is left is
  // character for character the participant/pair test this line always was.
  // The fetch was NOT widened: `.not('is_bye', 'eq', true)` drops rows where
  // is_bye IS NULL (NOT (NULL = true) is NULL) whereas the TS predicate's
  // `is_bye === true` keeps them, so the shared side counts MORE rows as
  // incomplete than the query does. That divergence pushes towards refusing to
  // finalise, never towards finalising something unfinished, and widening the
  // fetch in the highest-risk function in the codebase buys nothing.
  const realIncomplete = (incompleteMatches ?? []).filter(m => isRealIncompleteMatch(m, doubles));

  if (realIncomplete.length > 0) {
    throw new Error(`${realIncomplete.length} match(es) still incomplete`);
  }

  const table = doubles ? 'tournament_pairs' : 'tournament_participants';
  const positionMap = await assignPositionsAndPoints(adminClient, event, eventId, doubles, table);

  // Set event to completed. Checked: throwing on the two batches above buys
  // nothing if the flip that ends the event can itself be lost silently.
  //
  // Conditional on the event still being LIVE, which turns this into the claim
  // that decides who finalises. Both officials passed the `status !== 'live'`
  // read at the top against the same row, and everything expensive — placement
  // bonuses above all — happens BELOW this line. Without the condition both
  // proceeded, and because applyPlacementBonuses reads its ledger before it
  // writes it, both read an empty ledger and both awarded the bonus: the
  // champion took +32 twice, and because those writes are absolute
  // read-then-write they could also erase a rating change made in between.
  //
  // The count is how the loser finds out. PostgREST reports "matched no rows"
  // as success, so without it the second official would sail on into the bonus
  // code believing they had just completed the event.
  const { error: completeError, count: completeCount } = await adminClient.from('tournament_events')
    .update({ status: 'completed', updated_at: new Date().toISOString() }, { count: 'exact' })
    .eq('id', eventId)
    .eq('status', 'live');
  if (completeError) {
    throw new Error(`Positions and points were saved but the event could not be marked completed: ${completeError.message}`);
  }
  if (completeCount === 0) {
    // Positions and points were rewritten with the same values the winner of the
    // race wrote, so nothing is damaged — but the bonus must not be paid twice.
    throw new ExpectedError(
      'This event was finalised while you were finalising it — most likely another desk got there first. Reload to see the results.',
    );
  }

  // Apply placement bonuses only if BOTH the global master switch and the
  // per-event column allow it. The global check has to happen here rather than
  // being left to applyPlacementBonuses' throw: by this point the event is
  // already marked completed, and throwing would skip the audit log and the
  // participant notifications below, leaving a finalise that looks broken.
  // Disabled bonuses are a configuration, not an error.
  //
  // A bonus FAILURE is a different matter from bonuses being switched off, and
  // it is held rather than thrown immediately: the event is already completed,
  // so the audit row and the "results are up" notification below are owed to
  // everyone regardless. The error is re-raised at the end so the exec still
  // sees that the ratings are short.
  const bonusSettings = await getTournamentBonusSettings(adminClient);
  let bonusError: unknown = null;
  if (event.placement_bonus_enabled && bonusSettings.enabled) {
    try {
      await applyPlacementBonuses(eventId);
    } catch (err) {
      bonusError = err;
    }
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: eventId,
    action: 'event_finalized',
    performed_by: admin.id,
  });

  // Notify all participants that event is completed
  const finalPlayerIds: string[] = [];
  if (doubles) {
    const { data: allPairs } = await adminClient.from('tournament_pairs')
      .select('player1_id, player2_id')
      .eq('event_id', eventId)
      .not('status', 'in', '("withdrawn","disqualified")');
    for (const pair of allPairs ?? []) {
      finalPlayerIds.push(pair.player1_id, pair.player2_id);
    }
  } else {
    const { data: allParts } = await adminClient.from('tournament_participants')
      .select('player_id')
      .eq('event_id', eventId)
      .not('status', 'in', '("withdrawn","disqualified")');
    for (const p of allParts ?? []) {
      finalPlayerIds.push(p.player_id);
    }
  }
  const { data: tInfo } = await adminClient.from('tournaments').select('name').eq('id', event.tournament_id).single();
  await notifyPlayers(adminClient, finalPlayerIds,
    'Tournament Completed',
    `${tInfo?.name ?? 'Tournament'} has been finalized. Check the results and your updated Elo rating!`,
    { event_id: eventId, tournament_id: event.tournament_id },
    'tournament_event_completed'
  );

  revalidateEventPaths(event.tournament_id, eventId);

  if (bonusError) throw bonusError;
}
