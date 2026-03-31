'use server';

import { createAdminClient } from '@/lib/supabase-server';
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
  // DEV MODE: grab first player as admin (no auth flow)
  const adminClient = createAdminClient();
  const { data: player } = await adminClient
    .from('players')
    .select('*')
    .limit(1)
    .single();
  if (!player) throw new Error('No players found in database');
  return { ...player, role: 'admin' };
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
