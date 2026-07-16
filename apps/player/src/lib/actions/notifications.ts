'use server';

import { revalidatePath } from 'next/cache';
import { createServerSupabaseClient } from '../supabase-server';
import { requirePlayer } from './_shared';

export async function markNotificationRead(notificationId: string) {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();
  await supabase
    .from('notifications')
    .update({ read_flag: true })
    .eq('id', notificationId)
    .eq('player_id', player.id);
  revalidatePath('/notifications');
}

export async function markAllNotificationsRead() {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();
  await supabase
    .from('notifications')
    .update({ read_flag: true })
    .eq('player_id', player.id)
    .eq('read_flag', false);
  revalidatePath('/notifications');
}

export async function markAnnouncementRead(announcementId: string) {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  const { data: existing } = await supabase
    .from('announcement_reads')
    .select('id')
    .eq('announcement_id', announcementId)
    .eq('player_id', player.id)
    .maybeSingle();

  if (existing) return;

  await supabase.from('announcement_reads').insert({
    announcement_id: announcementId,
    player_id: player.id,
  });

  revalidatePath('/announcements');
}
