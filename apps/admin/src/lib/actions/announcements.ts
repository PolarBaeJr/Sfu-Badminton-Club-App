'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import { parseOrThrow, announcementSchema } from '@badminton/shared';
import { getAdminPlayer } from './_shared';

export async function createAnnouncement(data: {
  title: string;
  body: string;
  type: 'info' | 'warning' | 'urgent' | 'event';
  target_audience: 'all' | 'competitive' | 'recreational' | 'eligible_only';
  pinned: boolean;
  send_push: boolean;
  status: 'draft' | 'published';
  expires_at?: string;
}) {
  parseOrThrow(announcementSchema, data);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: announcement, error } = await adminClient.from('announcements').insert({
    title: data.title,
    body: data.body,
    type: data.type,
    target_audience: data.target_audience,
    pinned: data.pinned,
    send_push: data.send_push,
    status: data.status,
    expires_at: data.expires_at || null,
    author_id: admin.id,
  }).select().single();

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'announcement_created',
    target_type: 'announcement',
    target_id: announcement.id,
    new_value: data,
  });

  revalidatePath('/announcements');
  return announcement;
}

export async function updateAnnouncement(announcementId: string, data: {
  title: string;
  body: string;
  type: 'info' | 'warning' | 'urgent' | 'event';
  target_audience: 'all' | 'competitive' | 'recreational' | 'eligible_only';
  pinned: boolean;
  send_push: boolean;
  status: 'draft' | 'published';
  expires_at?: string;
}) {
  parseOrThrow(announcementSchema, data);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('announcements').select('*').eq('id', announcementId).single();

  const { error } = await adminClient.from('announcements').update({
    title: data.title,
    body: data.body,
    type: data.type,
    target_audience: data.target_audience,
    pinned: data.pinned,
    send_push: data.send_push,
    status: data.status,
    expires_at: data.expires_at || null,
  }).eq('id', announcementId);

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'announcement_updated',
    target_type: 'announcement',
    target_id: announcementId,
    old_value: old,
    new_value: data,
  }, { announcementId });

  revalidatePath('/announcements');
}

export async function deleteAnnouncement(announcementId: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('announcements').select('*').eq('id', announcementId).single();

  await adminClient.from('announcement_reads').delete().eq('announcement_id', announcementId);

  const { error } = await adminClient.from('announcements').delete().eq('id', announcementId);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'announcement_deleted',
    target_type: 'announcement',
    target_id: announcementId,
    old_value: old,
  }, { announcementId });

  revalidatePath('/announcements');
}
