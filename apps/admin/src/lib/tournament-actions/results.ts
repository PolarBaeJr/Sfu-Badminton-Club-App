'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { runAction, type ActionResult } from '../action-result';
import { isDoublesEvent, getMaxGamesForFormat, isLegalGameScore, isLegalGameCount, ExpectedError } from '@badminton/shared';
import type { TournamentEventType, TournamentMatchFormat } from '@badminton/shared';
import {
  getExecOrAdmin,
  revalidateEventPaths,
  notifyPlayers,
  applyTournamentMatchElo,
  reverseEloSnapshot,
  assertTournamentNotSuspended,
} from './_internal';

// ============================================================
// Score Entry & Advancement
// ============================================================

// Field on a match row holding one side's entry, for the discipline in play.
function sideField(side: 'a' | 'b', doubles: boolean): string {
  if (doubles) return side === 'a' ? 'pair_a_id' : 'pair_b_id';
  return side === 'a' ? 'participant_a_id' : 'participant_b_id';
}

// Pull `entryId` back out of the slot this match feeds and demote the
// downstream match back to 'pending' — 'ready' and 'live' both assert both
// sides are known, and one of them just stopped being known.
//
// The write is conditional on the slot actually still holding this match's
// winner. A slot can also be set by hand (setMatchEntry) or by a neighbouring
// match, and blindly nulling it would silently undo somebody else's correction.
// Returns whether anything was cleared, for the audit trail.
async function clearAdvancedEntry(
  adminClient: ReturnType<typeof createAdminClient>,
  match: Record<string, unknown>,
  entryId: string,
  doubles: boolean,
): Promise<boolean> {
  const nextId = match.winner_to_match_id as string | null;
  if (!nextId) return false;

  const field = sideField(match.winner_to_position === 'a' ? 'a' : 'b', doubles);

  const { data: next } = await adminClient.from('tournament_matches')
    .select('*')
    .eq('id', nextId)
    .single();
  if (!next) return false;

  const nextRow = next as Record<string, unknown>;
  if (nextRow[field] !== entryId) return false;

  await adminClient.from('tournament_matches')
    .update({
      [field]: null,
      status: nextRow.status === 'ready' || nextRow.status === 'live' ? 'pending' : (nextRow.status as string),
      updated_at: new Date().toISOString(),
    })
    .eq('id', nextId);

  return true;
}

// Refuse when the match this one feeds has already been decided. Rewinding an
// earlier round underneath a played later round would leave a recorded result
// for an entry that is no longer in that half of the draw.
async function assertDownstreamUndecided(
  adminClient: ReturnType<typeof createAdminClient>,
  match: Record<string, unknown>,
  what: string,
) {
  const nextId = match.winner_to_match_id as string | null;
  if (!nextId) return;

  const { data: nextMatch } = await adminClient.from('tournament_matches')
    .select('status')
    .eq('id', nextId)
    .single();

  if (nextMatch && (nextMatch.status === 'completed' || nextMatch.status === 'walkover')) {
    throw new ExpectedError(`Cannot ${what} — the next match already has a result. Undo that one first.`);
  }
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
  winnerSide: 'a' | 'b'
) {
  const admin = await getExecOrAdmin();
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

  const matchFormat = event.match_format as TournamentMatchFormat;
  const maxGames = getMaxGamesForFormat(matchFormat);
  if (scores.length > maxGames) {
    throw new Error(`Too many games for format ${matchFormat}. Max: ${maxGames}`);
  }

  // Same scoring rules challenges get (00030): a game is won by reaching the
  // target with a two-point margin or by taking the cap, and a best-of-N stops
  // the moment someone clinches. Previously tournaments only checked the number
  // of games, so an impossible 21-20 — or a 3-0 best-of-3 — was accepted here
  // even though the identical result was rejected on the challenge path.
  for (const g of scores) {
    if (!isLegalGameScore(g.a, g.b, matchFormat)) {
      throw new Error(`Not a possible score for this format: ${g.a}-${g.b}`);
    }
  }
  const aGames = scores.filter((g) => g.a > g.b).length;
  const bGames = scores.filter((g) => g.b > g.a).length;
  if (!isLegalGameCount(Math.max(aGames, bGames), Math.min(aGames, bGames), matchFormat)) {
    throw new Error(
      `${aGames}-${bGames} is not a possible result for ${matchFormat} — the match ends once a side clinches.`
    );
  }

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
  const { error } = await adminClient.from('tournament_matches').update({
    scores,
    [winnerIdField]: winnerId,
    [loserIdField]: loserId,
    status: 'completed',
    result_entered_by: admin.id,
    result_entered_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', matchId);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  // Advance winner to next match (single elimination only)
  if (match.winner_to_match_id) {
    const advanceField = doubles
      ? (match.winner_to_position === 'a' ? 'pair_a_id' : 'pair_b_id')
      : (match.winner_to_position === 'a' ? 'participant_a_id' : 'participant_b_id');

    await adminClient.from('tournament_matches')
      .update({ [advanceField]: winnerId })
      .eq('id', match.winner_to_match_id);

    // Check if next match now has both sides → set to ready
    const { data: nextMatch } = await adminClient.from('tournament_matches')
      .select('*')
      .eq('id', match.winner_to_match_id)
      .single();

    if (nextMatch) {
      const hasBoth = doubles
        ? (nextMatch.pair_a_id && nextMatch.pair_b_id)
        : (nextMatch.participant_a_id && nextMatch.participant_b_id);
      if (hasBoth) {
        await adminClient.from('tournament_matches')
          .update({ status: 'ready' })
          .eq('id', match.winner_to_match_id);
      }
    }
  }

  // Apply Elo
  await applyTournamentMatchElo(matchId);

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    action: 'result_entered',
    performed_by: admin.id,
    details: { scores, winner_side: winnerSide },
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
    { match_id: matchId, event_id: match.event_id },
    'tournament_match_result'
  );

  revalidateEventPaths(event.tournament_id as string, match.event_id as string);
}

async function enterWalkoverImpl(
  matchId: string,
  winnerPosition: 'a' | 'b',
  reason: string
) {
  const admin = await getExecOrAdmin();
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

  let winnerId: string;
  let loserId: string;

  if (doubles) {
    winnerId = winnerPosition === 'a' ? match.pair_a_id : match.pair_b_id;
    loserId = winnerPosition === 'a' ? match.pair_b_id : match.pair_a_id;
  } else {
    winnerId = winnerPosition === 'a' ? match.participant_a_id : match.participant_b_id;
    loserId = winnerPosition === 'a' ? match.participant_b_id : match.participant_a_id;
  }

  // A half-filled match is a legitimate walkover target, and it is the way an
  // admin pushes a lone semi-finalist forward when the other side of the draw
  // died (voided quarter-final, both-bye branch). So an EMPTY OPPOSITE side is
  // fine — an empty WINNING side is not, and used to write a null winner and
  // then "advance" that null into the next round.
  //
  // An unopposed walkover stays unrated on purpose: applyTournamentMatchElo
  // bails when either side is missing, so no delta and no elo_snapshot is
  // written. Rating someone for a match nobody turned up to would be free Elo.
  if (!winnerId) {
    throw new ExpectedError('That side of the match is empty — there is nobody to award the walkover to.');
  }

  const winnerField = doubles ? 'winner_pair_id' : 'winner_participant_id';
  const loserField = doubles ? 'loser_pair_id' : 'loser_participant_id';

  await adminClient.from('tournament_matches').update({
    status: 'walkover',
    walkover_winner: winnerPosition,
    walkover_reason: reason,
    [winnerField]: winnerId,
    [loserField]: loserId,
    result_entered_by: admin.id,
    result_entered_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', matchId);

  // Advance winner
  if (match.winner_to_match_id) {
    const advanceField = doubles
      ? (match.winner_to_position === 'a' ? 'pair_a_id' : 'pair_b_id')
      : (match.winner_to_position === 'a' ? 'participant_a_id' : 'participant_b_id');

    await adminClient.from('tournament_matches')
      .update({ [advanceField]: winnerId })
      .eq('id', match.winner_to_match_id);

    // Check if next match is now ready
    const { data: nextMatch } = await adminClient.from('tournament_matches')
      .select('*')
      .eq('id', match.winner_to_match_id)
      .single();

    if (nextMatch) {
      const hasBoth = doubles
        ? (nextMatch.pair_a_id && nextMatch.pair_b_id)
        : (nextMatch.participant_a_id && nextMatch.participant_b_id);
      if (hasBoth) {
        await adminClient.from('tournament_matches')
          .update({ status: 'ready' })
          .eq('id', match.winner_to_match_id);
      }
    }
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    action: 'walkover_entered',
    performed_by: admin.id,
    details: { winner_position: winnerPosition, reason },
  });

  // Apply Elo for walkovers too — losing party still gets penalised, winner still gains.
  await applyTournamentMatchElo(matchId);

  revalidateEventPaths(event.tournament_id as string, match.event_id as string);
}

async function voidMatchImpl(matchId: string, reason: string) {
  const admin = await getExecOrAdmin();
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
  const priorWinnerId = (doubles ? match.winner_pair_id : match.winner_participant_id) as string | null;

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
    await reverseEloSnapshot(adminClient, match);
  }

  // Take the voided match's winner back out of the next round. Leaving them
  // parked there is how a bracket ends up advertising a semi-final between a
  // real player and a result that has been erased.
  const clearedNextSlot = priorWinnerId
    ? await clearAdvancedEntry(adminClient, match, priorWinnerId, doubles)
    : false;

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
    details: { reason, reversed_elo: reversedElo, cleared_next_slot: clearedNextSlot },
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
  const admin = await getExecOrAdmin();
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
    await reverseEloSnapshot(adminClient, match);
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
  const admin = await getExecOrAdmin();
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
  const field = sideField(side, doubles);
  const otherField = sideField(side === 'a' ? 'b' : 'a', doubles);
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

export async function editMatchResult(
  matchId: string,
  newScores: Array<{ a: number; b: number }>,
  newWinnerSide: 'a' | 'b'
) {
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (!match) throw new Error('Match not found');

  // Check no downstream matches have been completed
  if (match.winner_to_match_id) {
    const { data: nextMatch } = await adminClient.from('tournament_matches')
      .select('status')
      .eq('id', match.winner_to_match_id)
      .single();

    if (nextMatch && nextMatch.status === 'completed') {
      throw new Error('Cannot edit result — downstream match already completed');
    }
  }

  const event = match.event as Record<string, unknown>;
  const doubles = isDoublesEvent(event.event_type as TournamentEventType);

  const winnerId = doubles
    ? (newWinnerSide === 'a' ? match.pair_a_id : match.pair_b_id)
    : (newWinnerSide === 'a' ? match.participant_a_id : match.participant_b_id);
  const loserId = doubles
    ? (newWinnerSide === 'a' ? match.pair_b_id : match.pair_a_id)
    : (newWinnerSide === 'a' ? match.participant_b_id : match.participant_a_id);

  const winnerField = doubles ? 'winner_pair_id' : 'winner_participant_id';
  const loserField = doubles ? 'loser_pair_id' : 'loser_participant_id';

  // Reverse any prior Elo changes so we can recompute with the corrected winner.
  if (match.elo_snapshot) {
    await reverseEloSnapshot(adminClient, match);
  }

  await adminClient.from('tournament_matches').update({
    scores: newScores,
    [winnerField]: winnerId,
    [loserField]: loserId,
    result_entered_by: admin.id,
    result_entered_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', matchId);

  // Re-advance winner if changed
  if (match.winner_to_match_id) {
    const advanceField = doubles
      ? (match.winner_to_position === 'a' ? 'pair_a_id' : 'pair_b_id')
      : (match.winner_to_position === 'a' ? 'participant_a_id' : 'participant_b_id');

    await adminClient.from('tournament_matches')
      .update({ [advanceField]: winnerId })
      .eq('id', match.winner_to_match_id);
  }

  // Reapply Elo with the corrected winner. Walkovers count too — enterWalkover
  // applies Elo, so omitting them here reversed the delta above and never
  // restored it, permanently zeroing both sides' rating change. Voided matches
  // stay unrated.
  if (match.status === 'completed' || match.status === 'walkover') {
    await applyTournamentMatchElo(matchId);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    action: 'result_edited',
    performed_by: admin.id,
    details: { old_scores: match.scores, new_scores: newScores, new_winner_side: newWinnerSide },
  });

  revalidateEventPaths(event.tournament_id as string, match.event_id as string);
}

// ============================================================
// Undo Match Result
// ============================================================

async function undoMatchResultImpl(matchId: string) {
  const admin = await getExecOrAdmin();
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
  if (match.elo_snapshot) {
    await reverseEloSnapshot(adminClient, match);
  } else if (!doubles && match.winner_participant_id && match.loser_participant_id) {
    const winnerId = match.winner_participant_id;
    const loserId = match.loser_participant_id;

    if (winnerId) {
      const { data: winnerP } = await adminClient.from('tournament_participants')
        .select('player_id, elo_before')
        .eq('id', winnerId).single();
      if (winnerP?.elo_before != null) {
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
        .select('player_id, elo_before')
        .eq('id', loserId).single();
      if (loserP?.elo_before != null) {
        await adminClient.from('ratings')
          .update({ singles_elo: loserP.elo_before, updated_at: new Date().toISOString() })
          .eq('player_id', loserP.player_id);
        await adminClient.from('tournament_participants')
          .update({ elo_after: null, elo_change: null })
          .eq('id', loserId);
      }
    }
  }

  // Remove winner from next match if single elimination
  const undoneWinnerId = (doubles ? match.winner_pair_id : match.winner_participant_id) as string | null;
  if (undoneWinnerId) {
    await clearAdvancedEntry(adminClient, match, undoneWinnerId, doubles);
  }

  // Reset match itself
  const aId = (doubles ? match.pair_a_id : match.participant_a_id) as string | null;
  const bId = (doubles ? match.pair_b_id : match.participant_b_id) as string | null;
  const resetData: Record<string, unknown> = {
    scores: null,
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
): Promise<ActionResult<void>> {
  return runAction(async () => { await enterMatchResultImpl(matchId, scores, winnerSide); });
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

// Put a voided match back into play. Pairs with voidMatch: both reverse any Elo
// the match applied, so a void → restore → replay cycle counts the match once.
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
