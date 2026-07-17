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
import { getAdminPlayer } from './_shared';

export async function banPlayer(input: BanInput) {
  parseOrThrow(banSchema, input);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { error } = await adminClient
    .from('players')
    .update({
      is_banned: true,
      banned_at: new Date().toISOString(),
      banned_by: admin.id,
      ban_reason: input.reason,
    })
    .eq('id', input.player_id);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'player_banned',
    target_type: 'player',
    target_id: input.player_id,
    new_value: { reason: input.reason },
  }, { playerId: input.player_id });

  revalidatePath('/players');
  revalidatePath('/fees');
}

export async function reinstatePlayer(input: ReinstatementInput) {
  parseOrThrow(reinstatementSchema, input);
  const admin = await getAdminPlayer();
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
      marked_by: admin.id,
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
    actor_id: admin.id,
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
