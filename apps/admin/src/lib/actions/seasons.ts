'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import { parseOrThrow, seasonFeeSchema, type SeasonFeeInput } from '@badminton/shared';
import { getAdminPlayer, getExecOrAdmin } from './_shared';

export async function createSeason(data: { name: string; start_date: string; end_date?: string }) {
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { data: season, error } = await adminClient.from('seasons').insert({
    name: data.name,
    start_date: data.start_date,
    end_date: data.end_date || null,
    active_flag: false,
  }).select().single();

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'season_created',
    target_type: 'season',
    target_id: season.id,
    new_value: data,
  });

  revalidatePath('/seasons');
}

export async function updateSeasonFees(seasonId: string, fees: SeasonFeeInput) {
  parseOrThrow(seasonFeeSchema, fees);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: old } = await adminClient
    .from('seasons')
    .select('competitive_fee_cents, recreational_fee_cents')
    .eq('id', seasonId)
    .single();

  const { error } = await adminClient
    .from('seasons')
    .update({
      competitive_fee_cents: fees.competitive_fee_cents,
      recreational_fee_cents: fees.recreational_fee_cents,
    })
    .eq('id', seasonId);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'season_fees_updated',
    target_type: 'season',
    target_id: seasonId,
    old_value: old,
    new_value: fees,
  }, { seasonId });

  revalidatePath('/seasons');
  revalidatePath('/fees');
}

export type SeasonEloPolicy = 'carry' | 'soft' | 'full';

export async function setActiveSeason(seasonId: string, eloPolicy: SeasonEloPolicy = 'carry') {
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  // Atomic: snapshot the outgoing season's ELO, switch active, apply the policy.
  // The policy only changes ratings — match history and W-L records are kept.
  const { error } = await adminClient.rpc('activate_season', {
    p_season_id: seasonId,
    p_elo_policy: eloPolicy,
  });
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'season_activated',
    target_type: 'season',
    target_id: seasonId,
    new_value: { elo_policy: eloPolicy },
  }, { seasonId });

  revalidatePath('/seasons');
  revalidatePath('/fees');
}

export async function endSeason(seasonId: string) {
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { error } = await adminClient.from('seasons').update({
    active_flag: false,
    end_date: new Date().toISOString().split('T')[0],
  }).eq('id', seasonId);

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'season_ended',
    target_type: 'season',
    target_id: seasonId,
  }, { seasonId });

  revalidatePath('/seasons');
}
