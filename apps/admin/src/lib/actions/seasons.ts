'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import { getAdminPlayer } from './_shared';

export async function createSeason(data: { name: string; start_date: string; end_date?: string }) {
  const admin = await getAdminPlayer();
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

export async function setActiveSeason(seasonId: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  // Deactivate all seasons first
  await adminClient.from('seasons').update({ active_flag: false }).neq('id', '00000000-0000-0000-0000-000000000000');

  const { error } = await adminClient.from('seasons').update({ active_flag: true }).eq('id', seasonId);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'season_activated',
    target_type: 'season',
    target_id: seasonId,
  }, { seasonId });

  revalidatePath('/seasons');
}

export async function endSeason(seasonId: string) {
  const admin = await getAdminPlayer();
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
