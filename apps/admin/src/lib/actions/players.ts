'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import {
  parseOrThrow,
  adminPlayerCreateSchema,
  adminPlayerUpdateSchema,
  joinName,
  sendPlayerApprovedEmail,
  type AdminPlayerUpdateInput,
} from '@badminton/shared';
import { getAdminPlayer } from './_shared';
import { runAction, type ActionResult } from '../action-result';

export async function approvePlayer(playerId: string, status: 'competitive' | 'recreational', reason: string): Promise<ActionResult<void>> {
  return runAction(() => approvePlayerImpl(playerId, status, reason));
}

async function approvePlayerImpl(playerId: string, status: 'competitive' | 'recreational', reason: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: oldPlayer } = await adminClient.from('players').select('*').eq('id', playerId).single();

  const { error } = await adminClient
    .from('players')
    .update({
      status,
      active_flag: true,
    })
    .eq('id', playerId);

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'player_approved',
    target_type: 'player',
    target_id: playerId,
    old_value: oldPlayer,
    new_value: { status },
    reason,
  }, { playerId });

  // Tell them they are in. Until now approval was silent: a member who signed
  // up sat at "pending approval" with no way to know it had changed except by
  // opening the app again and guessing.
  //
  // Best-effort — the approval itself is already committed and audited, and a
  // mail failure must not roll that back or surface as a failed action.
  if (oldPlayer?.email) {
    await sendPlayerApprovedEmail(oldPlayer.email, oldPlayer.full_name ?? 'there').catch((err) => {
      Sentry.captureException(err, { extra: { step: 'player-approved-email', playerId } });
    });
  }

  revalidatePath('/players');
  revalidatePath('/dashboard');
}

export async function createPlayer(data: {
  first_name: string;
  last_name?: string;
  email: string;
  status: string;
  role?: string;
  is_exec?: boolean;
}): Promise<ActionResult<string>> {
  return runAction(() => createPlayerImpl(data));
}

async function createPlayerImpl(data: {
  first_name: string;
  last_name?: string;
  email: string;
  status: string;
  role?: string;
  is_exec?: boolean;
}) {
  // Admin accounts cannot be created here — only promoted from existing
  // members via updatePlayer, so every admin went through real signup
  // (and the passkey enrollment path). The schema also excludes 'admin';
  // this check just gives the friendly message before Zod's enum error.
  if (data.role === 'admin') throw new Error('Admins cannot be created directly — promote an existing member instead');
  parseOrThrow(adminPlayerCreateSchema, data);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: existing } = await adminClient.from('players').select('id').eq('email', data.email).maybeSingle();
  if (existing) throw new Error('A player with this email already exists');

  // create_player_with_rating (migration 00003_functions.sql) inserts the
  // player and ratings rows in one transaction.
  const { data: playerId, error } = await adminClient.rpc('create_player_with_rating', {
    p_user_id: null,
    p_email: data.email,
    p_first_name: data.first_name,
    p_last_name: data.last_name || null,
    // Admin-created players have always had display_name seeded with the
    // whole name; joinName reproduces exactly what full_name will generate.
    p_display_name: joinName(data.first_name, data.last_name),
    p_status: data.status || 'recreational',
    p_role: data.role || 'player',
  });

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  if (data.is_exec) {
    await adminClient.from('players').update({ is_exec: true }).eq('id', playerId);
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'player_created',
    target_type: 'player',
    target_id: playerId,
    new_value: { first_name: data.first_name, last_name: data.last_name ?? null, email: data.email, status: data.status, is_exec: data.is_exec ?? false },
    reason: 'Manual admin creation',
  });

  revalidatePath('/players');
  return playerId;
}

export async function updatePlayer(playerId: string, data: AdminPlayerUpdateInput): Promise<ActionResult<void>> {
  return runAction(() => updatePlayerImpl(playerId, data));
}

async function updatePlayerImpl(playerId: string, data: AdminPlayerUpdateInput) {
  parseOrThrow(adminPlayerUpdateSchema, data);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: oldPlayer } = await adminClient.from('players').select('*').eq('id', playerId).single();
  const { data: oldRating } = await adminClient.from('ratings').select('*').eq('player_id', playerId).single();

  const playerUpdate: Record<string, unknown> = {};
  if (data.status) playerUpdate.status = data.status;
  if (data.role) playerUpdate.role = data.role;
  if (data.is_exec !== undefined) playerUpdate.is_exec = data.is_exec;
  if (data.exec_title !== undefined) playerUpdate.exec_title = data.exec_title;
  if (data.fee_exempt !== undefined) playerUpdate.fee_exempt = data.fee_exempt;
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

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'player_updated',
    target_type: 'player',
    target_id: playerId,
    old_value: { player: oldPlayer, rating: oldRating },
    new_value: { ...playerUpdate, ...ratingUpdate },
    reason: data.reason,
  }, { playerId });

  revalidatePath('/players');
  revalidatePath(`/players/${playerId}`);
}

// Backup path for the player's own restore flow: clears a pending
// self-service account deletion (players.deletion_requested_at) before the
// purge-deleted-accounts edge function anonymizes the row.
export async function cancelAccountDeletion(playerId: string): Promise<ActionResult<void>> {
  return runAction(() => cancelAccountDeletionImpl(playerId));
}

async function cancelAccountDeletionImpl(playerId: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: oldPlayer } = await adminClient.from('players').select('*').eq('id', playerId).single();
  if (!oldPlayer?.deletion_requested_at) throw new Error('No deletion is scheduled for this player');

  const { error } = await adminClient
    .from('players')
    .update({ deletion_requested_at: null, active_flag: true })
    .eq('id', playerId);

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'account_deletion_cancelled',
    target_type: 'player',
    target_id: playerId,
    old_value: { deletion_requested_at: oldPlayer.deletion_requested_at },
    new_value: { deletion_requested_at: null, active_flag: true },
  }, { playerId });

  revalidatePath('/players');
  revalidatePath(`/players/${playerId}`);
}

// Force just this player to re-sign the waiver on their next visit. Stamps
// players.waiver_reset_at = now(); the shared getMissingLegalDocuments helper
// then treats their latest waiver acceptance as stale until they re-sign.
export async function requireWaiverResignature(playerId: string): Promise<ActionResult<void>> {
  return runAction(() => requireWaiverResignatureImpl(playerId));
}

async function requireWaiverResignatureImpl(playerId: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: oldPlayer } = await adminClient.from('players').select('waiver_reset_at').eq('id', playerId).single();

  const now = new Date().toISOString();
  const { error } = await adminClient
    .from('players')
    .update({ waiver_reset_at: now })
    .eq('id', playerId);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'waiver_resignature_required',
    target_type: 'player',
    target_id: playerId,
    old_value: { waiver_reset_at: oldPlayer?.waiver_reset_at ?? null },
    new_value: { waiver_reset_at: now },
  }, { playerId });

  revalidatePath('/players');
  revalidatePath(`/players/${playerId}`);
}

export async function removePlayer(playerId: string, reason: string): Promise<ActionResult<void>> {
  return runAction(() => removePlayerImpl(playerId, reason));
}

async function removePlayerImpl(playerId: string, reason: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: oldPlayer } = await adminClient.from('players').select('*').eq('id', playerId).single();

  const { error } = await adminClient
    .from('players')
    .update({ status: 'suspended', active_flag: false })
    .eq('id', playerId);

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'player_removed',
    target_type: 'player',
    target_id: playerId,
    old_value: oldPlayer,
    reason,
  }, { playerId });

  revalidatePath('/players');
  revalidatePath('/dashboard');
}

// ---------------------------------------------------------------------------
// Merge duplicate accounts
// ---------------------------------------------------------------------------
// The recurring case: an admin pre-adds someone to the roster, then that person
// signs up themselves with a different email — two rows, one holding the
// history, one holding the login. Rows can't share a UUID, so merging means
// repointing every reference onto a survivor and deleting the other. All of
// that lives in the merge_players() SQL function (migration 00026), which
// refuses outright if the account being removed has real history.

export interface MergePreviewRow {
  table_name: string;
  row_count: number;
  effect: string;
}

/** What would block this merge — empty array means it's safe to run. */
export async function previewPlayerMerge(
  keepId: string,
  removeId: string,
): Promise<ActionResult<MergePreviewRow[]>> {
  return runAction(async () => {
    await getAdminPlayer();
    const adminClient = createAdminClient();
    const { data, error } = await adminClient.rpc('merge_players_preview', {
      p_keep: keepId,
      p_remove: removeId,
    });
    if (error) throw new Error(error.message);
    // Only surface the rows that actually block; "ok" rows are noise.
    return ((data ?? []) as MergePreviewRow[]).filter((r) => Number(r.row_count) > 0);
  });
}

export async function mergePlayers(
  keepId: string,
  removeId: string,
): Promise<ActionResult<{ login_moved: boolean }>> {
  return runAction(async () => {
    const admin = await getAdminPlayer();
    const adminClient = createAdminClient();

    const { data, error } = await adminClient.rpc('merge_players', {
      p_keep: keepId,
      p_remove: removeId,
      p_actor: admin.id,
    });
    // The function raises with a human-readable reason (history present, two
    // logins, same id) — surface it verbatim rather than a generic failure.
    if (error) throw new Error(error.message);

    revalidatePath('/players');
    return { login_moved: Boolean((data as { login_moved?: boolean } | null)?.login_moved) };
  });
}
