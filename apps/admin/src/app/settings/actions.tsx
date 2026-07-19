'use server';

import { z } from 'zod';
import { parseOrThrow } from '@badminton/shared';
import {
  createAdminClient,
  getAuthenticatedAdmin,
  getAuthenticatedExecOrAdmin,
} from '@/lib/supabase-server';
import { logAdminAudit } from '@/lib/audit';
import { revalidatePath } from 'next/cache';

async function getAdminPlayer() {
  return getAuthenticatedAdmin();
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

// Removing a passkey always requires a passkey-verified session (the default
// gate — no skipPasskey), so a stolen Supabase session can't strip the gate.
export async function removePasskey(credentialId: string) {
  const id = parseOrThrow(z.string().uuid(), credentialId);
  const player = await getAuthenticatedExecOrAdmin();
  const adminClient = createAdminClient();

  const { data: row } = await adminClient
    .from('passkey_credentials')
    .select('id, player_id, nickname')
    .eq('id', id)
    .maybeSingle();
  if (!row || row.player_id !== player.id) throw new Error('Passkey not found');

  const { error } = await adminClient.from('passkey_credentials').delete().eq('id', row.id);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: player.id,
    action_type: 'passkey_removed',
    target_type: 'passkey_credential',
    target_id: row.id,
    old_value: { nickname: row.nickname },
    reason: 'Passkey removed',
  });

  revalidatePath('/settings');
}
