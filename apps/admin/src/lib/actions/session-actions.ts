'use server';

import { createAdminClient, getAuthenticatedAdmin } from '../supabase-server';
import { revalidatePath } from 'next/cache';
import { toClientError, logError } from '@badminton/shared';

export async function createSession(data: {
  name: string;
  date: string;
  time?: string;
  location: string;
  notes?: string;
  capacity?: number;
  start_time?: string;
  end_time?: string;
  featured?: boolean;
}) {
  const admin = await getAuthenticatedAdmin();
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
    capacity: data.capacity ?? null,
    start_time: data.start_time || null,
    end_time: data.end_time || null,
    featured: data.featured ?? false,
  }).select().single();

  if (error) throw toClientError(error, 'admin.action');

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'session_created',
    target_type: 'session',
    target_id: session.id,
    new_value: data,
  });
  if (auditError) {
    logError('audit_log_write', auditError, { action_type: 'session_created' });
  }

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
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('sessions').select('*').eq('id', sessionId).single();

  const sessionDate = data.time ? `${data.date}T${data.time}` : data.date;

  const { error } = await adminClient.from('sessions').update({
    name: data.name,
    date: sessionDate,
    location: data.location,
    notes: data.notes || null,
  }).eq('id', sessionId);

  if (error) throw toClientError(error, 'admin.action');

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'session_updated',
    target_type: 'session',
    target_id: sessionId,
    old_value: old,
    new_value: data,
  });
  if (auditError) {
    logError('audit_log_write', auditError, { action_type: 'session_updated', sessionId });
  }

  revalidatePath('/sessions');
}

export async function archiveSession(sessionId: string) {
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('sessions').select('status').eq('id', sessionId).single();

  const { error } = await adminClient.from('sessions').update({ status: 'closed' }).eq('id', sessionId);
  if (error) throw toClientError(error, 'admin.action');

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'session_archived',
    target_type: 'session',
    target_id: sessionId,
    old_value: { status: old?.status },
    new_value: { status: 'closed' },
  });
  if (auditError) {
    logError('audit_log_write', auditError, { action_type: 'session_archived', sessionId });
  }

  revalidatePath('/sessions');
}

export async function deleteSession(sessionId: string) {
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('sessions').select('*').eq('id', sessionId).single();

  await adminClient.from('session_attendance').delete().eq('session_id', sessionId);

  const { error } = await adminClient.from('sessions').delete().eq('id', sessionId);
  if (error) throw toClientError(error, 'admin.action');

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'session_deleted',
    target_type: 'session',
    target_id: sessionId,
    old_value: old,
  });
  if (auditError) {
    logError('audit_log_write', auditError, { action_type: 'session_deleted', sessionId });
  }

  revalidatePath('/sessions');
}
