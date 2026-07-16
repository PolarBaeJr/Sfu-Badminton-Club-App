'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import { parseOrThrow, sessionCreateSchema } from '@badminton/shared';
import { getAdminPlayer } from './_shared';

export async function createSession(data: {
  name: string;
  date: string;
  time?: string;
  location: string;
  notes?: string;
}) {
  parseOrThrow(sessionCreateSchema, data);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const activeSeason = await adminClient.from('seasons').select('id').eq('active_flag', true).single();

  const sessionDate = data.time ? `${data.date}T${data.time}` : data.date;

  const { data: session, error } = await adminClient.from('sessions').insert({
    name: data.name,
    date: sessionDate,
    location: data.location,
    notes: data.notes || null,
    status: 'open',
    season_id: activeSeason.data?.id || null,
    host_player_id: admin.id,
  }).select().single();

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'session_created',
    target_type: 'session',
    target_id: session.id,
    new_value: data,
  });

  revalidatePath('/sessions');
  return session;
}

export async function updateSession(sessionId: string, data: {
  name: string;
  date: string;
  time?: string;
  location: string;
  notes?: string;
}) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('sessions').select('*').eq('id', sessionId).single();

  const sessionDate = data.time ? `${data.date}T${data.time}` : data.date;

  const { error } = await adminClient.from('sessions').update({
    name: data.name,
    date: sessionDate,
    location: data.location,
    notes: data.notes || null,
  }).eq('id', sessionId);

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'session_updated',
    target_type: 'session',
    target_id: sessionId,
    old_value: old,
    new_value: data,
  }, { sessionId });

  revalidatePath('/sessions');
}

export async function archiveSession(sessionId: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('sessions').select('status').eq('id', sessionId).single();

  const { error } = await adminClient.from('sessions').update({ status: 'closed' }).eq('id', sessionId);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'session_archived',
    target_type: 'session',
    target_id: sessionId,
    old_value: { status: old?.status },
    new_value: { status: 'closed' },
  }, { sessionId });

  revalidatePath('/sessions');
}

export async function deleteSession(sessionId: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('sessions').select('*').eq('id', sessionId).single();

  // Delete attendance records first
  await adminClient.from('session_attendance').delete().eq('session_id', sessionId);

  const { error } = await adminClient.from('sessions').delete().eq('id', sessionId);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'session_deleted',
    target_type: 'session',
    target_id: sessionId,
    old_value: old,
  }, { sessionId });

  revalidatePath('/sessions');
}
