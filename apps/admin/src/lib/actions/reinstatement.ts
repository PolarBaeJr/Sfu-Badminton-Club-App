'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import {
  parseOrThrow,
  banSchema,
  reinstatementSchema,
  type BanInput,
  type ReinstatementInput,
} from '@badminton/shared';
import { getExecOrAdmin } from './_shared';
import { ExpectedError } from '@badminton/shared';
import { isAdminActor } from '../player-field-access';

// Ban/unban is exec work — the club owner named it explicitly. Note that this
// writes is_banned, which the guard_player_privileged_columns trigger also
// lists; that trigger returns early when auth.uid() IS NULL, and this runs on
// the service-role client, so it never fires here. The gate is this function.
export async function banPlayer(input: BanInput) {
  parseOrThrow(banSchema, input);
  const actor = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { error } = await adminClient
    .from('players')
    .update({
      is_banned: true,
      banned_at: new Date().toISOString(),
      banned_by: actor.id,
      ban_reason: input.reason,
    })
    .eq('id', input.player_id);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: actor.id,
    action_type: 'player_banned',
    target_type: 'player',
    target_id: input.player_id,
    new_value: { reason: input.reason },
  }, { playerId: input.player_id });

  revalidatePath('/players');
  revalidatePath('/fees');
}

export async function reinstatePlayer(input: ReinstatementInput) {
  const parsed = parseOrThrow(reinstatementSchema, input);
  const actor = await getExecOrAdmin();
  // Lifting the ban is exec work; recording what was collected for it is not.
  // This inserts a reinstatement_fees row and revalidates /fees, which is
  // admin-only in the same access map — so an exec reinstates for free and an
  // admin records the money. Rejected rather than dropped: a silently ignored
  // amount would leave the ledger short with nothing to show for it.
  if (!isAdminActor(actor) && (parsed.amount_cents !== undefined || parsed.method !== undefined)) {
    throw new ExpectedError('Admin access required to record a reinstatement fee');
  }
  const adminClient = createAdminClient();

  // Snapshot the ban reason onto the reinstatement record before clearing it.
  const { data: player } = await adminClient
    .from('players')
    .select('ban_reason')
    .eq('id', input.player_id)
    .single();

  const { data: fee, error: feeError } = await adminClient
    .from('reinstatement_fees')
    .insert({
      player_id: input.player_id,
      amount_cents: input.amount_cents ?? null,
      paid_at: new Date().toISOString(),
      marked_by: actor.id,
      method: input.method ?? null,
      ban_reason: player?.ban_reason ?? null,
    })
    .select('id')
    .single();
  if (feeError) throw new Error(feeError.message);

  const { error } = await adminClient
    .from('players')
    .update({
      is_banned: false,
      banned_at: null,
      banned_by: null,
      ban_reason: null,
    })
    .eq('id', input.player_id);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: actor.id,
    action_type: 'player_reinstated',
    target_type: 'player',
    target_id: input.player_id,
    new_value: {
      reinstatement_fee_id: fee.id,
      amount_cents: input.amount_cents ?? null,
      method: input.method ?? null,
    },
  }, { playerId: input.player_id });

  revalidatePath('/players');
  revalidatePath('/fees');
}
