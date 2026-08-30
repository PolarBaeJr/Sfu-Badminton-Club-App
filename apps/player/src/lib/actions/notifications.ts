'use server';

import { revalidatePath } from 'next/cache';
import { createServerSupabaseClient } from '../supabase-server';
import { requirePlayer, runAction, type ActionResult } from './_shared';

export async function markNotificationRead(notificationId: string): Promise<ActionResult> {
  return runAction(() => markNotificationReadImpl(notificationId));
}

async function markNotificationReadImpl(notificationId: string) {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();
  // THE ERROR WAS DISCARDED. supabase-js resolves rather than rejects, so an
  // RLS denial or a transient fault arrived as a fulfilled promise carrying
  // `error` — the action reported success, the bell kept its badge, and there
  // was no Sentry event to explain why. Throwing hands it to runAction, which
  // captures it and returns ok:false so the UI can say something true.
  const { error } = await supabase
    .from('notifications')
    .update({ read_flag: true })
    .eq('id', notificationId)
    .eq('player_id', player.id);
  if (error) throw new Error(error.message);
  revalidatePath('/notifications');
}

export async function markAllNotificationsRead(): Promise<ActionResult> {
  return runAction(() => markAllNotificationsReadImpl());
}

async function markAllNotificationsReadImpl() {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from('notifications')
    .update({ read_flag: true })
    .eq('player_id', player.id)
    .eq('read_flag', false);
  if (error) throw new Error(error.message);
  revalidatePath('/notifications');
}

export async function markAnnouncementRead(announcementId: string): Promise<ActionResult> {
  return runAction(() => markAnnouncementReadImpl(announcementId));
}

async function markAnnouncementReadImpl(announcementId: string) {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  // SELECT-then-INSERT was a check-then-act against a UNIQUE constraint that
  // already says the same thing: two tabs marking the same announcement read at
  // once both saw no row and both inserted, and the loser's 23505 was
  // discarded along with every other error. Upsert states the intent in one
  // statement — the constraint decides, and a duplicate is a no-op rather than
  // a swallowed failure.
  const { error } = await supabase
    .from('announcement_reads')
    .upsert(
      { announcement_id: announcementId, player_id: player.id },
      { onConflict: 'announcement_id,player_id', ignoreDuplicates: true },
    );
  if (error) throw new Error(error.message);

  revalidatePath('/announcements');
}
