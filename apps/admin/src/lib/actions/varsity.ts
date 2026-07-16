'use server';

import { createAdminClient } from '../supabase-server';
import { revalidatePath } from 'next/cache';
import { getAdminPlayer } from './_shared';

export async function createVarsityNote(playerId: string, note: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { error } = await adminClient.from('varsity_notes').insert({
    player_id: playerId,
    note,
    author_id: admin.id,
  });

  if (error) throw new Error(error.message);

  revalidatePath('/varsity');
}

export async function deleteVarsityNote(noteId: string) {
  await getAdminPlayer();
  const adminClient = createAdminClient();

  const { error } = await adminClient.from('varsity_notes').delete().eq('id', noteId);

  if (error) throw new Error(error.message);

  revalidatePath('/varsity');
}
