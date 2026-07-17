'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import {
  parseOrThrow,
  feeTierSchema,
  tournamentFeeMarkSchema,
  type FeeTierInput,
  type TournamentFeeMarkInput,
} from '@badminton/shared';
import { getAdminPlayer } from './_shared';

export async function createFeeTier(input: FeeTierInput) {
  parseOrThrow(feeTierSchema, input);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  // Only one default tier per tournament (uq_tournament_fee_tiers_default).
  if (input.is_default) {
    await adminClient
      .from('tournament_fee_tiers')
      .update({ is_default: false })
      .eq('tournament_id', input.tournament_id);
  }

  const { data: tier, error } = await adminClient
    .from('tournament_fee_tiers')
    .insert({
      tournament_id: input.tournament_id,
      name: input.name,
      amount_cents: input.amount_cents,
      is_default: input.is_default,
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_fee_tier_created',
    target_type: 'tournament_fee_tier',
    target_id: tier.id,
    new_value: input,
  }, { tournamentId: input.tournament_id });

  revalidatePath(`/tournaments/${input.tournament_id}/fees`);
}

export async function updateFeeTier(id: string, input: Partial<FeeTierInput>) {
  parseOrThrow(feeTierSchema.partial(), input);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: old } = await adminClient
    .from('tournament_fee_tiers')
    .select('*')
    .eq('id', id)
    .single();
  if (!old) throw new Error('Fee tier not found');

  // Only one default tier per tournament (uq_tournament_fee_tiers_default).
  if (input.is_default) {
    await adminClient
      .from('tournament_fee_tiers')
      .update({ is_default: false })
      .eq('tournament_id', old.tournament_id)
      .neq('id', id);
  }

  const { error } = await adminClient.from('tournament_fee_tiers').update(input).eq('id', id);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_fee_tier_updated',
    target_type: 'tournament_fee_tier',
    target_id: id,
    old_value: old,
    new_value: input,
  }, { tournamentId: old.tournament_id });

  revalidatePath(`/tournaments/${old.tournament_id}/fees`);
}

export async function deleteFeeTier(id: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: old } = await adminClient
    .from('tournament_fee_tiers')
    .select('*')
    .eq('id', id)
    .single();
  if (!old) throw new Error('Fee tier not found');

  const { error } = await adminClient.from('tournament_fee_tiers').delete().eq('id', id);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_fee_tier_deleted',
    target_type: 'tournament_fee_tier',
    target_id: id,
    old_value: old,
  }, { tournamentId: old.tournament_id });

  revalidatePath(`/tournaments/${old.tournament_id}/fees`);
}

export async function markTournamentFeePaid(input: TournamentFeeMarkInput) {
  parseOrThrow(tournamentFeeMarkSchema, input);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  // Snapshot the amount: explicit input, else the chosen tier's amount, else the
  // tournament's default tier's amount. Records the tier that determined it.
  let tierId = input.tier_id ?? null;
  let amountCents = input.amount_cents ?? null;
  if (amountCents == null) {
    if (tierId) {
      const { data: tier } = await adminClient
        .from('tournament_fee_tiers')
        .select('amount_cents')
        .eq('id', tierId)
        .single();
      amountCents = tier?.amount_cents ?? null;
    } else {
      const { data: tier } = await adminClient
        .from('tournament_fee_tiers')
        .select('id, amount_cents')
        .eq('tournament_id', input.tournament_id)
        .eq('is_default', true)
        .single();
      tierId = tier?.id ?? null;
      amountCents = tier?.amount_cents ?? null;
    }
  }

  const { data: fee, error } = await adminClient
    .from('tournament_fees')
    .upsert({
      tournament_id: input.tournament_id,
      player_id: input.player_id,
      tier_id: tierId,
      amount_cents: amountCents,
      paid_at: new Date().toISOString(),
      marked_by: admin.id,
      method: input.method ?? null,
    }, { onConflict: 'tournament_id,player_id' })
    .select('id')
    .single();
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_fee_marked_paid',
    target_type: 'tournament_fee',
    target_id: fee.id,
    new_value: {
      tournament_id: input.tournament_id,
      player_id: input.player_id,
      tier_id: tierId,
      amount_cents: amountCents,
      method: input.method ?? null,
    },
  }, { tournamentId: input.tournament_id, playerId: input.player_id });

  revalidatePath(`/tournaments/${input.tournament_id}/fees`);
}

export async function markTournamentFeeUnpaid(tournamentId: string, playerId: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: oldFee } = await adminClient
    .from('tournament_fees')
    .select('id, tournament_id, player_id, tier_id, amount_cents, paid_at, method')
    .eq('tournament_id', tournamentId)
    .eq('player_id', playerId)
    .single();
  if (!oldFee) throw new Error('Fee record not found');

  const { error } = await adminClient
    .from('tournament_fees')
    .update({ paid_at: null, marked_by: null, method: null })
    .eq('id', oldFee.id);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'tournament_fee_marked_unpaid',
    target_type: 'tournament_fee',
    target_id: oldFee.id,
    old_value: oldFee,
    new_value: { paid_at: null, marked_by: null, method: null },
  }, { tournamentId, playerId });

  revalidatePath(`/tournaments/${tournamentId}/fees`);
}
