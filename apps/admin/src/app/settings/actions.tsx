'use server';

import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server';
import { revalidatePath } from 'next/cache';

async function getAdminPlayer() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');
  const { data: player } = await supabase
    .from('players')
    .select('*')
    .eq('user_id', user.id)
    .single();
  if (!player || player.role !== 'admin') throw new Error('Not authorized');
  return player;
}

export async function updatePlatformSettings(
  updates: { key: string; value: Record<string, unknown> }[]
) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  for (const update of updates) {
    const { data: oldSetting } = await adminClient
      .from('platform_settings')
      .select('value')
      .eq('key', update.key)
      .single();

    const { error } = await adminClient
      .from('platform_settings')
      .update({
        value: update.value,
        updated_by: admin.id,
        updated_at: new Date().toISOString(),
      })
      .eq('key', update.key);

    if (error) throw new Error(`Failed to update ${update.key}: ${error.message}`);

    await adminClient.from('audit_logs').insert({
      actor_id: admin.id,
      action_type: 'platform_setting_updated',
      target_type: 'platform_setting',
      target_id: update.key,
      old_value: oldSetting?.value ?? null,
      new_value: update.value,
      reason: `Platform setting "${update.key}" updated`,
    });
  }

  revalidatePath('/settings');
}
