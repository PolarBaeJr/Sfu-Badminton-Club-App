'use server';

import { revalidatePath } from 'next/cache';
import { ExpectedError } from '@badminton/shared';
import { createServiceRoleClient, getCurrentPlayer } from '../supabase-server';
import { runAction, type ActionResult } from './_shared';

export type PasskeySummary = {
  id: string;
  nickname: string | null;
  device_type: string | null;
  created_at: string;
  last_used_at: string | null;
  // Which app enrolled it (00051). Shown, never filtered on — see listPasskeys.
  enrolled_via: 'admin' | 'player';
};

// Identity only — deliberately NOT requirePlayer().
//
// This is why the settings page said "No passkeys yet" for an account whose
// credential was plainly visible in the admin console. requirePlayer() is the
// GAMEPLAY gate: it rejects pending_approval, suspended and banned accounts. So
// while a member was suspended (or banned, or awaiting approval) this action
// threw, PasskeyManager turned the failure into an empty list, and the empty
// list rendered as the confident sentence "No passkeys yet". The console asks a
// different question entirely — console access — so the two surfaces disagreed
// about the same rows in the same table.
//
// Managing your own credentials is account SECURITY, not a membership perk. A
// member who has just been suspended is exactly the person who may need to
// revoke a passkey, and someone still awaiting approval should be able to see
// what is enrolled on their account. Both queries below are pinned to the
// caller's own player_id, so the gate can safely be "are you signed in".
async function requireSignedInPlayer() {
  const player = await getCurrentPlayer();
  if (!player) throw new ExpectedError('Not authenticated');
  return player;
}

export async function listPasskeys(): Promise<ActionResult<PasskeySummary[]>> {
  return runAction(async () => {
    const player = await requireSignedInPlayer();
    // No enrolled_via filter, on purpose. 00051 narrowed what ARMS the admin
    // console's second factor to admin-enrolled credentials; it did not change
    // who OWNS them. Both kinds belong to this member, both can sign them in on
    // either app, and both must be listed here or they cannot revoke one.
    const { data, error } = await createServiceRoleClient()
      .from('passkey_credentials')
      .select('id, nickname, device_type, created_at, last_used_at, enrolled_via')
      .eq('player_id', player.id)
      .order('created_at', { ascending: true });

    // Was swallowed (`const { data } = ...`), which is the other half of the
    // same bug: a failed query returned null, became [], and was reported to the
    // member as "you have no passkeys". Never answer a question you could not
    // actually look up.
    if (error) throw new Error(error.message);
    return (data ?? []) as PasskeySummary[];
  });
}

export async function deletePasskey(id: string): Promise<ActionResult> {
  return runAction(async () => {
    const player = await requireSignedInPlayer();
    // Scoped to the caller's own player_id, so an id belonging to someone else
    // deletes nothing rather than erroring — the filter IS the authorisation.
    //
    // The error matters: migration 00050 puts a BEFORE DELETE trigger on this
    // table that refuses to remove the last passkey held by an admin, and its
    // message tells you to enrol a replacement first. Discarding it left the UI
    // reporting "Passkey removed" for a row that is still there.
    const { error } = await createServiceRoleClient()
      .from('passkey_credentials')
      .delete()
      .eq('id', id)
      .eq('player_id', player.id);
    if (error) throw new Error(error.message);
    revalidatePath('/settings');
  });
}
