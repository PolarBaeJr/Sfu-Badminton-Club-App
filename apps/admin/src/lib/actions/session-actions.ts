'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient, getAuthenticatedAdmin } from '../supabase-server';
import { revalidatePath } from 'next/cache';
import { toClientError } from '@badminton/shared';

export async function createSession(data: {
  name: string;
  date: string;
  time?: string;
  location: string;
  notes?: string;
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
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'session_created' },
    });
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
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'session_updated', sessionId },
    });
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
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'session_archived', sessionId },
    });
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
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'session_deleted', sessionId },
    });
  }

  revalidatePath('/sessions');
}
