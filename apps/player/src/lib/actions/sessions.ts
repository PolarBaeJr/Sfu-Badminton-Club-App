'use server';

import { revalidatePath } from 'next/cache';
import { createServerSupabaseClient } from '../supabase-server';
import { requirePlayer, getPlayerProps, trackServerEvent } from './_shared';

export async function checkInToSession(sessionId: string) {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  const { error } = await supabase.from('session_attendance').insert({
    session_id: sessionId,
    player_id: player.id,
  });

  if (error) {
    if (error.code === '23505') throw new Error('Already checked in');
    throw new Error(error.message);
  }

  await supabase.from('players').update({ last_active_at: new Date().toISOString() }).eq('id', player.id);

  trackServerEvent(player.id, 'session_checked_in', { ...getPlayerProps(player), session_id: sessionId });
  revalidatePath('/sessions');
  revalidatePath(`/sessions/${sessionId}`);
}
