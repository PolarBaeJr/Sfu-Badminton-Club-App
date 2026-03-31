'use server';

import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server';
import { revalidatePath } from 'next/cache';

interface AnnouncementInput {
  type: string;
  title: string;
  body: string;
  pinned: boolean;
  send_push: boolean;
  target_audience: string;
}

async function getAdminPlayer() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');
  const { data: player } = await supabase
    .from('players')
    .select('*')
    .eq('user_id', user.id)
    .single();
  if (!player || (player.role !== 'admin' && player.role !== 'moderator')) throw new Error('Not authorized');
  return player;
}

export async function publishAnnouncement(input: AnnouncementInput) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: announcement, error } = await adminClient
    .from('announcements')
    .insert({
      title: input.title,
      body: input.body,
      type: input.type,
      author_id: admin.id,
      pinned: input.pinned,
      send_push: input.send_push,
      target_audience: input.target_audience,
      status: 'published',
    })
    .select()
    .single();

  if (error) throw new Error(error.message);

  await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'announcement_published',
    target_type: 'announcement',
    target_id: announcement.id,
    new_value: { title: input.title, type: input.type, audience: input.target_audience },
  });

  revalidatePath('/announcements');
  return announcement.id;
}

export async function saveDraftAnnouncement(input: AnnouncementInput) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { error } = await adminClient
    .from('announcements')
    .insert({
      title: input.title,
      body: input.body,
      type: input.type,
      author_id: admin.id,
      pinned: input.pinned,
      send_push: input.send_push,
      target_audience: input.target_audience,
      status: 'draft',
    });

  if (error) throw new Error(error.message);
  revalidatePath('/announcements');
}

export async function deleteAnnouncement(announcementId: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { error } = await adminClient
    .from('announcements')
    .delete()
    .eq('id', announcementId);

  if (error) throw new Error(error.message);

  await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'announcement_deleted',
    target_type: 'announcement',
    target_id: announcementId,
  });

  revalidatePath('/announcements');
}
