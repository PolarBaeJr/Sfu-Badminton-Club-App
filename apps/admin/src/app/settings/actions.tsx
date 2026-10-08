'use server';

import { z } from 'zod';
import { parseOrThrow } from '@badminton/shared';
import {
  createAdminClient,
  getAuthenticatedConsoleUser,
} from '@/lib/supabase-server';
import { logAdminAudit } from '@/lib/audit';
import { revalidatePath } from 'next/cache';

// Platform configuration moved out to /ratings and /accounts;
// updatePlatformSettings now lives in lib/actions/settings.ts with the rest of
// the admin-only settings domain. What is left here is genuinely per-user.

// Removing a passkey always requires a passkey-verified session (the default
// gate — no skipPasskey), so a stolen Supabase session can't strip the gate.
//
// Gated at the console-user level so a trainer can manage their OWN keys: the
// row check below already pins it to `player.id`, so the lower gate widens
// nothing beyond self-service. Leaving this on the exec gate would have shown a
// trainer a Remove button on /settings that always threw.
export async function removePasskey(credentialId: string) {
  const id = parseOrThrow(z.string().uuid(), credentialId);
  const player = await getAuthenticatedConsoleUser();
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
