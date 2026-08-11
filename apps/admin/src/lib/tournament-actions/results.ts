'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { runAction, type ActionResult } from '../action-result';
import { recomputeEventStandings } from './finalize';
import { isDoublesEvent, getEventRules, describeMatchShape, isLegalGameScore, isLegalGameCount, ExpectedError } from '@badminton/shared';
import type { TournamentEventType, TournamentMatchFormat, EventMatchShape } from '@badminton/shared';
import {
  requireCapability,
  revalidateEventPaths,
  notifyPlayers,
  applyTournamentMatchElo,
  reverseEloSnapshot,
  assertTournamentNotSuspended,
  advanceWinner,
  advanceLoser,
  recordWalkover,
  undoDecidedResult,
  entrySideField,
  routeOf,
  routedEntryId,
  MATCH_ROUTES,
  type MatchRoute,
} from './_internal';

// ============================================================
// Score Entry & Advancement
// ============================================================

// Pull `entryId` back out of a slot this match feeds and demote the
// downstream match back to 'pending' — 'ready' and 'live' both assert both
// sides are known, and one of them just stopped being known.
//
// The write is conditional on the slot actually still holding this match's
// entry. A slot can also be set by hand (setMatchEntry) or by a neighbouring
// match, and blindly nulling it would silently undo somebody else's correction.
// Returns whether anything was cleared, for the audit trail.
async function clearRoutedEntry(
  adminClient: ReturnType<typeof createAdminClient>,
  match: Record<string, unknown>,
  entryId: string,
  doubles: boolean,
  route: MatchRoute,
): Promise<boolean> {
  const target = routeOf(match, route);
  if (!target) return false;

  const field = entrySideField(target.side, doubles);

  const { data: next } = await adminClient.from('tournament_matches')
    .select('*')
    .eq('id', target.nextId)
    .single();
  if (!next) return false;

  const nextRow = next as Record<string, unknown>;
  if (nextRow[field] !== entryId) return false;

  // The `.eq(field, entryId)` is the condition, not the read above it. The read
  // decides whether to attempt the clear; this filter is what makes the clear
  // itself safe, because another desk can fill that slot between the two. Without
  // it a void racing a manual setMatchEntry would null out the entry somebody had
  // just placed by hand, and the count would still report success.
  const { count } = await adminClient.from('tournament_matches')
    .update({
      [field]: null,
      status: nextRow.status === 'ready' || nextRow.status === 'live' ? 'pending' : (nextRow.status as string),
      updated_at: new Date().toISOString(),
    }, { count: 'exact' })
    .eq('id', target.nextId)
    .eq(field, entryId);

  // PostgREST reports "matched no rows" as success, so the count is the only way
  // to tell a clear that fired from one that was overtaken. Reported rather than
  // thrown: the caller's own action (the void, the undo) has already happened and
  // is correct; what is not true any more is that a slot was cleared, and the
  // audit row should not claim it was.
  return (count ?? 0) > 0;
}

// Take this match's winner out of the next round AND its loser out of the
// third-place playoff (00080). Both, always: a semi-final that is being erased
// has put two entries somewhere, and clearing only the winner is how the
// playoff ends up advertising a semi-finalist whose semi-final no longer
// happened.
async function clearAdvancedEntries(
  adminClient: ReturnType<typeof createAdminClient>,
  match: Record<string, unknown>,
  doubles: boolean,
): Promise<{ winner: boolean; loser: boolean }> {
  const cleared = { winner: false, loser: false };
  for (const route of MATCH_ROUTES) {
    const entryId = routedEntryId(match, route, doubles);
    if (!entryId) continue;
    cleared[route] = await clearRoutedEntry(adminClient, match, entryId, doubles, route);
  }
  return cleared;
}

// Refuse when a match this one feeds has already been decided. Rewinding an
// earlier round underneath a played later round would leave a recorded result
// for an entry that is no longer in that half of the draw.
//
// BOTH routes are checked. A semi-final feeds the final with its winner and —
// once an event has a third-place playoff — feeds that playoff with its loser.
// The playoff is not a lesser match: it has a real result and a real Elo delta,
// and rewriting the semi-final underneath it would leave that result attributed
// to somebody who is no longer a semi-final loser. Checking only
// winner_to_match_id would have let exactly that through.
async function assertDownstreamUndecided(
  adminClient: ReturnType<typeof createAdminClient>,
  match: Record<string, unknown>,
  what: string,
) {
  for (const route of MATCH_ROUTES) {
    const target = routeOf(match, route);
    if (!target) continue;

    const { data: nextMatch, error } = await adminClient.from('tournament_matches')
      .select('status, is_third_place')
      .eq('id', target.nextId)
      .single();

    // A FAILED READ is not "no downstream result". The error was being dropped,
    // which left `nextMatch` null and the guard silently satisfied — so a
    // transient read failure was a way past the one check standing between a
    // correction and a played final. Refuse instead; the caller can retry.
    if (error) {
      throw new Error(
        `Could not check whether the next match already has a result (${error.message}), ` +
        `so it is not safe to ${what}. Try again.`,
      );
    }

    if (nextMatch && (nextMatch.status === 'completed' || nextMatch.status === 'walkover')) {
      throw new ExpectedError(
        nextMatch.is_third_place
          ? `Cannot ${what} — the third-place match already has a result. Undo that one first.`
          : `Cannot ${what} — the next match already has a result. Undo that one first.`,
      );
    }
  }
}

// Refuse a result whose declared winner is not the side that actually won more
// games.
//
// The dialog derives winnerSide from the scores it collected, so the UI could
// never produce a disagreement — but the server action is the integrity
// boundary, and it is directly invocable. Without this, scores of
// [21-10, 21-12] with winnerSide 'b' stored side B as the winner, handed B the
// WINNER's Elo delta, and advanced B in the bracket having lost 2-0.
//
// The tie case lives here rather than in the caller so both entry points get it:
// enterMatchResult also rejects ties via isLegalGameCount, but editMatchResult
// runs no score legality checks at all.
//
// Same refusal apply_match_result raises for challenges ('winner_side does not
// match game scores'), so the two rating engines report it identically.
// Not exported: this is a 'use server' module, where every export must be an
// async server action. Both call sites are in this file.
function assertWinnerMatchesScores(
  scores: Array<{ a: number; b: number }>,
  winnerSide: 'a' | 'b',
): void {
  // No games at all is a walkover, whose winner is decided by the forfeit and
  // not by a scoreline. editMatchResult can legitimately re-rate one, so
  // rejecting an empty score list here as a 0-0 tie would take away the only
  // way to correct it. enterMatchResult never reaches this case: isLegalGameCount
  // rejects 0-0 before the call, because the winner must reach the clinch.
  if (scores.length === 0) return;

  const aGames = scores.filter((g) => g.a > g.b).length;
  const bGames = scores.filter((g) => g.b > g.a).length;

  if (aGames === bGames) {
    throw new ExpectedError(
      `Games won are tied at ${aGames}-${bGames} — there is no winner to record.`,
    );
  }

  const derived: 'a' | 'b' = aGames > bGames ? 'a' : 'b';
  if (derived !== winnerSide) {
    throw new ExpectedError(
      `Side ${derived.toUpperCase()} won ${Math.max(aGames, bGames)}-${Math.min(aGames, bGames)}, ` +
      `so the result cannot be recorded for side ${winnerSide.toUpperCase()} — ` +
      `winner_side does not match game scores.`,
    );
  }
}

/**
 * Pin an in-flight match update to the occupants this request READ.
 *
 * The status alone is not enough. Another desk can clear a slot (ready ->
 * pending), put a different entry in it (pending -> ready), and the status is
 * back to what we read — so a stale write lands and stamps a winner who is no
 * longer in the match. The bracket then holds one pair of names while the result
 * holds another, and finalizeEvent trusts the result fields without ever reading
 * the slots.
 *
 * A NULL slot is SKIPPED rather than matched. PostgREST renders `.eq(col, null)`
 * as `col=eq.null`, and in SQL `NULL = NULL` is unknown, so including it would
 * match zero rows and report every edit of an unopposed walkover — which
 * legitimately has one empty side — as "another desk got there first". Nothing
 * is lost by skipping: filling an empty slot moves the status, which the status
 * condition already catches.
 */
function matchSlotFilter<T extends { eq(column: string, value: string): T }>(
  update: T,
  match: Record<string, unknown>,
  doubles: boolean,
): T {
  const sides = doubles
    ? ([['pair_a_id', match.pair_a_id], ['pair_b_id', match.pair_b_id]] as const)
    : ([['participant_a_id', match.participant_a_id], ['participant_b_id', match.participant_b_id]] as const);
  let out = update;
  for (const [column, value] of sides) {
    if (typeof value === 'string') out = out.eq(column, value);
  }
  return out;
}

// Gate shared by the corrective actions (void / restore / slot editing). Results
// can only be changed once the event is genuinely under way; 'completed' is
// allowed too so a finished event can still be fixed.
function assertEventResultsMutable(event: Record<string, unknown>, action: string) {
  if (event.status !== 'live' && event.status !== 'completed') {
    throw new ExpectedError(`Start the event before ${action}.`);
  }
}

async function enterMatchResultImpl(
  matchId: string,
  scores: Array<{ a: number; b: number }>,
  winnerSide: 'a' | 'b',
  timeExceeded: boolean
) {
  const admin = await requireCapability('tournaments.results.enter.write');
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (!match) throw new Error('Match not found');
  if (match.status !== 'pending' && match.status !== 'ready' && match.status !== 'live') {
    throw new Error('Match is not in a playable state');
  }

  const event = match.event as Record<string, unknown>;
  await assertTournamentNotSuspended(adminClient, event.tournament_id as string);
  // The event must actually be under way. match.status alone does not say so:
  // a match is created 'pending' the moment the bracket is generated, which is
  // one step BEFORE the event goes live (registration -> checkin ->
  // bracket_generated -> live). Without this, results could be recorded — and
  // Elo applied — for a tournament that had not started.
  if (event.status !== 'live') {
    throw new ExpectedError(
      event.status === 'completed'
        ? 'This event is finished. Edit the result instead of entering a new one.'
        : 'Start the event before entering results.',
    );
  }

  // The event's typed shape wins over the match_format enum when it has one
  // (00046) — a pool run at 1 game to 15 must reject a 21-19 that the enum
  // fallback would have waved through.
  const shape = event as unknown as EventMatchShape;
  const matchFormat = event.match_format as TournamentMatchFormat;
  const games = shape.games_per_match ?? null;
  const points = shape.points_per_game ?? null;
  const shapeLabel = describeMatchShape(shape);
  const maxGames = getEventRules(shape).bestOf;
  if (scores.length > maxGames) {
    throw new ExpectedError(`Too many games for ${shapeLabel}. Max: ${maxGames}`);
  }

  // Same scoring rules challenges get (00030): a game is won by reaching the
  // target with a two-point margin or by taking the cap, and a best-of-N stops
  // the moment someone clinches. Previously tournaments only checked the number
  // of games, so an impossible 21-20 — or a 3-0 best-of-3 — was accepted here
  // even though the identical result was rejected on the challenge path.
  //
  // timeExceeded relaxes the first of those rules only (00047): the exec called
  // time on a game that had not finished, so it owes nothing to the target or
  // the margin — but it still needs a winner and still cannot exceed the cap.
  // This check, not the dialog's toggle, is what enforces it: the toggle is a
  // client-supplied boolean like the scores themselves, so it decides which
  // rules apply here rather than deciding anything on its own.
  for (const g of scores) {
    // Typed format (games/points) decides the rules; timeExceeded decides
    // WHICH rules — a match cut short is bounded by the cap alone.
    if (!isLegalGameScore(g.a, g.b, matchFormat, games, points, timeExceeded)) {
      throw new ExpectedError(
        timeExceeded
          ? `Not a possible score even for a match cut short: ${g.a}-${g.b}`
          : `Not a possible score for ${shapeLabel}: ${g.a}-${g.b}. If the clock ran out mid-game, mark the match time exceeded.`,
      );
    }
  }
  // The clinch rule is untouched by the clock. A best-of-3 called at 1-0 has no
  // winner to record, however the games themselves ended.
  const aGames = scores.filter((g) => g.a > g.b).length;
  const bGames = scores.filter((g) => g.b > g.a).length;
  if (!isLegalGameCount(Math.max(aGames, bGames), Math.min(aGames, bGames), matchFormat, games)) {
    throw new ExpectedError(
      `${aGames}-${bGames} is not a possible result for ${shapeLabel} — the match ends once a side clinches.`
    );
  }

  // ...and the declared winner has to be the side that won those games. The
  // count check above passes for a legal 2-0 no matter WHO the caller then names
  // as the winner.
  assertWinnerMatchesScores(scores, winnerSide);

  const doubles = isDoublesEvent(event.event_type as TournamentEventType);

  // Determine winner and loser IDs
  let winnerIdField: string;
  let loserIdField: string;
  let winnerId: string;
  let loserId: string;

  if (doubles) {
    winnerId = winnerSide === 'a' ? match.pair_a_id : match.pair_b_id;
    loserId = winnerSide === 'a' ? match.pair_b_id : match.pair_a_id;
    winnerIdField = 'winner_pair_id';
    loserIdField = 'loser_pair_id';
  } else {
    winnerId = winnerSide === 'a' ? match.participant_a_id : match.participant_b_id;
    loserId = winnerSide === 'a' ? match.participant_b_id : match.participant_a_id;
    winnerIdField = 'winner_participant_id';
    loserIdField = 'loser_participant_id';
  }

  // Update match
  // time_exceeded rides along with the scores it explains (00047) — without it
  // on the row, a later reader cannot tell a called-for-time 15-2 from a typo.
  //
  // Conditional on the status this request READ, which makes the write a
  // compare-and-swap rather than a blind overwrite. Two desks entering the same
  // match at once both passed the playable-status check above against the same
  // row; without this, both write a result and both go on to rate it, and the
  // loser of that race only finds out inside the rating RPC — with a result
  // already stamped over the winner's. The count is how the loser finds out
  // here instead, because PostgREST reports "matched no rows" as success.
  const update = adminClient.from('tournament_matches').update({
    scores,
    time_exceeded: timeExceeded,
    [winnerIdField]: winnerId,
    [loserIdField]: loserId,
    status: 'completed',
    result_entered_by: admin.id,
    result_entered_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { count: 'exact' })
    .eq('id', matchId)
    .eq('status', match.status)
    // The OCCUPANTS as well as the status, because status alone admits an ABA.
    // Another desk can clear a slot (ready -> pending), put a different entry in
    // it (pending -> ready), and the status this request read is true again — so
    // the stale write lands, stamping a winner who is no longer in the match.
    // The bracket then holds one pair of names and the result holds another, and
    // finalizeEvent trusts the result fields without ever reading the slots.
    ;
  const { error, count } = await matchSlotFilter(update, match, doubles);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  if (count === 0) {
    throw new ExpectedError(
      'This match changed while you were entering the result — most likely another desk got there first. Reload and check before entering it again.',
    );
  }

  // Apply Elo before advancing — advancing can settle the next match too (if
  // the opponent waiting there has since withdrawn), and those ratings must
  // build on this one.
  //
  // The result row above is already written, because rating reads the winner and
  // loser off it. If rating then fails — a missing ratings row is the case that
  // actually happens — the match would be left completed and unrated, and the
  // guard at the top of this function refuses anything that is not
  // pending/ready/live, so no retry could reach it. undoDecidedResult takes the
  // result back off and rethrows, leaving a match the desk can simply re-enter.
  // Nothing has advanced yet, so there is nothing downstream to unwind.
  try {
    await applyTournamentMatchElo(matchId);
  } catch (err) {
    await undoDecidedResult(adminClient, matchId, match, err);
  }

  // Advance winner to next match (single elimination only). Advancing can also
  // settle that match outright — the opponent waiting there may have withdrawn
  // since the draw was published.
  await advanceWinner(adminClient, match, doubles, winnerId, admin.id);

  // ...and the loser into the third-place playoff, if this is a semi-final in an
  // event that has one. A no-op everywhere else — loser_to_match_id is null.
  await advanceLoser(adminClient, match, doubles, loserId, admin.id);

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    action: 'result_entered',
    performed_by: admin.id,
    details: { scores, winner_side: winnerSide, time_exceeded: timeExceeded },
  });

  // Notify both players of match result
  const matchPlayerIds: string[] = [];
  if (doubles) {
    for (const pairId of [match.pair_a_id, match.pair_b_id].filter(Boolean)) {
      const { data: pair } = await adminClient.from('tournament_pairs').select('player1_id, player2_id').eq('id', pairId).single();
      if (pair) { matchPlayerIds.push(pair.player1_id, pair.player2_id); }
    }
  } else {
    for (const pid of [match.participant_a_id, match.participant_b_id].filter(Boolean)) {
      const { data: p } = await adminClient.from('tournament_participants').select('player_id').eq('id', pid).single();
      if (p) matchPlayerIds.push(p.player_id);
    }
  }
  await notifyPlayers(adminClient, matchPlayerIds,
    'Match Result Confirmed',
    `Your match result has been recorded. Score: ${scores.map((s: { a: number; b: number }) => `${s.a}-${s.b}`).join(', ')}`,
    // tournament_id as well as event_id: the player app links a tournament
    // notification at /tournaments/[id]/events/[eventId], so an event id on its
    // own is not a route. This was the one producer that omitted it — the
    // bracket and finalize notifications (brackets.ts, finalize.ts) have always
    // written both — which is why /notifications carries a back-fill query.
    { match_id: matchId, event_id: match.event_id, tournament_id: event.tournament_id as string },
    'tournament_match_result'
  );

  revalidateEventPaths(event.tournament_id as string, match.event_id as string);
}

async function enterWalkoverImpl(
  matchId: string,
  winnerPosition: 'a' | 'b',
  reason: string
) {
  const admin = await requireCapability('tournaments.results.walkover.write');
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (!match) throw new Error('Match not found');
  // Same guard as enterMatchResult — without it, re-running a walkover on an
  // already-decided match applies a second Elo delta and overwrites the
  // elo_snapshot, making the first delta permanently irreversible.
  if (match.status !== 'pending' && match.status !== 'ready' && match.status !== 'live') {
    throw new Error('Match is not in a playable state');
  }

  const event = match.event as Record<string, unknown>;
  await assertTournamentNotSuspended(adminClient, event.tournament_id as string);
  // The event must actually be under way. match.status alone does not say so:
  // a match is created 'pending' the moment the bracket is generated, which is
  // one step BEFORE the event goes live (registration -> checkin ->
  // bracket_generated -> live). Without this, results could be recorded — and
  // Elo applied — for a tournament that had not started.
  if (event.status !== 'live') {
    throw new ExpectedError(
      event.status === 'completed'
        ? 'This event is finished. Edit the result instead of entering a new one.'
        : 'Start the event before entering results.',
    );
  }

  const doubles = isDoublesEvent(event.event_type as TournamentEventType);

  // Computed here only to validate the target before delegating. A half-filled
  // match is a legitimate walkover target — it is how an admin pushes a lone
  // semi-finalist forward when the other side of the draw died (voided
  // quarter-final, both-skip branch). So an EMPTY OPPOSITE side is fine; an
  // empty WINNING side is not, and used to write a null winner and then
  // "advance" that null into the next round.
  //
  // An unopposed walkover stays unrated on purpose: applyTournamentMatchElo
  // bails when either side is missing, so no delta and no elo_snapshot is
  // written. Rating someone for a match nobody turned up to would be free Elo.
  const winnerId = (doubles
    ? (winnerPosition === 'a' ? match.pair_a_id : match.pair_b_id)
    : (winnerPosition === 'a' ? match.participant_a_id : match.participant_b_id)) as string | null;

  if (!winnerId) {
    throw new ExpectedError('That side of the match is empty — there is nobody to award the walkover to.');
  }

  // The row write, Elo and advancement all live in recordWalkover so that a
  // withdrawal-driven forfeit and a manually entered walkover cannot drift
  // apart — they are the same event with different triggers.
  await recordWalkover(adminClient, match, doubles, winnerPosition, reason, admin.id);

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    action: 'walkover_entered',
    performed_by: admin.id,
    details: { winner_position: winnerPosition, reason },
  });

  revalidateEventPaths(event.tournament_id as string, match.event_id as string);
}

async function voidMatchImpl(matchId: string, reason: string) {
  const admin = await requireCapability('tournaments.results.void.write');
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (!match) throw new Error('Match not found');

  const event = match.event as Record<string, unknown>;

  // Same gate as entering a result or a walkover. Voiding a match in an event
  // that has not started is meaningless — there is nothing to undo — and it
  // was the one action in this module that skipped the check.
  assertEventResultsMutable(event, 'voiding matches');

  if (match.status === 'voided') {
    throw new ExpectedError('This match is already voided. Restore it if it needs to be played.');
  }
  // A bye is a bracket artefact, not a played match: it has no losing side and
  // its winner was placed there by the generator. Voiding one would strand that
  // entry with no route back into the draw.
  if (match.is_bye) {
    throw new ExpectedError('A bye is not a played match. Edit the next round\'s slots instead.');
  }

  const doubles = isDoublesEvent(event.event_type as TournamentEventType);

  await assertDownstreamUndecided(adminClient, match, 'void');

  // A voided match is unrated by definition — applyTournamentMatchElo refuses to
  // rate one. But voiding used to leave an already-applied delta sitting on the
  // players' ratings along with the elo_snapshot that produced it, so a voided
  // match still moved Elo and (for round robin, where nothing else notices) did
  // so invisibly. Reverse it here.
  //
  // Reversing is also what makes restore-and-replay safe: reverseEloSnapshot
  // clears elo_snapshot, and applyTournamentMatchElo returns early whenever a
  // snapshot is present, so a replayed match applies exactly one delta.
  const reversedElo = Boolean(match.elo_snapshot);
  if (reversedElo) {
    await reverseEloSnapshot(adminClient, matchId);
  }

  // Take the voided match's winner back out of the next round, and its loser
  // back out of the third-place playoff. Leaving either parked is how a bracket
  // ends up advertising a match between a real player and a result that has
  // been erased.
  const cleared = await clearAdvancedEntries(adminClient, match, doubles);

  // Scores and winner/loser are deliberately kept: a voided match is excluded
  // from standings, finalisation and Elo by status alone, and keeping the row
  // intact means the audit trail and the bracket still show what was erased.
  await adminClient.from('tournament_matches').update({
    status: 'voided',
    notes: reason,
    updated_at: new Date().toISOString(),
  }).eq('id', matchId);

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    action: 'match_voided',
    performed_by: admin.id,
    details: {
      reason,
      reversed_elo: reversedElo,
      cleared_next_slot: cleared.winner,
      cleared_third_place_slot: cleared.loser,
    },
  });

  revalidateEventPaths(event.tournament_id as string, match.event_id as string);
}

// ============================================================
// Double no-show — nobody turned up
// ============================================================
//
// enterWalkover is typed `winnerPosition: 'a' | 'b'`, so it cannot express
// "neither side came". Before this, the desk had to do three separate things in
// the right order — mark both participants no_show, void the match, then walk
// the survivor of the OTHER half into the next round — and stopping halfway
// left both players flagged while the match still advertised READY.
//
// Doing it as one action also lets the audit row say what actually happened.
// A voided match records only "voided": nothing distinguishes "nobody came"
// from "the score was entered against the wrong pair".
async function recordDoubleNoShowImpl(matchId: string, reason: string) {
  const admin = await requireCapability('tournaments.results.doublenoshow.write');
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();
  if (!match) throw new ExpectedError('Match not found');

  const event = match.event as Record<string, unknown>;
  assertEventResultsMutable(event, 'recording a no-show');

  if (match.status === 'completed' || match.status === 'walkover') {
    throw new ExpectedError('This match already has a result. Undo it first.');
  }
  if (match.status === 'voided') {
    throw new ExpectedError('This match is already voided.');
  }
  // A bye has one real side by construction; "nobody came" cannot describe it.
  if (match.is_bye) {
    throw new ExpectedError('A bye is not a played match.');
  }

  const doubles = isDoublesEvent(event.event_type as TournamentEventType);
  const aId = (doubles ? match.pair_a_id : match.participant_a_id) as string | null;
  const bId = (doubles ? match.pair_b_id : match.participant_b_id) as string | null;

  // Both sides must actually be known. One empty side is not a double no-show —
  // it is an unopposed walkover, and routing it here would mark a phantom
  // entry absent and deny the present player their advance.
  if (!aId || !bId) {
    throw new ExpectedError(
      'Only one side is filled — award the walkover to whoever turned up instead.',
    );
  }

  await assertDownstreamUndecided(adminClient, match, 'record a no-show');

  // Unplayed, so unrated. If a result had already been applied, its delta is
  // still sitting on the players' ratings — reverse it for the same reason
  // voiding does, or the match keeps moving Elo after being erased.
  const reversedElo = Boolean(match.elo_snapshot);
  if (reversedElo) {
    await reverseEloSnapshot(adminClient, matchId);
  }

  // Nobody advances. Anyone previously parked in the next round — or in the
  // third-place playoff — on the strength of this match comes back out.
  const cleared = await clearAdvancedEntries(adminClient, match, doubles);

  // Mark both entries absent. This is the half that feeds reliability —
  // check_noshow_threshold auto-flags at 3 and auto-suspends at 5 — and it is
  // the half most easily forgotten when doing this by hand.
  const entryTable = doubles ? 'tournament_pairs' : 'tournament_participants';
  const { error: entryErr } = await adminClient
    .from(entryTable)
    .update({ status: 'no_show' })
    .in('id', [aId, bId]);
  if (entryErr) throw new Error(entryErr.message);

  await adminClient.from('tournament_matches').update({
    status: 'voided',
    winner_participant_id: null,
    winner_pair_id: null,
    loser_participant_id: null,
    loser_pair_id: null,
    scores: null,
    notes: reason,
    updated_at: new Date().toISOString(),
  }).eq('id', matchId);

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    // Distinct from 'match_voided' on purpose — six months on, this is the only
    // thing that says the court was empty rather than the entry being wrong.
    action: 'match_double_no_show',
    performed_by: admin.id,
    details: {
      reason,
      reversed_elo: reversedElo,
      cleared_next_slot: cleared.winner,
      cleared_third_place_slot: cleared.loser,
      entries: [aId, bId],
    },
  });

  revalidateEventPaths(event.tournament_id as string, match.event_id as string);
}

// ============================================================
// Recovery — restoring a voided match, editing draw slots
// ============================================================
//
// Voiding used to be a one-way door. A voided quarter-final can never be
// replayed (enterMatchResult only accepts pending/ready/live) and never
// advances anybody, so the semi-final it feeds sits on "TBD" forever and the
// event can never be finalised — finalizeEvent ignores voided matches but still
// counts the half-filled semi-final as incomplete. The two actions below are
// the way out: put the match back, or fill the orphaned slot by hand.

async function unvoidMatchImpl(matchId: string, reason: string) {
  const admin = await requireCapability('tournaments.results.unvoid.write');
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (!match) throw new Error('Match not found');
  if (match.status !== 'voided') {
    throw new ExpectedError('Only a voided match can be restored.');
  }

  const event = match.event as Record<string, unknown>;
  assertEventResultsMutable(event, 'restoring matches');

  const doubles = isDoublesEvent(event.event_type as TournamentEventType);
  const aId = (doubles ? match.pair_a_id : match.participant_a_id) as string | null;
  const bId = (doubles ? match.pair_b_id : match.participant_b_id) as string | null;

  // Belt and braces for rows voided before voidMatch learned to reverse Elo:
  // their delta is still on the players' ratings and their snapshot is still on
  // the row. Reversing here is what stops the replay from counting the same
  // match a second time — applyTournamentMatchElo would otherwise refuse to run
  // at all (snapshot present), silently leaving the stale delta in place.
  const reversedElo = Boolean(match.elo_snapshot);
  if (reversedElo) {
    await reverseEloSnapshot(adminClient, matchId);
  }

  // Restore to a clean playable state rather than to the old result: an admin
  // restoring a void wants to play the match, and a half-restored row carrying
  // a stale winner would advance that winner again on the next edit.
  const resetData: Record<string, unknown> = {
    scores: null,
    // 'ready' asserts both sides are known. A match voided because one half of
    // the draw collapsed may still be missing a side.
    status: aId && bId ? 'ready' : 'pending',
    walkover_winner: null,
    walkover_reason: null,
    result_entered_by: null,
    result_entered_at: null,
    notes: reason || null,
    updated_at: new Date().toISOString(),
  };

  if (doubles) {
    resetData.winner_pair_id = null;
    resetData.loser_pair_id = null;
  } else {
    resetData.winner_participant_id = null;
    resetData.loser_participant_id = null;
  }

  const { error } = await adminClient.from('tournament_matches')
    .update(resetData)
    .eq('id', matchId);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    action: 'match_unvoided',
    performed_by: admin.id,
    details: {
      reason: reason || null,
      void_reason: match.notes,
      // The discarded result only survives here, so record it.
      discarded_scores: match.scores,
      reversed_elo: reversedElo,
    },
  });

  revalidateEventPaths(event.tournament_id as string, match.event_id as string);
}

async function setMatchEntryImpl(
  matchId: string,
  side: 'a' | 'b',
  entryId: string | null,
  reason: string,
) {
  const admin = await requireCapability('tournaments.results.entry.write');
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (!match) throw new Error('Match not found');

  const event = match.event as Record<string, unknown>;
  assertEventResultsMutable(event, 'editing the draw');

  // A decided match carries an elo_snapshot keyed to the entries that played
  // it. Swapping a side out from under that snapshot makes the recorded delta
  // unattributable, so the result has to come off first.
  if (match.status === 'completed' || match.status === 'walkover') {
    throw new ExpectedError('This match already has a result. Undo it before changing who is in it.');
  }
  if (match.status === 'voided') {
    throw new ExpectedError('This match is voided. Restore it before changing who is in it.');
  }
  if (match.is_bye) {
    throw new ExpectedError('A bye is filled by the draw, not by hand.');
  }

  const doubles = isDoublesEvent(event.event_type as TournamentEventType);
  const field = entrySideField(side, doubles);
  const otherField = entrySideField(side === 'a' ? 'b' : 'a', doubles);
  const current = (match as Record<string, unknown>)[field] as string | null;
  const other = (match as Record<string, unknown>)[otherField] as string | null;

  if (entryId) {
    // Overwriting an occupied slot would quietly evict whoever earned it, so
    // make the removal an explicit second step.
    if (current && current !== entryId) {
      throw new ExpectedError('That slot is already filled. Clear it first, then set the new entry.');
    }
    if (entryId === other) {
      throw new ExpectedError('An entry cannot play itself.');
    }

    // The client sends an id from a list it rendered; re-check it here because
    // a stale page could offer an entry that has since left the event.
    const table = doubles ? 'tournament_pairs' : 'tournament_participants';
    const { data: entry } = await adminClient.from(table)
      .select('id, event_id, status')
      .eq('id', entryId)
      .maybeSingle();

    if (!entry || entry.event_id !== match.event_id) {
      throw new ExpectedError('That entry is not in this event.');
    }
    if (entry.status === 'withdrawn' || entry.status === 'disqualified') {
      throw new ExpectedError('That entry has withdrawn or been disqualified and cannot be placed in the draw.');
    }
  } else if (!current) {
    throw new ExpectedError('That slot is already empty.');
  }

  const { error } = await adminClient.from('tournament_matches').update({
    [field]: entryId,
    // 'ready' is what the bracket reads to offer score entry, so it has to
    // track whether both sides are actually known.
    status: entryId && other ? 'ready' : 'pending',
    updated_at: new Date().toISOString(),
  }).eq('id', matchId);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    action: entryId ? 'match_entry_set' : 'match_entry_cleared',
    performed_by: admin.id,
    details: { side, previous_entry_id: current, entry_id: entryId, reason: reason || null },
  });

  revalidateEventPaths(event.tournament_id as string, match.event_id as string);
}

// ============================================================
// Admin override — change a result that has already been resolved
// ============================================================
//
// WHAT WAS ACTUALLY BLOCKING THIS: nothing on the server. This function has
// existed since the schema did, it is exported from the tournament-actions
// barrel, and it was called by ZERO client code. The bracket's MatchCard gates
// both of its buttons on `!isCompleted`, so a completed or walkover match
// rendered a "Final" / "WALKOVER" label and no control at all. The only route to
// a correction was void → restore → re-enter, which throws the original result
// away and re-rates from scratch.
//
// So the fix is an affordance, not a relaxed rule. NO EXISTING GUARD IS
// WEAKENED. Two are TIGHTENED, because the new button makes reachable what was
// previously only reachable from a test:
//
//   * The downstream check is now assertDownstreamUndecided, the same one void
//     and undo use. The hand-rolled copy that lived here checked only
//     `status === 'completed'`, so a downstream WALKOVER — the shape a late
//     withdrawal produces — waved the edit straight through, and a semi-final
//     could be rewritten underneath a final that had already been forfeited and
//     rated. It also looked at winner_to_match_id alone, which since 00080
//     misses the third-place playoff entirely.
//
//   * The match must actually HAVE a result. This wrote winner/loser onto the
//     row unconditionally and then re-rated only if the status was already
//     decided — so "editing" a pending match stamped a winner on it, skipped the
//     rating, and left a match that reads as decided to every downstream reader
//     while enterMatchResult still considered it playable and would rate it.
//
// RATING REVERSAL GOES THROUGH reverse_tournament_match_rating (00078) AND
// NOWHERE ELSE. That is the one thing this function must never grow a shortcut
// for: reverseEloSnapshot is a thin wrapper over that RPC, the RPC clears the
// snapshot inside the same transaction as the deltas it subtracts, and a second
// hand-rolled reversal path is exactly how the double-reverse defect 00078
// documents came about. Reverse, then re-apply — never adjust in place.
//
// EXEC OR ADMIN, not admin-only, and that is a deliberate deviation worth
// stating. Every other corrective action in this module — void, undo, restore,
// slot editing, double no-show — sits in EXEC_BASELINE, and the tournament
// desk runs as exec, not admin. An admin-only override would mean the person
// standing at the desk at 9pm with a wrong scoreline on the board cannot fix it,
// which is the situation this was asked for. What makes the override safe is not
// a narrower role but that it is EXPLICIT and AUDITED: it demands a typed
// reason, and the audit row carries the old AND new winner, the old AND new
// scores, and whether the rating was reversed and re-applied.
async function editMatchResultImpl(
  matchId: string,
  newScores: Array<{ a: number; b: number }>,
  newWinnerSide: 'a' | 'b',
  reason: string,
) {
  const admin = await requireCapability('tournaments.results.edit.write');
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (!match) throw new ExpectedError('Match not found');

  const event = match.event as Record<string, unknown>;

  // Same gate the other corrective actions use. 'completed' is allowed, which is
  // the point — a finished event is exactly where a wrong result gets noticed.
  assertEventResultsMutable(event, 'changing a result');

  // There has to BE a result to change. A voided match has deliberately had its
  // result taken off and is restored, not edited; a pending one never had a
  // result at all, and stamping one here would bypass every score-legality check
  // enterMatchResult applies.
  if (match.status !== 'completed' && match.status !== 'walkover') {
    throw new ExpectedError(
      match.status === 'voided'
        ? 'This match is voided. Restore it and enter the result, rather than editing one that was erased.'
        : 'This match has no result yet — enter it rather than changing it.',
    );
  }

  // A BYE is status 'completed' with a winner the generator placed there and an
  // empty opposite side, so the status check above lets it straight through —
  // and "correcting" it would write a scoreline and a loser for a match nobody
  // played, then rate it. voidMatch and setMatchEntry both refuse a bye for the
  // same reason and point at the same remedy.
  if (match.is_bye) {
    throw new ExpectedError('A bye is not a played match. Edit the next round\'s slots instead.');
  }

  // The override is explicit by construction: it cannot be performed without
  // saying why, and the reason lands in the audit row below.
  if (!reason.trim()) {
    throw new ExpectedError('Give a reason — changing a result that is already recorded has to say why.');
  }

  // The integrity guard that STAYS. Rewriting a match underneath a later round
  // that has already been played would leave that later result recorded for an
  // entry which is no longer in this half of the draw — and, since 00080, would
  // do the same to a third-place playoff that has already been contested and
  // rated. The remedy is the one the message gives: undo the later match first.
  await assertDownstreamUndecided(adminClient, match, 'change this result');

  // Same integrity boundary as entering a result: correcting a match must not
  // be a way to award it to the side that lost every game. Only the winner /
  // score agreement is enforced here — the full legality checks stay off the
  // correction path on purpose, because this is the action an admin uses to
  // repair data that is already odd.
  assertWinnerMatchesScores(newScores, newWinnerSide);

  const doubles = isDoublesEvent(event.event_type as TournamentEventType);

  const winnerId = doubles
    ? (newWinnerSide === 'a' ? match.pair_a_id : match.pair_b_id)
    : (newWinnerSide === 'a' ? match.participant_a_id : match.participant_b_id);
  const loserId = doubles
    ? (newWinnerSide === 'a' ? match.pair_b_id : match.pair_a_id)
    : (newWinnerSide === 'a' ? match.participant_b_id : match.participant_a_id);

  const winnerField = doubles ? 'winner_pair_id' : 'winner_participant_id';
  const loserField = doubles ? 'loser_pair_id' : 'loser_participant_id';

  // Read before anything moves, so the audit row can say what was replaced. The
  // match row is overwritten below, so this is the only moment the previous
  // winner and loser exist to be recorded.
  const priorWinnerId = routedEntryId(match, 'winner', doubles);
  const priorLoserId = routedEntryId(match, 'loser', doubles);

  // Reverse any prior Elo changes so we can recompute with the corrected winner.
  // reverseEloSnapshot is reverse_tournament_match_rating (00078) and nothing
  // else — one transaction, snapshot cleared alongside the deltas it subtracts,
  // idempotent on a retry. Never subtract by hand here.
  const reversedElo = Boolean(match.elo_snapshot);
  if (reversedElo) {
    await reverseEloSnapshot(adminClient, matchId);
  }

  // count: 'exact' because PostgREST reports "matched no rows" as SUCCESS, and
  // the filter on the status this request read makes the write a
  // compare-and-swap. The rating has already been reversed by this point, so a
  // write that silently matched nothing would leave the match carrying its
  // ORIGINAL scoreline with that scoreline's rating stripped off the ladder —
  // and the caller would be told the correction saved.
  // Correcting a WALKOVER with a real scoreline makes it a played match, and the
  // walkover fields have to go with it. Left alone, the row said status
  // 'walkover' with walkover_winner 'a' while winner_participant_id had just
  // become B — three fields disagreeing about who won, and the bracket renders
  // "⚠ WALKOVER" over a scoreline. Going the other way (clearing the scores to
  // hand the walkover to the other side) keeps the status and moves the
  // walkover_winner, which is the same correction expressed the other way round.
  const becomesPlayed = match.status === 'walkover' && newScores.length > 0;
  const staysWalkover = match.status === 'walkover' && newScores.length === 0;

  const update = adminClient.from('tournament_matches').update({
    scores: newScores.length > 0 ? newScores : null,
    [winnerField]: winnerId,
    [loserField]: loserId,
    ...(becomesPlayed
      ? { status: 'completed', walkover_winner: null, walkover_reason: null }
      : {}),
    ...(staysWalkover ? { walkover_winner: newWinnerSide } : {}),
    result_entered_by: admin.id,
    result_entered_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { count: 'exact' })
    .eq('id', matchId)
    .eq('status', match.status)
    // The OCCUPANTS as well as the status, because status alone admits an ABA.
    // Another desk can clear a slot (ready -> pending), put a different entry in
    // it (pending -> ready), and the status this request read is true again — so
    // the stale write lands, stamping a winner who is no longer in the match.
    // The bracket then holds one pair of names and the result holds another, and
    // finalizeEvent trusts the result fields without ever reading the slots.
    ;
  const { error, count } = await matchSlotFilter(update, match, doubles);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  if (count === 0) {
    throw new Error(
      `Match ${matchId} changed while the correction was being saved, so nothing was written — but its ` +
      `previous rating WAS already reversed. Reload the bracket and check the result before saving again.`,
    );
  }

  // Re-route both sides. assertDownstreamUndecided has just guaranteed neither
  // destination has a result, so overwriting the slots outright is safe and is
  // what makes a flipped winner actually reach the next round. The loser half is
  // new with 00080: flipping a semi-final's winner also flips which entry belongs
  // in the third-place playoff, and leaving that slot alone would send the wrong
  // player out to play for third.
  for (const route of MATCH_ROUTES) {
    const target = routeOf(match, route);
    if (!target) continue;
    const entryId = route === 'winner' ? winnerId : loserId;
    if (!entryId) continue;
    await adminClient.from('tournament_matches')
      .update({ [entrySideField(target.side, doubles)]: entryId })
      .eq('id', target.nextId);
  }

  // Reapply Elo with the corrected winner. Walkovers count too — enterWalkover
  // applies Elo, so omitting them here reversed the delta above and never
  // restored it, permanently zeroing both sides' rating change. Voided matches
  // are refused outright by the status guard at the top, so the branch that used
  // to guard this call is gone rather than removed.
  //
  // A failure here cannot be compensated the way enterMatchResult's is. By this
  // point the OLD rating has already been reversed and the old scoreline it was
  // computed from has been overwritten, so there is nothing to put back — the
  // only route forward is forward. That is safe, and this is the one place worth
  // saying so out loud: the snapshot is null, so simply running the correction
  // again re-rates the match and cannot count it twice, and the status guard
  // above still accepts the retry because the match is still completed. Without
  // this message the exec is told "the rating failed" and left to guess whether
  // pressing Save again would double the delta.
  try {
    await applyTournamentMatchElo(matchId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${detail} — the corrected result for match ${matchId} WAS saved but is not yet rated. ` +
      `Save the same correction again to rate it; the previous rating is already reversed, ` +
      `so it cannot be counted twice.`,
    );
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    action: 'result_edited',
    performed_by: admin.id,
    // Old AND new, for every field this action can move. A correction that
    // changes who won is the most consequential thing in the console — it moves
    // two players' Elo, their win/loss record, their streak and their place in
    // the draw — and six months on this row is the only record that the board
    // ever said anything else.
    details: {
      reason,
      old_scores: match.scores,
      new_scores: newScores,
      old_winner_entry_id: priorWinnerId,
      new_winner_entry_id: winnerId,
      old_loser_entry_id: priorLoserId,
      new_loser_entry_id: loserId,
      new_winner_side: newWinnerSide,
      winner_changed: priorWinnerId !== winnerId,
      old_match_status: match.status,
      new_match_status: becomesPlayed ? 'completed' : match.status,
      reversed_elo: reversedElo,
      // Positions and points ARE redone now (see below); placement bonuses are
      // not, because they were added straight into the players' ratings and
      // there is no reversal for them.
      standings_recomputed: event.status === 'completed',
      event_was_finalised: event.status === 'completed',
    },
  });

  // Redo the standings the correction just invalidated.
  //
  // This used to be recorded as `standings_recomputed: false` and left there,
  // with the dialog telling the exec to "adjust those by hand" — which the
  // console cannot do: there is no editor for final_position or points. So a
  // corrected final left the old champion holding first place, 100 points and
  // the trophy while the bracket named somebody else.
  //
  // No-ops on an event that is not completed. Deliberately AFTER the audit row,
  // so the correction is on record even if this throws.
  const standings = await recomputeEventStandings(match.event_id as string);
  if (standings.moved.length > 0 && standings.bonusesAlreadyPaid) {
    // Positions and points are already fixed at this point — this is not a
    // failure, it is the one part a human still has to settle.
    throw new ExpectedError(
      `The result was corrected and the final positions and points have been recalculated, but ${standings.moved.length} placing changed on an event whose placement bonuses were already paid. ` +
      'Those bonuses went straight into the players\' ratings and nothing here can take them back — adjust them from Ratings if they matter.',
    );
  }

  revalidateEventPaths(event.tournament_id as string, match.event_id as string);
}

// ============================================================
// Undo Match Result
// ============================================================

async function undoMatchResultImpl(matchId: string) {
  const admin = await requireCapability('tournaments.results.undo.write');
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (!match) throw new Error('Match not found');
  if (match.status !== 'completed' && match.status !== 'walkover') {
    throw new Error('Match has no result to undo');
  }

  const event = match.event as Record<string, unknown>;
  const doubles = isDoublesEvent(event.event_type as TournamentEventType);

  // Check no downstream matches have results
  await assertDownstreamUndecided(adminClient, match, 'undo');

  // Reverse Elo changes (both singles and doubles) using snapshot persisted at apply time.
  // Falls back to legacy elo_before behaviour for singles matches that pre-date the snapshot column.
  //
  // The legacy branch is gated on BOTH sides existing because that is exactly
  // when applyTournamentMatchElo rates a match. An unopposed walkover (the
  // recovery path for a collapsed half of the draw) has no loser and was never
  // rated, and rewinding its winner to elo_before — a value frozen at
  // registration — would wipe every rating change they earned earlier in the
  // event.
  //
  // It is gated a second time, per side, on elo_after still being STAMPED. "No
  // snapshot" is not on its own evidence that a rating is outstanding: a
  // reversal clears the snapshot and the stamp together, in one transaction, but
  // resetting the match row below is a separate write. If that reset fails — or
  // its response is lost — the match is left decided with no snapshot, and the
  // retry would land here and overwrite both players' CURRENT rating with a
  // registration-time figure, erasing every match they have played since.
  // elo_after is what the pre-snapshot rating path wrote and what every reversal
  // clears, so its presence is the honest test for "this match's delta is still
  // on the ladder".
  if (match.elo_snapshot) {
    await reverseEloSnapshot(adminClient, matchId);
  } else if (!doubles && match.winner_participant_id && match.loser_participant_id) {
    const winnerId = match.winner_participant_id;
    const loserId = match.loser_participant_id;

    if (winnerId) {
      const { data: winnerP } = await adminClient.from('tournament_participants')
        .select('player_id, elo_before, elo_after')
        .eq('id', winnerId).single();
      if (winnerP?.elo_before != null && winnerP.elo_after != null) {
        await adminClient.from('ratings')
          .update({ singles_elo: winnerP.elo_before, updated_at: new Date().toISOString() })
          .eq('player_id', winnerP.player_id);
        await adminClient.from('tournament_participants')
          .update({ elo_after: null, elo_change: null })
          .eq('id', winnerId);
      }
    }

    if (loserId) {
      const { data: loserP } = await adminClient.from('tournament_participants')
        .select('player_id, elo_before, elo_after')
        .eq('id', loserId).single();
      if (loserP?.elo_before != null && loserP.elo_after != null) {
        await adminClient.from('ratings')
          .update({ singles_elo: loserP.elo_before, updated_at: new Date().toISOString() })
          .eq('player_id', loserP.player_id);
        await adminClient.from('tournament_participants')
          .update({ elo_after: null, elo_change: null })
          .eq('id', loserId);
      }
    }
  }

  // Remove the winner from the next match, and the loser from the third-place
  // playoff. Both, for the same reason voiding clears both: this match no longer
  // has a result, so neither entry has any claim on the slot it was routed into.
  await clearAdvancedEntries(adminClient, match, doubles);

  // Reset match itself
  const aId = (doubles ? match.pair_a_id : match.participant_a_id) as string | null;
  const bId = (doubles ? match.pair_b_id : match.participant_b_id) as string | null;
  const resetData: Record<string, unknown> = {
    scores: null,
    // Cleared with the scores it described — a match with no result cannot
    // still be claiming the clock ended it.
    time_exceeded: false,
    // 'ready' asserts both sides are known — not true when the undone result
    // was an unopposed walkover.
    status: aId && bId ? 'ready' : 'pending',
    walkover_winner: null,
    walkover_reason: null,
    result_entered_by: null,
    result_entered_at: null,
    updated_at: new Date().toISOString(),
  };

  if (doubles) {
    resetData.winner_pair_id = null;
    resetData.loser_pair_id = null;
  } else {
    resetData.winner_participant_id = null;
    resetData.loser_participant_id = null;
  }

  const { error } = await adminClient.from('tournament_matches')
    .update(resetData)
    .eq('id', matchId);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    action: 'result_undone',
    performed_by: admin.id,
    details: { previous_scores: match.scores },
  });

  revalidateEventPaths(event.tournament_id as string, match.event_id as string);
}

// ============================================================
// Public entry points
// ============================================================
// These return ActionResult rather than throwing. Next.js SANITISES errors
// thrown out of a Server Action in a production build — the client gets
// "An error occurred in the Server Components render", never the message. This
// module threw for everything, so every guard in it was invisible in prod: a
// user entering a score before the event went live saw an opaque red banner
// instead of "Start the event before entering results."
//
// runAction also keeps ExpectedError out of Sentry, so a refused-but-normal
// action stops being filed as a fault.
export async function enterMatchResult(
  matchId: string,
  scores: Array<{ a: number; b: number }>,
  winnerSide: 'a' | 'b',
  // Defaults to false so the strict rules stay the default everywhere — an
  // older caller, or one that simply forgets, gets the pre-00047 behaviour.
  timeExceeded = false,
): Promise<ActionResult<void>> {
  return runAction(async () => { await enterMatchResultImpl(matchId, scores, winnerSide, timeExceeded); });
}

export async function enterWalkover(
  matchId: string,
  winnerPosition: 'a' | 'b',
  reason: string,
): Promise<ActionResult<void>> {
  return runAction(async () => { await enterWalkoverImpl(matchId, winnerPosition, reason); });
}

export async function voidMatch(matchId: string, reason: string): Promise<ActionResult<void>> {
  return runAction(async () => { await voidMatchImpl(matchId, reason); });
}

export async function undoMatchResult(matchId: string): Promise<ActionResult<void>> {
  return runAction(async () => { await undoMatchResultImpl(matchId); });
}

// Change a result that is already recorded, without voiding it first.
//
// Wrapped in runAction like everything else in this module, and that is not
// cosmetic here: this action's guards are the ones an exec most needs to READ.
// Next.js sanitises anything thrown out of a Server Action in a production
// build, so while editMatchResult threw, "the third-place match already has a
// result, undo that one first" reached the browser as "An error occurred in the
// Server Components render" — a refusal indistinguishable from a crash, on the
// one path where knowing which is which decides what the exec does next.
export async function editMatchResult(
  matchId: string,
  newScores: Array<{ a: number; b: number }>,
  newWinnerSide: 'a' | 'b',
  reason: string,
): Promise<ActionResult<void>> {
  return runAction(async () => { await editMatchResultImpl(matchId, newScores, newWinnerSide, reason); });
}

// Put a voided match back into play. Pairs with voidMatch: both reverse any Elo
// the match applied, so a void → restore → replay cycle counts the match once.
export async function recordDoubleNoShow(matchId: string, reason: string): Promise<ActionResult<void>> {
  return runAction(async () => { await recordDoubleNoShowImpl(matchId, reason); });
}

export async function unvoidMatch(matchId: string, reason: string): Promise<ActionResult<void>> {
  return runAction(async () => { await unvoidMatchImpl(matchId, reason); });
}

// Place or clear one side of an undecided match by hand. The escape hatch for a
// next-round slot that will never be filled by advancement — because the match
// feeding it was voided, or was a branch of nothing but byes.
export async function setMatchEntry(
  matchId: string,
  side: 'a' | 'b',
  entryId: string | null,
  reason: string,
): Promise<ActionResult<void>> {
  return runAction(async () => { await setMatchEntryImpl(matchId, side, entryId, reason); });
}
