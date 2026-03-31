'use server';

import * as Sentry from '@sentry/nextjs';
import { createServerSupabaseClient, createAdminClient } from './supabase-server';
import { revalidatePath } from 'next/cache';
import type {
  AdminPlayerUpdateInput,
  SessionCreateInput,
  DisputeResolveInput,
} from '@badminton/shared';

async function getAdminPlayer() {
  // DEV MODE: Everyone is admin — grab first player
  const adminClient = createAdminClient();
  const { data: player } = await adminClient
    .from('players')
    .select('*')
    .limit(1)
    .single();

  if (!player) throw new Error('No players found in database');
  Sentry.setUser({ id: player.id });
  return { ...player, role: 'admin' };
}

// ============================================================
// Player Management
// ============================================================

export async function approvePlayer(playerId: string, status: string, eligibility: boolean, reason: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: oldPlayer } = await adminClient.from('players').select('*').eq('id', playerId).single();

  const { error } = await adminClient
    .from('players')
    .update({
      status,
      eligibility_flag: eligibility,
      active_flag: true,
    })
    .eq('id', playerId);

  if (error) throw new Error(error.message);

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'player_approved',
    target_type: 'player',
    target_id: playerId,
    old_value: oldPlayer,
    new_value: { status, eligibility_flag: eligibility },
    reason,
  });
  if (auditError) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'player_approved', playerId },
    });
  }

  revalidatePath('/players');
  revalidatePath('/dashboard');
}

export async function updatePlayer(playerId: string, data: AdminPlayerUpdateInput) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: oldPlayer } = await adminClient.from('players').select('*').eq('id', playerId).single();
  const { data: oldRating } = await adminClient.from('ratings').select('*').eq('player_id', playerId).single();

  const playerUpdate: Record<string, unknown> = {};
  if (data.status) playerUpdate.status = data.status;
  if (data.role) playerUpdate.role = data.role;
  if (data.eligibility_flag !== undefined) playerUpdate.eligibility_flag = data.eligibility_flag;

  if (Object.keys(playerUpdate).length > 0) {
    const { error } = await adminClient.from('players').update(playerUpdate).eq('id', playerId);
    if (error) throw new Error(error.message);
  }

  const ratingUpdate: Record<string, unknown> = {};
  if (data.singles_elo !== undefined) ratingUpdate.singles_elo = data.singles_elo;
  if (data.doubles_elo !== undefined) ratingUpdate.doubles_elo = data.doubles_elo;

  if (Object.keys(ratingUpdate).length > 0) {
    const { error } = await adminClient.from('ratings').update(ratingUpdate).eq('player_id', playerId);
    if (error) throw new Error(error.message);
  }

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'player_updated',
    target_type: 'player',
    target_id: playerId,
    old_value: { player: oldPlayer, rating: oldRating },
    new_value: { ...playerUpdate, ...ratingUpdate },
    reason: data.reason,
  });
  if (auditError) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'player_updated', playerId },
    });
  }

  revalidatePath('/players');
  revalidatePath(`/players/${playerId}`);
}

export async function removePlayer(playerId: string, reason: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: oldPlayer } = await adminClient.from('players').select('*').eq('id', playerId).single();

  const { error } = await adminClient
    .from('players')
    .update({ status: 'inactive', active_flag: false })
    .eq('id', playerId);

  if (error) throw new Error(error.message);

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'player_removed',
    target_type: 'player',
    target_id: playerId,
    old_value: oldPlayer,
    reason,
  });
  if (auditError) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'player_removed', playerId },
    });
  }

  revalidatePath('/players');
  revalidatePath('/dashboard');
}

// ============================================================
// Session Management
// ============================================================

export async function createSession(data: SessionCreateInput) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const activeSeason = await adminClient.from('seasons').select('id').eq('active_flag', true).single();

  const { error } = await adminClient.from('sessions').insert({
    name: data.name,
    date: data.date,
    location: data.location,
    season_id: data.season_id || activeSeason.data?.id,
    host_player_id: admin.id,
    status: 'open',
  });

  if (error) throw new Error(error.message);

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'session_created',
    target_type: 'session',
    new_value: data,
  });
  if (auditError) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'session_created' },
    });
  }

  revalidatePath('/sessions');
}

export async function closeSession(sessionId: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { error } = await adminClient
    .from('sessions')
    .update({ status: 'closed' })
    .eq('id', sessionId);

  if (error) throw new Error(error.message);

  const { error: auditError2 } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'session_closed',
    target_type: 'session',
    target_id: sessionId,
  });
  if (auditError2) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError2.message}`), {
      extra: { action: 'session_closed', sessionId },
    });
  }

  revalidatePath('/sessions');
}

// ============================================================
// Match Management
// ============================================================

export async function voidMatch(matchId: string, reason: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  // Reverse Elo
  const { error: reverseError } = await adminClient.rpc('reverse_match_result', { p_match_id: matchId });
  if (reverseError) {
    Sentry.captureException(new Error(`Elo reversal failed: ${reverseError.message}`), {
      extra: { matchId, action: 'void_match' },
    });
    throw new Error(reverseError.message);
  }

  const { error } = await adminClient
    .from('matches')
    .update({ result_status: 'voided', admin_note: reason })
    .eq('id', matchId);

  if (error) throw new Error(error.message);

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'match_voided',
    target_type: 'match',
    target_id: matchId,
    reason,
  });
  if (auditError) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'match_voided', matchId },
    });
  }

  revalidatePath('/matches');
}

export async function convertMatchToCasual(matchId: string, reason: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

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

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'match_converted_casual',
    target_type: 'match',
    target_id: matchId,
    reason,
  });
  if (auditError) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'match_converted_casual', matchId },
    });
  }

  revalidatePath('/matches');
}

// ============================================================
// Dispute Resolution
// ============================================================

export async function resolveDispute(data: DisputeResolveInput) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: dispute } = await adminClient
    .from('disputes')
    .select('*, matches(*)')
    .eq('id', data.dispute_id)
    .single();

  if (!dispute) throw new Error('Dispute not found');

  // Handle resolution
  if (data.resolution_type === 'voided') {
    await voidMatch(dispute.match_id, data.resolution_note);
  } else if (data.resolution_type === 'converted_to_casual') {
    await convertMatchToCasual(dispute.match_id, data.resolution_note);
  } else if (data.resolution_type === 'accepted') {
    // Apply the result as-is
    const { error } = await adminClient.rpc('apply_match_result', {
      p_match_id: dispute.match_id,
      p_confirmed_by: admin.id,
    });
    if (error) {
      Sentry.captureException(new Error(`Match confirmation failed during dispute resolution: ${error.message}`), {
        extra: { disputeId: data.dispute_id, matchId: dispute.match_id },
      });
      throw new Error(error.message);
    }
  }

  const { error } = await adminClient
    .from('disputes')
    .update({
      status: 'resolved',
      resolution_type: data.resolution_type,
      resolution_note: data.resolution_note,
      resolved_by: admin.id,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', data.dispute_id);

  if (error) throw new Error(error.message);

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'dispute_resolved',
    target_type: 'dispute',
    target_id: data.dispute_id,
    new_value: { resolution_type: data.resolution_type },
    reason: data.resolution_note,
  });
  if (auditError) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'dispute_resolved', disputeId: data.dispute_id },
    });
  }

  revalidatePath('/disputes');
  revalidatePath('/matches');
}

// ============================================================
// Walkover Management
// ============================================================

export async function confirmWalkover(walkoverId: string, notes: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { error } = await adminClient.rpc('apply_walkover_result', {
    p_walkover_id: walkoverId,
    p_admin_id: admin.id,
    p_admin_notes: notes,
  });

  if (error) {
    Sentry.captureException(new Error(`Walkover confirmation failed: ${error.message}`), {
      extra: { walkoverId },
    });
    throw new Error(error.message);
  }

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'walkover_confirmed',
    target_type: 'walkover',
    target_id: walkoverId,
    reason: notes,
  });
  if (auditError) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'walkover_confirmed', walkoverId },
    });
  }

  revalidatePath('/walkovers');
  revalidatePath('/matches');
}

export async function rejectWalkover(walkoverId: string, notes: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: walkover } = await adminClient.from('walkovers').select('*').eq('id', walkoverId).single();

  const { error } = await adminClient
    .from('walkovers')
    .update({
      status: 'rejected',
      admin_confirmed_by: admin.id,
      admin_confirmed_at: new Date().toISOString(),
      admin_notes: notes,
    })
    .eq('id', walkoverId);

  if (error) throw new Error(error.message);

  // Restore challenge status
  if (walkover) {
    await adminClient
      .from('challenges')
      .update({ status: 'accepted' })
      .eq('id', walkover.challenge_id);
  }

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'walkover_rejected',
    target_type: 'walkover',
    target_id: walkoverId,
    reason: notes,
  });
  if (auditError) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'walkover_rejected', walkoverId },
    });
  }

  revalidatePath('/walkovers');
}

// ============================================================
// Challenge Management
// ============================================================

// ============================================================
// Tournament Management
// ============================================================

export async function createTournament(data: {
  name: string;
  scope: string;
  type: string;
  format: string;
  start_date: string;
  end_date?: string;
  bracket_size: number;
  event_multiplier: number;
  placement_bonus_enabled: boolean;
}) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const activeSeason = await adminClient.from('seasons').select('id').eq('active_flag', true).single();

  const { data: tournament, error } = await adminClient.from('tournaments').insert({
    name: data.name,
    scope: data.scope,
    type: data.type,
    format: data.format,
    start_date: data.start_date,
    end_date: data.end_date || null,
    bracket_size: data.bracket_size,
    event_multiplier: data.event_multiplier,
    placement_bonus_enabled: data.placement_bonus_enabled,
    status: 'draft',
    season_id: activeSeason.data?.id || null,
    created_by: admin.id,
  }).select().single();

  if (error) throw new Error(error.message);

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'tournament_created',
    target_type: 'tournament',
    target_id: tournament.id,
    new_value: data,
  });
  if (auditError) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'tournament_created' },
    });
  }

  revalidatePath('/tournaments');
  return tournament.id;
}

export async function updateTournamentStatus(tournamentId: string, status: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('tournaments').select('status').eq('id', tournamentId).single();

  const { error } = await adminClient.from('tournaments').update({ status }).eq('id', tournamentId);
  if (error) throw new Error(error.message);

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'tournament_status_changed',
    target_type: 'tournament',
    target_id: tournamentId,
    old_value: { status: old?.status },
    new_value: { status },
  });
  if (auditError) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'tournament_status_changed', tournamentId },
    });
  }

  revalidatePath('/tournaments');
  revalidatePath(`/tournaments/${tournamentId}`);
}

export async function addTournamentParticipant(tournamentId: string, playerId: string, seed: number | null, partnerId?: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  // Try new table name first, fall back to old if migration hasn't run
  let error;
  const insertData = {
    tournament_id: tournamentId,
    player_id: playerId,
    partner_id: partnerId || null,
    seed,
  };
  const result = await adminClient.from('legacy_tournament_participants').insert(insertData);
  if (result.error) {
    // Fallback: migration not yet run
    const fallback = await adminClient.from('tournament_participants').insert(insertData);
    error = fallback.error;
  } else {
    error = result.error;
  }

  if (error) {
    if (error.code === '23505') throw new Error('Player already in tournament');
    throw new Error(error.message);
  }

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'tournament_participant_added',
    target_type: 'tournament',
    target_id: tournamentId,
    new_value: { player_id: playerId, seed, partner_id: partnerId },
  });
  if (auditError) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'tournament_participant_added', tournamentId },
    });
  }

  revalidatePath(`/tournaments/${tournamentId}`);
}

export async function removeTournamentParticipant(participantId: string, tournamentId: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  // Try new table name first, fall back to old if migration hasn't run
  const { error: err1 } = await adminClient.from('legacy_tournament_participants').delete().eq('id', participantId);
  if (err1) {
    const { error: err2 } = await adminClient.from('tournament_participants').delete().eq('id', participantId);
    if (err2) throw new Error(err2.message);
  }

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'tournament_participant_removed',
    target_type: 'tournament',
    target_id: tournamentId,
    new_value: { participant_id: participantId },
  });
  if (auditError) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'tournament_participant_removed', tournamentId },
    });
  }

  revalidatePath(`/tournaments/${tournamentId}`);
}

// ============================================================
// Season Management
// ============================================================

export async function createSeason(data: { name: string; start_date: string; end_date?: string }) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: season, error } = await adminClient.from('seasons').insert({
    name: data.name,
    start_date: data.start_date,
    end_date: data.end_date || null,
    active_flag: false,
  }).select().single();

  if (error) throw new Error(error.message);

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'season_created',
    target_type: 'season',
    target_id: season.id,
    new_value: data,
  });
  if (auditError) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'season_created' },
    });
  }

  revalidatePath('/seasons');
}

export async function setActiveSeason(seasonId: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  // Deactivate all seasons first
  await adminClient.from('seasons').update({ active_flag: false }).neq('id', '00000000-0000-0000-0000-000000000000');

  const { error } = await adminClient.from('seasons').update({ active_flag: true }).eq('id', seasonId);
  if (error) throw new Error(error.message);

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'season_activated',
    target_type: 'season',
    target_id: seasonId,
  });
  if (auditError) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'season_activated', seasonId },
    });
  }

  revalidatePath('/seasons');
}

export async function endSeason(seasonId: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { error } = await adminClient.from('seasons').update({
    active_flag: false,
    end_date: new Date().toISOString().split('T')[0],
  }).eq('id', seasonId);

  if (error) throw new Error(error.message);

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'season_ended',
    target_type: 'season',
    target_id: seasonId,
  });
  if (auditError) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'season_ended', seasonId },
    });
  }

  revalidatePath('/seasons');
}

// ============================================================
// Admin Match Entry
// ============================================================

export async function adminCreateMatch(data: {
  match_type: string;
  format: string;
  rated_flag: boolean;
  side_a_players: string[];
  side_b_players: string[];
  winner_side: string;
  games: { game_number: number; side_a_score: number; side_b_score: number }[];
  admin_note?: string;
}) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();
  const { getFormatWeight } = await import('@badminton/shared');

  const activeSeason = await adminClient.from('seasons').select('id').eq('active_flag', true).single();
  const formatWeight = getFormatWeight(data.format as import('@badminton/shared').MatchFormat);

  const scoreSummary = data.games.map(g => `${g.side_a_score}-${g.side_b_score}`).join(', ');

  const { data: match, error: matchError } = await adminClient.from('matches').insert({
    match_type: data.match_type,
    event_type: 'admin_entered',
    rated_flag: data.rated_flag,
    format: data.format,
    format_weight: formatWeight,
    event_multiplier: 1.0,
    completed_flag: true,
    winner_side: data.winner_side,
    score_summary: scoreSummary,
    played_at: new Date().toISOString(),
    submitted_by: admin.id,
    confirmed_by: admin.id,
    result_status: 'confirmed',
    season_id: activeSeason.data?.id || null,
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
    const preRating = isDoubles ? (r?.doubles_elo ?? 1200) : (r?.singles_elo ?? 1200);

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

  await adminClient.from('match_participants').insert(participants);

  const gameRows = data.games.map(g => ({
    match_id: match.id,
    game_number: g.game_number,
    side_a_score: g.side_a_score,
    side_b_score: g.side_b_score,
  }));
  await adminClient.from('match_games').insert(gameRows);

  // Apply Elo if rated
  if (data.rated_flag) {
    const { error: eloError } = await adminClient.rpc('apply_match_result', {
      p_match_id: match.id,
      p_confirmed_by: admin.id,
    });
    if (eloError) {
      Sentry.captureException(new Error(`Elo application failed for admin match: ${eloError.message}`), {
        extra: { matchId: match.id },
      });
    }
  }

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'match_admin_created',
    target_type: 'match',
    target_id: match.id,
    new_value: { ...data, score_summary: scoreSummary },
  });
  if (auditError) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'match_admin_created', matchId: match.id },
    });
  }

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
  rated_flag: boolean;
  side_a_players: string[];
  side_b_players: string[];
  scheduled_date?: string;
  scheduled_time?: string;
  note?: string;
}) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const eventType = data.rated_flag ? 'rated_challenge' : 'casual';

  const { data: challenge, error } = await adminClient.from('challenges').insert({
    type: data.type,
    rated_flag: data.rated_flag,
    format: data.format,
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

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'challenge_admin_created',
    target_type: 'challenge',
    target_id: challenge.id,
    new_value: data,
  });
  if (auditError) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'challenge_admin_created', challengeId: challenge.id },
    });
  }

  revalidatePath('/challenges');
  return challenge.id;
}

// ============================================================
// Varsity Notes
// ============================================================

export async function createVarsityNote(playerId: string, note: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { error } = await adminClient.from('varsity_notes').insert({
    player_id: playerId,
    author_id: admin.id,
    note,
  });

  if (error) throw new Error(error.message);

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'varsity_note_added',
    target_type: 'player',
    target_id: playerId,
    new_value: { note },
  });
  if (auditError) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'varsity_note_added', playerId },
    });
  }

  revalidatePath('/varsity');
}

export async function deleteVarsityNote(noteId: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { error } = await adminClient.from('varsity_notes').delete().eq('id', noteId);
  if (error) throw new Error(error.message);

  revalidatePath('/varsity');
}

// ============================================================
// Challenge Management
// ============================================================

export async function forceExpireChallenge(challengeId: string, reason: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { error } = await adminClient
    .from('challenges')
    .update({ status: 'expired' })
    .eq('id', challengeId);

  if (error) throw new Error(error.message);

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'challenge_force_expired',
    target_type: 'challenge',
    target_id: challengeId,
    reason,
  });
  if (auditError) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'challenge_force_expired', challengeId },
    });
  }

  revalidatePath('/challenges');
}
