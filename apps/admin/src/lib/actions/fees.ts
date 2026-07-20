'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import {
  parseOrThrow,
  feeMarkSchema,
  feeWaiveSchema,
  manualFeeSchema,
  playerFlagsSchema,
  type FeeMarkInput,
  type FeeWaiveInput,
  type ManualFeeInput,
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

  // Snapshot the amount: use the explicit input if given, else fall back to the
  // season's per-status fee (competitive vs recreational) so the paid row
  // records what was actually owed.
  let amountCents = input.amount_cents ?? null;
  if (amountCents == null) {
    const [{ data: player }, { data: season }] = await Promise.all([
      adminClient.from('players').select('status').eq('id', input.player_id).single(),
      adminClient
        .from('seasons')
        .select('competitive_fee_cents, recreational_fee_cents')
        .eq('id', input.season_id)
        .single(),
    ]);
    amountCents =
      player?.status === 'competitive'
        ? season?.competitive_fee_cents ?? null
        : season?.recreational_fee_cents ?? null;
  }

  const { data: fee, error } = await adminClient
    .from('club_fees')
    .upsert({
      player_id: input.player_id,
      season_id: input.season_id,
      paid_at: new Date().toISOString(),
      marked_by: admin.id,
      amount_cents: amountCents,
      method: input.method ?? null,
    }, { onConflict: 'player_id,season_id' })
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
      season_id: input.season_id,
      amount_cents: amountCents,
      method: input.method ?? null,
    },
  }, { playerId: input.player_id });

  revalidatePath('/fees');
}

// One-time waiver of the season fee: recorded as a paid row with
// amount_cents 0 and method 'waived' so income sums stay correct.
// Un-waiving is just markFeeUnpaid.
export async function waiveFee(input: FeeWaiveInput) {
  parseOrThrow(feeWaiveSchema, input);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: fee, error } = await adminClient
    .from('club_fees')
    .upsert({
      player_id: input.player_id,
      season_id: input.season_id,
      paid_at: new Date().toISOString(),
      marked_by: admin.id,
      amount_cents: 0,
      method: 'waived',
    }, { onConflict: 'player_id,season_id' })
    .select('id')
    .single();
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'fee_waived',
    target_type: 'club_fee',
    target_id: fee.id,
    new_value: {
      player_id: input.player_id,
      season_id: input.season_id,
      amount_cents: 0,
      method: 'waived',
    },
  }, { playerId: input.player_id });

  revalidatePath('/fees');
}

export async function markFeeUnpaid(playerId: string, seasonId: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: oldFee } = await adminClient
    .from('club_fees')
    .select('id, player_id, season_id, amount_cents, paid_at, method')
    .eq('player_id', playerId)
    .eq('season_id', seasonId)
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

// Manual entry: record a club-fee payment for someone who paid without an
// account (a name, no player row). Inserted already-paid against the season.
export async function addManualFee(input: ManualFeeInput) {
  parseOrThrow(manualFeeSchema, input);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: fee, error } = await adminClient
    .from('club_fees')
    .insert({
      player_id: null,
      manual_name: input.manual_name,
      season_id: input.season_id,
      paid_at: new Date().toISOString(),
      marked_by: admin.id,
      amount_cents: input.amount_cents ?? null,
      method: input.method ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'manual_fee_added',
    target_type: 'club_fee',
    target_id: fee.id,
    new_value: {
      manual_name: input.manual_name,
      season_id: input.season_id,
      amount_cents: input.amount_cents ?? null,
      method: input.method ?? null,
    },
  });

  revalidatePath('/fees');
}

export async function removeManualFee(id: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: oldFee } = await adminClient
    .from('club_fees')
    .select('id, manual_name, season_id, amount_cents, paid_at, method')
    .eq('id', id)
    .single();
  if (!oldFee) throw new Error('Fee record not found');

  const { error } = await adminClient.from('club_fees').delete().eq('id', id);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'manual_fee_removed',
    target_type: 'club_fee',
    target_id: id,
    old_value: oldFee,
  });

  revalidatePath('/fees');
}
