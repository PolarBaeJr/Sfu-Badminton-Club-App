'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import { parseOrThrow, tournamentCreateSchema, tournamentSuspendSchema } from '@badminton/shared';
import { getExecOrAdmin } from './_shared';

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
  parseOrThrow(tournamentCreateSchema, data);
  const admin = await getExecOrAdmin();
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

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_created',
    target_type: 'tournament',
    target_id: tournament.id,
    new_value: data,
  });

  revalidatePath('/tournaments');
  return tournament.id;
}

export async function updateTournamentStatus(tournamentId: string, status: string) {
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('tournaments').select('status').eq('id', tournamentId).single();

  // An explicit status change also lifts any suspension, so completing a
  // suspended tournament doesn't leave it flagged as paused.
  const { error } = await adminClient.from('tournaments')
    .update({ status, suspended_at: null, suspension_reason: null })
    .eq('id', tournamentId);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_status_changed',
    target_type: 'tournament',
    target_id: tournamentId,
    old_value: { status: old?.status },
    new_value: { status },
  }, { tournamentId });

  revalidatePath('/tournaments');
  revalidatePath(`/tournaments/${tournamentId}`);
}

export async function updateTournament(tournamentId: string, data: {
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
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('tournaments').select('*').eq('id', tournamentId).single();

  const { error } = await adminClient.from('tournaments').update({
    name: data.name,
    scope: data.scope,
    type: data.type,
    format: data.format,
    start_date: data.start_date,
    end_date: data.end_date || null,
    bracket_size: data.bracket_size,
    event_multiplier: data.event_multiplier,
    placement_bonus_enabled: data.placement_bonus_enabled,
  }).eq('id', tournamentId);

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_updated',
    target_type: 'tournament',
    target_id: tournamentId,
    old_value: old,
    new_value: data,
  }, { tournamentId });

  revalidatePath('/tournaments');
  revalidatePath(`/tournaments/${tournamentId}`);
}

export async function suspendTournament(tournamentId: string, reason: string) {
  parseOrThrow(tournamentSuspendSchema, { tournament_id: tournamentId, reason });
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('tournaments')
    .select('status, suspended_at').eq('id', tournamentId).single();
  if (!old) throw new Error('Tournament not found');
  if (old.status !== 'active' || old.suspended_at) {
    throw new Error('Only an active, non-suspended tournament can be suspended');
  }

  const suspendedAt = new Date().toISOString();
  const { error } = await adminClient.from('tournaments')
    .update({ suspended_at: suspendedAt, suspension_reason: reason })
    .eq('id', tournamentId);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_suspended',
    target_type: 'tournament',
    target_id: tournamentId,
    old_value: { suspended_at: null, suspension_reason: null },
    new_value: { suspended_at: suspendedAt, suspension_reason: reason },
    reason,
  }, { tournamentId });

  revalidatePath('/tournaments');
  revalidatePath(`/tournaments/${tournamentId}`);
}

export async function resumeTournament(tournamentId: string) {
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('tournaments')
    .select('suspended_at, suspension_reason').eq('id', tournamentId).single();
  if (!old) throw new Error('Tournament not found');
  if (!old.suspended_at) throw new Error('Tournament is not suspended');

  const { error } = await adminClient.from('tournaments')
    .update({ suspended_at: null, suspension_reason: null })
    .eq('id', tournamentId);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_resumed',
    target_type: 'tournament',
    target_id: tournamentId,
    old_value: { suspended_at: old.suspended_at, suspension_reason: old.suspension_reason },
    new_value: { suspended_at: null, suspension_reason: null },
  }, { tournamentId });

  revalidatePath('/tournaments');
  revalidatePath(`/tournaments/${tournamentId}`);
}

export async function archiveTournament(tournamentId: string) {
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('tournaments').select('status').eq('id', tournamentId).single();

  // Archiving lifts any suspension (same rationale as updateTournamentStatus).
  const { error } = await adminClient.from('tournaments')
    .update({ status: 'archived', suspended_at: null, suspension_reason: null })
    .eq('id', tournamentId);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_archived',
    target_type: 'tournament',
    target_id: tournamentId,
    old_value: { status: old?.status },
    new_value: { status: 'archived' },
  }, { tournamentId });

  revalidatePath('/tournaments');
}

export async function deleteTournament(tournamentId: string) {
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('tournaments').select('*').eq('id', tournamentId).single();

  // Delete related data first
  await adminClient.from('tournament_participants').delete().eq('tournament_id', tournamentId);
  await adminClient.from('tournament_events').delete().eq('tournament_id', tournamentId);

  const { error } = await adminClient.from('tournaments').delete().eq('id', tournamentId);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_deleted',
    target_type: 'tournament',
    target_id: tournamentId,
    old_value: old,
  }, { tournamentId });

  revalidatePath('/tournaments');
}

export async function addTournamentParticipant(tournamentId: string, playerId: string, seed: number | null, partnerId?: string) {
  const admin = await getExecOrAdmin();
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

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_participant_added',
    target_type: 'tournament',
    target_id: tournamentId,
    new_value: { player_id: playerId, seed, partner_id: partnerId },
  }, { tournamentId });

  revalidatePath(`/tournaments/${tournamentId}`);
}

export async function removeTournamentParticipant(participantId: string, tournamentId: string) {
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  // Try new table name first, fall back to old if migration hasn't run
  const { error: err1 } = await adminClient.from('legacy_tournament_participants').delete().eq('id', participantId);
  if (err1) {
    const { error: err2 } = await adminClient.from('tournament_participants').delete().eq('id', participantId);
    if (err2) throw new Error(err2.message);
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_participant_removed',
    target_type: 'tournament',
    target_id: tournamentId,
    new_value: { participant_id: participantId },
  }, { tournamentId });

  revalidatePath(`/tournaments/${tournamentId}`);
}
