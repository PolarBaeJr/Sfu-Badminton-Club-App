'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import {
  parseOrThrow,
  feeMarkSchema,
  playerFlagsSchema,
  type FeeMarkInput,
  type PlayerFlagsInput,
} from '@badminton/shared';
import { getAdminPlayer } from './_shared';

// Club-admin markers: is_exec (executive team) and fee_exempt (exempted from
// the club fee). Neither affects gameplay, ratings, or leaderboards — they
// only control the fee-collection list.
export async function updatePlayerFlags(playerId: string, flags: PlayerFlagsInput) {
  parseOrThrow(playerFlagsSchema, flags);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: oldPlayer } = await adminClient
    .from('players')
    .select('is_exec, fee_exempt')
    .eq('id', playerId)
    .single();

  const { error } = await adminClient
    .from('players')
    .update({ is_exec: flags.is_exec, fee_exempt: flags.fee_exempt })
    .eq('id', playerId);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'player_flags_updated',
    target_type: 'player',
    target_id: playerId,
    old_value: oldPlayer,
    new_value: flags,
  }, { playerId });

  revalidatePath('/players');
  revalidatePath(`/players/${playerId}`);
  revalidatePath('/fees');
}

export async function markFeePaid(input: FeeMarkInput) {
  parseOrThrow(feeMarkSchema, input);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: fee, error } = await adminClient
    .from('club_fees')
    .upsert({
      player_id: input.player_id,
      period: input.period,
      paid_at: new Date().toISOString(),
      marked_by: admin.id,
      amount_cents: input.amount_cents ?? null,
      method: input.method ?? null,
    }, { onConflict: 'player_id,period' })
    .select('id')
    .single();
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'fee_marked_paid',
    target_type: 'club_fee',
    target_id: fee.id,
    new_value: {
      player_id: input.player_id,
      period: input.period,
      amount_cents: input.amount_cents ?? null,
      method: input.method ?? null,
    },
  }, { playerId: input.player_id });

  revalidatePath('/fees');
}

export async function markFeeUnpaid(playerId: string, period: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: oldFee } = await adminClient
    .from('club_fees')
    .select('id, player_id, period, amount_cents, paid_at, method')
    .eq('player_id', playerId)
    .eq('period', period)
    .single();
  if (!oldFee) throw new Error('Fee record not found');

  // Keep the row — only clear the payment fields.
  const { error } = await adminClient
    .from('club_fees')
    .update({ paid_at: null, marked_by: null, method: null })
    .eq('id', oldFee.id);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'fee_marked_unpaid',
    target_type: 'club_fee',
    target_id: oldFee.id,
    old_value: oldFee,
    new_value: { paid_at: null, marked_by: null, method: null },
  }, { playerId });

  revalidatePath('/fees');
}
