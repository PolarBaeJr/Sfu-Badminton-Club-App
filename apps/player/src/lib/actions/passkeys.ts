'use server';

import { revalidatePath } from 'next/cache';
import { createServiceRoleClient } from '../supabase-server';
import { requirePlayer, runAction, type ActionResult } from './_shared';

export type PasskeySummary = {
  id: string;
  nickname: string | null;
  device_type: string | null;
  created_at: string;
  last_used_at: string | null;
};

export async function listPasskeys(): Promise<ActionResult<PasskeySummary[]>> {
  return runAction(async () => {
    const player = await requirePlayer();
    const { data } = await createServiceRoleClient()
      .from('passkey_credentials')
      .select('id, nickname, device_type, created_at, last_used_at')
      .eq('player_id', player.id)
      .order('created_at', { ascending: true });
    return (data ?? []) as PasskeySummary[];
  });
}

export async function deletePasskey(id: string): Promise<ActionResult> {
  return runAction(async () => {
    const player = await requirePlayer();
    // Scoped to the caller's own player_id, so an id belonging to someone else
    // deletes nothing rather than erroring — the filter IS the authorisation.
    await createServiceRoleClient()
      .from('passkey_credentials')
      .delete()
      .eq('id', id)
      .eq('player_id', player.id);
    revalidatePath('/settings');
  });
}
