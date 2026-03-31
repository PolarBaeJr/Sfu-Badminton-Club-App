'use server';

import { createServerSupabaseClient } from '@/lib/supabase-server';
import { revalidatePath } from 'next/cache';

export async function markAllAnnouncementsRead(playerId: string) {
  const supabase = await createServerSupabaseClient();

  // Get all published announcements not yet read by this player
  const { data: announcements } = await supabase
    .from('announcements')
    .select('id')
    .eq('status', 'published');

  if (!announcements || announcements.length === 0) return;

  const { data: existingReads } = await supabase
    .from('announcement_reads')
    .select('announcement_id')
    .eq('player_id', playerId);

  const readIds = new Set(existingReads?.map((r) => r.announcement_id) ?? []);
  const unread = announcements.filter((a) => !readIds.has(a.id));

  if (unread.length > 0) {
    await supabase.from('announcement_reads').insert(
      unread.map((a) => ({
        announcement_id: a.id,
        player_id: playerId,
      }))
    );
  }

  revalidatePath('/announcements');
}
