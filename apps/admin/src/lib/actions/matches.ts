'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import {
  parseOrThrow,
  adminMatchCreateSchema,
  isLegalCustomGames,
  isLegalCustomPoints,
  CUSTOM_FORMAT_BOUNDS,
  ExpectedError,
  requireActiveSeasonId,
} from '@badminton/shared';
import { requireCapability } from './_shared';
import { runAction, type ActionResult } from '../action-result';

// ============================================================
// Match Management
// ============================================================

export async function voidMatch(matchId: string, reason: string): Promise<ActionResult<void>> {
  return runAction(() => voidMatchImpl(matchId, reason));
}

async function voidMatchImpl(matchId: string, reason: string) {
  const admin = await requireCapability('matches.void.write');
  const adminClient = createAdminClient();

  // Only a confirmed match has Elo applied, so reverse it only then. A disputed
  // or pending match never applied Elo, and reverse_match_result requires a
  // confirmed match (it would raise otherwise) — just mark it voided.
  const { data: m } = await adminClient.from('matches').select('result_status').eq('id', matchId).single();
  if (m?.result_status === 'confirmed') {
    const { error: reverseError } = await adminClient.rpc('reverse_match_result', { p_match_id: matchId });
    if (reverseError) {
      Sentry.captureException(new Error(`Elo reversal failed: ${reverseError.message}`), {
        extra: { matchId, action: 'void_match' },
      });
      throw new Error(reverseError.message);
    }
  }

  const { error } = await adminClient
    .from('matches')
    .update({ result_status: 'voided', admin_note: reason })
    .eq('id', matchId);

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'match_voided',
    target_type: 'match',
    target_id: matchId,
    reason,
  }, { matchId });

  revalidatePath('/matches');
}

export async function convertMatchToCasual(matchId: string, reason: string): Promise<ActionResult<void>> {
  return runAction(() => convertMatchToCasualImpl(matchId, reason));
}

async function convertMatchToCasualImpl(matchId: string, reason: string) {
  const admin = await requireCapability('matches.convert.write');
  const adminClient = createAdminClient();

  const { data: m } = await adminClient.from('matches').select('result_status').eq('id', matchId).single();

  if (m?.result_status === 'confirmed') {
    // Elo was applied — reverse it (this also marks the match voided). We keep
    // the existing "voided + casual flags" outcome for an already-confirmed
    // match to avoid re-firing the on_match_confirmed stats trigger.
    const { error: reverseError } = await adminClient.rpc('reverse_match_result', { p_match_id: matchId });
    if (reverseError) {
      Sentry.captureException(new Error(`Elo reversal failed: ${reverseError.message}`), {
        extra: { matchId, action: 'convert_to_casual' },
      });
      throw new Error(reverseError.message);
    }
    const { error } = await adminClient
      .from('matches')
      .update({ rated_flag: false, event_type: 'casual', admin_note: reason })
      .eq('id', matchId);
    if (error) throw new Error(error.message);
  } else {
    // Never confirmed (disputed / pending) -> no Elo yet. Record it as a
    // completed casual match: apply_match_result skips Elo for event_type
    // 'casual' but still confirms the result and updates head-to-head once.
    const { error: upErr } = await adminClient
      .from('matches')
      .update({ rated_flag: false, event_type: 'casual', result_status: 'pending_confirmation', admin_note: reason })
      .eq('id', matchId);
    if (upErr) throw new Error(upErr.message);
    const { error: applyErr } = await adminClient.rpc('apply_match_result', {
      p_match_id: matchId,
      p_confirmed_by: admin.id,
    });
    if (applyErr) {
      Sentry.captureException(new Error(`Casual confirm failed: ${applyErr.message}`), {
        extra: { matchId, action: 'convert_to_casual' },
      });
      throw new Error(applyErr.message);
    }
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'match_converted_casual',
    target_type: 'match',
    target_id: matchId,
    reason,
  }, { matchId });

  revalidatePath('/matches');
}

// ============================================================
// Admin Match Entry
// ============================================================

export async function adminCreateMatch(data: {
  match_type: string;
  format: string;
  // "Best of X games to Y points", typed in the form. The enum above stays as
  // the fallback the DB coalesces to; these win when present (migration 00031).
  games_per_match?: number;
  points_per_game?: number;
  rated_flag: boolean;
  side_a_players: string[];
  side_b_players: string[];
  winner_side: string;
  games: { game_number: number; side_a_score: number; side_b_score: number }[];
  admin_note?: string;
}): Promise<ActionResult<string>> {
  return runAction(() => adminCreateMatchImpl(data));
}

/**
 * Undo a half-built admin match and re-raise. Always throws.
 *
 * PostgREST gives the action no transaction, so the `matches` row is already
 * committed by the time the participant or game insert can fail. Of the two
 * possible half-states, "no match at all" is the one somebody can act on — the
 * admin sees the failure and enters the match again — and "a completed match
 * with a winner and no participants" is the one nobody can even see. So we
 * delete the shell we just created.
 *
 * Checked against the live schema on 2026-08-06 rather than read off 00001,
 * because the delete is only safe if nothing REFERENCES matches with NO ACTION
 * (Postgres's silent default), which would make this branch fail every single
 * time. Every child is CASCADE — match_participants, match_games, disputes —
 * except walkovers, which is SET NULL; a walkover cannot exist for a match this
 * action created a moment ago. The only triggers on the table fire BEFORE
 * INSERT and AFTER UPDATE OF result_status, so nothing runs on the delete.
 *
 * If the delete ALSO fails the orphan is real, and the only useful thing left
 * is to name it: the message and the Sentry event carry the match id so it can
 * be voided by hand instead of sitting in the results list looking legitimate.
 */
async function discardIncompleteMatch(
  adminClient: ReturnType<typeof createAdminClient>,
  matchId: string,
  expectedStatus: string,
  cause: string,
): Promise<never> {
  // Scoped to the row as we wrote it, not to the id alone. The shell is
  // committed and visible on /matches for as long as this takes, so another
  // admin can void it in the meantime — and a blind delete would then destroy
  // somebody else's decision (and cascade away any dispute raised against it)
  // while reporting the original failure. If the status has moved, the row is
  // no longer ours to remove.
  const { data: deleted, error: deleteError } = await adminClient
    .from('matches')
    .delete()
    .eq('id', matchId)
    .eq('result_status', expectedStatus)
    .select('id');

  if (deleteError || !deleted?.length) {
    const detail = deleteError ? deleteError.message : 'the match was changed by someone else';
    Sentry.captureException(
      new Error(`Orphaned admin match left behind: ${cause} (cleanup: ${detail})`),
      { extra: { matchId, action: 'admin_create_match' } },
    );
    throw new Error(
      `The match could not be saved (${cause}), and the incomplete match ${matchId} could not be removed. ` +
      'Void it from the Matches list before entering it again.',
    );
  }
  throw new Error(`The match could not be saved and was discarded: ${cause}`);
}

async function adminCreateMatchImpl(data: {
  match_type: string;
  format: string;
  // "Best of X games to Y points", typed in the form. The enum above stays as
  // the fallback the DB coalesces to; these win when present (migration 00031).
  games_per_match?: number;
  points_per_game?: number;
  rated_flag: boolean;
  side_a_players: string[];
  side_b_players: string[];
  winner_side: string;
  games: { game_number: number; side_a_score: number; side_b_score: number }[];
  admin_note?: string;
}) {
  parseOrThrow(adminMatchCreateSchema, data);
  const admin = await requireCapability('matches.create.write');
  const adminClient = createAdminClient();
  const { getFormatWeight, derivedFormatWeight } = await import('@badminton/shared');

  const activeSeason = await adminClient.from('seasons').select('id').eq('active_flag', true).maybeSingle();
  // Refuse rather than stamp NULL — see requireActiveSeasonId. A row with no
  // season is invisible to every season total and there is no page that lists
  // the orphans. maybeSingle() so TWO active seasons surface as an error here
  // rather than as a silent "no active season".
  const seasonId = requireActiveSeasonId(activeSeason.data?.id, 'match');
  // A custom shape has no hand-picked weight, so derive it exactly as
  // derived_format_weight (00031) does — otherwise the same "best of 5 to 15"
  // would be worth one thing entered by an admin and another played through a
  // challenge. trigger_set_match_weights recomputes this on insert anyway; we
  // send the matching value rather than a stale preset weight.
  const formatWeight = data.points_per_game
    ? derivedFormatWeight(data.games_per_match ?? 1, data.points_per_game)
    : getFormatWeight(data.format as import('@badminton/shared').MatchFormat);

  const scoreSummary = data.games.map(g => `${g.side_a_score}-${g.side_b_score}`).join(', ');

  // Rated matches must start as pending_confirmation: apply_match_result
  // rejects anything else, then flips the status to confirmed itself.
  const initialStatus = data.rated_flag ? 'pending_confirmation' : 'confirmed';

  const { data: match, error: matchError } = await adminClient.from('matches').insert({
    match_type: data.match_type,
    event_type: 'admin_entered',
    rated_flag: data.rated_flag,
    format: data.format,
    games_per_match: data.games_per_match ?? null,
    points_per_game: data.points_per_game ?? null,
    format_weight: formatWeight,
    event_multiplier: 1.0,
    completed_flag: true,
    winner_side: data.winner_side,
    score_summary: scoreSummary,
    played_at: new Date().toISOString(),
    submitted_by: admin.id,
    confirmed_by: admin.id,
    result_status: initialStatus,
    season_id: seasonId,
    admin_note: data.admin_note || null,
  }).select().single();

  if (matchError) throw new Error(matchError.message);

  // Get player ratings and build participants
  const allPlayerIds = [...data.side_a_players, ...data.side_b_players];
  const { data: ratings } = await adminClient.from('ratings').select('*').in('player_id', allPlayerIds);
  const ratingsMap = new Map(ratings?.map(r => [r.player_id, r]) || []);

  const isDoubles = data.match_type === 'doubles';
  const participants = allPlayerIds.map(pid => {
    const side = data.side_a_players.includes(pid) ? 'a' : 'b';
    const r = ratingsMap.get(pid);
    const preRating = isDoubles ? (r?.doubles_elo ?? 400) : (r?.singles_elo ?? 400);

    let pointsScored = 0, pointsAllowed = 0, gamesWon = 0, gamesLost = 0;
    for (const g of data.games) {
      if (side === 'a') {
        pointsScored += g.side_a_score;
        pointsAllowed += g.side_b_score;
        if (g.side_a_score > g.side_b_score) gamesWon++; else gamesLost++;
      } else {
        pointsScored += g.side_b_score;
        pointsAllowed += g.side_a_score;
        if (g.side_b_score > g.side_a_score) gamesWon++; else gamesLost++;
      }
    }

    return {
      match_id: match.id,
      player_id: pid,
      team_side: side,
      pre_rating: preRating,
      points_scored: pointsScored,
      points_allowed: pointsAllowed,
      games_won: gamesWon,
      games_lost: gamesLost,
    };
  });

  // Both of these results used to be thrown away. supabase-js RESOLVES on a
  // Postgres error rather than rejecting, so a duplicate player (UNIQUE
  // (match_id, player_id), 00001) or any other constraint failure looked
  // exactly like success — and for an unrated match nothing downstream reads
  // the participants, so the action audited the match and returned its id
  // while the database held a completed, confirmed match with a winner, a
  // score summary and nobody in it. That row is the invisible half-state: it
  // is a normal-looking result on /matches, it belongs to no player's history,
  // and there is no admin control that can repair it.
  const { error: participantError } = await adminClient.from('match_participants').insert(participants);
  if (participantError) await discardIncompleteMatch(adminClient, match.id, initialStatus, participantError.message);

  const gameRows = data.games.map(g => ({
    match_id: match.id,
    game_number: g.game_number,
    side_a_score: g.side_a_score,
    side_b_score: g.side_b_score,
  }));
  const { error: gameError } = await adminClient.from('match_games').insert(gameRows);
  if (gameError) await discardIncompleteMatch(adminClient, match.id, initialStatus, gameError.message);

  // Apply Elo if rated.
  //
  // Deliberately NOT discarded the way the two inserts above are: by this point
  // the match has its participants and games, so a failure here leaves a
  // complete, pending_confirmation match that shows up on /matches and that
  // voidMatch can already deal with. That is the visible, recoverable
  // half-state, and deleting a fully-formed match under the admin's feet would
  // be the more destructive choice.
  if (data.rated_flag) {
    const { error: eloError } = await adminClient.rpc('apply_match_result', {
      p_match_id: match.id,
      p_confirmed_by: admin.id,
    });
    if (eloError) {
      Sentry.captureException(new Error(`Elo application failed for admin match: ${eloError.message}`), {
        extra: { matchId: match.id },
      });
      throw new Error(eloError.message);
    }
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'match_admin_created',
    target_type: 'match',
    target_id: match.id,
    new_value: { ...data, score_summary: scoreSummary },
  }, { matchId: match.id });

  revalidatePath('/matches');
  revalidatePath('/leaderboard');
  return match.id;
}

// ============================================================
// Admin Challenge Creation
// ============================================================

export async function adminCreateChallenge(data: {
  type: string;
  format: string;
  // See adminCreateMatch: the enum is the fallback, this pair is the real shape.
  games_per_match?: number;
  points_per_game?: number;
  rated_flag: boolean;
  side_a_players: string[];
  side_b_players: string[];
  scheduled_date?: string;
  scheduled_time?: string;
  note?: string;
}): Promise<ActionResult<string>> {
  return runAction(() => adminCreateChallengeImpl(data));
}

async function adminCreateChallengeImpl(data: {
  type: string;
  format: string;
  // See adminCreateMatch: the enum is the fallback, this pair is the real shape.
  games_per_match?: number;
  points_per_game?: number;
  rated_flag: boolean;
  side_a_players: string[];
  side_b_players: string[];
  scheduled_date?: string;
  scheduled_time?: string;
  note?: string;
}) {
  // Challenge management is an admin-only section (permissions.ts '/challenges'),
  // so gate at admin — not exec — even though this lives in the exec-allowed
  // matches module.
  const admin = await requireCapability('challenges.create.write');
  const adminClient = createAdminClient();

  // This action has no zod schema of its own, and the shape is now typed rather
  // than chosen from a list — so check it here. Otherwise a typo reaches the
  // challenges_custom_format_sane CHECK and comes back as a Postgres constraint
  // string no admin can act on.
  if (data.points_per_game !== undefined || data.games_per_match !== undefined) {
    if (!isLegalCustomGames(data.games_per_match ?? 0) || !isLegalCustomPoints(data.points_per_game ?? 0)) {
      throw new ExpectedError(
        `Best of must be an odd number from ${CUSTOM_FORMAT_BOUNDS.minGames} to ${CUSTOM_FORMAT_BOUNDS.maxGames}, ` +
        `and points per game between ${CUSTOM_FORMAT_BOUNDS.minPoints} and ${CUSTOM_FORMAT_BOUNDS.maxPoints}.`,
      );
    }
  }

  const eventType = data.rated_flag ? 'rated_challenge' : 'casual';

  const { data: challenge, error } = await adminClient.from('challenges').insert({
    type: data.type,
    rated_flag: data.rated_flag,
    format: data.format,
    games_per_match: data.games_per_match ?? null,
    points_per_game: data.points_per_game ?? null,
    event_type: eventType,
    scheduled_date: data.scheduled_date || null,
    scheduled_time: data.scheduled_time || null,
    created_by: admin.id,
    status: 'accepted',
    note: data.note || `Created by admin`,
  }).select().single();

  if (error) throw new Error(error.message);

  // All participants auto-accepted since admin created
  const participants: { challenge_id: string; player_id: string; role: string; team_side: string; confirmation_status: string }[] = [];

  data.side_a_players.forEach((pid, i) => {
    participants.push({
      challenge_id: challenge.id,
      player_id: pid,
      role: i === 0 ? 'challenger' : 'partner',
      team_side: 'a',
      confirmation_status: 'accepted',
    });
  });

  data.side_b_players.forEach((pid, i) => {
    participants.push({
      challenge_id: challenge.id,
      player_id: pid,
      role: i === 0 ? 'opponent' : 'opponent_partner',
      team_side: 'b',
      confirmation_status: 'accepted',
    });
  });

  const { error: partError } = await adminClient.from('challenge_participants').insert(participants);
  if (partError) throw new Error(partError.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'challenge_admin_created',
    target_type: 'challenge',
    target_id: challenge.id,
    new_value: data,
  }, { challengeId: challenge.id });

  revalidatePath('/challenges');
  return challenge.id;
}

export async function forceExpireChallenge(challengeId: string, reason: string): Promise<ActionResult<void>> {
  return runAction(() => forceExpireChallengeImpl(challengeId, reason));
}

async function forceExpireChallengeImpl(challengeId: string, reason: string) {
  // Admin-only section — see adminCreateChallengeImpl.
  const admin = await requireCapability('challenges.expire.write');
  const adminClient = createAdminClient();

  const { error } = await adminClient
    .from('challenges')
    .update({ status: 'expired' })
    .eq('id', challengeId);

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'challenge_force_expired',
    target_type: 'challenge',
    target_id: challengeId,
    reason,
  }, { challengeId });

  revalidatePath('/challenges');
}
