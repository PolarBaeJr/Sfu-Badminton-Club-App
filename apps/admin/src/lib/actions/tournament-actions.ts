'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient, getAuthenticatedAdmin } from '../supabase-server';
import { revalidatePath } from 'next/cache';
import { toClientError } from '@badminton/shared';

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
  const admin = await getAuthenticatedAdmin();
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

  if (error) throw toClientError(error, 'admin.action');

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
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('tournaments').select('status').eq('id', tournamentId).single();

  const { error } = await adminClient.from('tournaments').update({ status }).eq('id', tournamentId);
  if (error) throw toClientError(error, 'admin.action');

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
  const admin = await getAuthenticatedAdmin();
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

  if (error) throw toClientError(error, 'admin.action');

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'tournament_updated',
    target_type: 'tournament',
    target_id: tournamentId,
    old_value: old,
    new_value: data,
  });
  if (auditError) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'tournament_updated', tournamentId },
    });
  }

  revalidatePath('/tournaments');
  revalidatePath(`/tournaments/${tournamentId}`);
}

export async function archiveTournament(tournamentId: string) {
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('tournaments').select('status').eq('id', tournamentId).single();

  const { error } = await adminClient.from('tournaments').update({ status: 'archived' }).eq('id', tournamentId);
  if (error) throw toClientError(error, 'admin.action');

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'tournament_archived',
    target_type: 'tournament',
    target_id: tournamentId,
    old_value: { status: old?.status },
    new_value: { status: 'archived' },
  });
  if (auditError) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'tournament_archived', tournamentId },
    });
  }

  revalidatePath('/tournaments');
}

export async function deleteTournament(tournamentId: string) {
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('tournaments').select('*').eq('id', tournamentId).single();

  await adminClient.from('tournament_participants').delete().eq('tournament_id', tournamentId);
  await adminClient.from('tournament_events').delete().eq('tournament_id', tournamentId);

  const { error } = await adminClient.from('tournaments').delete().eq('id', tournamentId);
  if (error) throw toClientError(error, 'admin.action');

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'tournament_deleted',
    target_type: 'tournament',
    target_id: tournamentId,
    old_value: old,
  });
  if (auditError) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'tournament_deleted', tournamentId },
    });
  }

  revalidatePath('/tournaments');
}

export async function addTournamentParticipant(tournamentId: string, playerId: string, seed: number | null, partnerId?: string) {
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { error } = await adminClient.from('tournament_participants').insert({
    tournament_id: tournamentId,
    player_id: playerId,
    partner_id: partnerId || null,
    seed,
  });

  if (error) {
    if (error.code === '23505') throw new Error('Player already in tournament');
    throw toClientError(error, 'admin.action');
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
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { error } = await adminClient.from('tournament_participants').delete().eq('id', participantId);
  if (error) throw toClientError(error, 'admin.action');

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
