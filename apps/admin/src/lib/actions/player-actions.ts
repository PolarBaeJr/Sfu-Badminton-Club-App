'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient, getAuthenticatedAdmin } from '../supabase-server';
import { revalidatePath } from 'next/cache';
import type { AdminPlayerUpdateInput } from '@badminton/shared';
import { toClientError } from '@badminton/shared';

export async function approvePlayer(playerId: string, status: 'competitive' | 'recreational', reason: string) {
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: oldPlayer } = await adminClient.from('players').select('*').eq('id', playerId).single();

  const { error } = await adminClient
    .from('players')
    .update({
      status,
      active_flag: true,
    })
    .eq('id', playerId);

  if (error) throw toClientError(error, 'admin.action');

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'player_approved',
    target_type: 'player',
    target_id: playerId,
    old_value: oldPlayer,
    new_value: { status },
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

export async function createPlayer(data: {
  full_name: string;
  email: string;
  status: string;
  role?: string;
}) {
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: existing } = await adminClient.from('players').select('id').eq('email', data.email).single();
  if (existing) throw new Error('A player with this email already exists');

  const { data: player, error } = await adminClient.from('players').insert({
    full_name: data.full_name,
    email: data.email,
    display_name: data.full_name,
    status: data.status || 'recreational',
    role: data.role || 'player',
    active_flag: true,
    onboarding_completed: false,
  }).select().single();

  if (error) {
    Sentry.captureException(error);
    throw toClientError(error, 'admin.action');
  }

  await adminClient.from('ratings').insert({
    player_id: player.id,
    singles_elo: 1200,
    doubles_elo: 1200,
    singles_provisional: true,
    doubles_provisional: true,
    singles_k_factor: 40,
    doubles_k_factor: 40,
  });

  await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'player_created',
    target_type: 'player',
    target_id: player.id,
    new_value: { full_name: data.full_name, email: data.email, status: data.status },
    reason: 'Manual admin creation',
  });

  revalidatePath('/players');
  return player;
}

export async function updatePlayer(playerId: string, data: AdminPlayerUpdateInput) {
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: oldPlayer } = await adminClient.from('players').select('*').eq('id', playerId).single();
  const { data: oldRating } = await adminClient.from('ratings').select('*').eq('player_id', playerId).single();

  const playerUpdate: Record<string, unknown> = {};
  if (data.status) playerUpdate.status = data.status;
  if (data.role) playerUpdate.role = data.role;
  if (Object.keys(playerUpdate).length > 0) {
    const { error } = await adminClient.from('players').update(playerUpdate).eq('id', playerId);
    if (error) throw toClientError(error, 'admin.action');
  }

  const ratingUpdate: Record<string, unknown> = {};
  if (data.singles_elo !== undefined) ratingUpdate.singles_elo = data.singles_elo;
  if (data.doubles_elo !== undefined) ratingUpdate.doubles_elo = data.doubles_elo;

  if (Object.keys(ratingUpdate).length > 0) {
    const { error } = await adminClient.from('ratings').update(ratingUpdate).eq('player_id', playerId);
    if (error) throw toClientError(error, 'admin.action');
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
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: oldPlayer } = await adminClient.from('players').select('*').eq('id', playerId).single();

  const { error } = await adminClient
    .from('players')
    .update({ status: 'suspended', active_flag: false })
    .eq('id', playerId);

  if (error) throw toClientError(error, 'admin.action');

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
