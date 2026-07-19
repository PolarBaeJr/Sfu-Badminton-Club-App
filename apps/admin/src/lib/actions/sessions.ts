'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import {
  parseOrThrow,
  sessionCreateSchema,
  sessionGroupSchema,
  attendanceMarkSchema,
  type SessionGroupInput,
  type AttendanceMarkInput,
} from '@badminton/shared';
import { z } from 'zod';
import { getExecOrAdmin } from './_shared';

export async function createSession(data: {
  name: string;
  date: string;
  time?: string;
  end_time?: string;
  location: string;
  notes?: string;
  track: SessionGroupInput;
}) {
  parseOrThrow(sessionCreateSchema, data);
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const activeSeason = await adminClient.from('seasons').select('id').eq('active_flag', true).single();

  const { data: session, error } = await adminClient.from('sessions').insert({
    name: data.name,
    date: data.date,
    start_time: data.time ?? null,
    end_time: data.end_time ?? null,
    location: data.location,
    notes: data.notes || null,
    status: 'open',
    track: data.track,
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
  end_time?: string;
  location: string;
  notes?: string;
  track: SessionGroupInput;
}) {
  parseOrThrow(sessionGroupSchema, data.track);
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('sessions').select('*').eq('id', sessionId).single();

  const { error } = await adminClient.from('sessions').update({
    name: data.name,
    date: data.date,
    start_time: data.time ?? null,
    end_time: data.end_time ?? null,
    location: data.location,
    notes: data.notes || null,
    track: data.track,
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
  const admin = await getExecOrAdmin();
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

export async function markAttendance(input: AttendanceMarkInput) {
  const data = parseOrThrow(attendanceMarkSchema, input);
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { data: old } = await adminClient
    .from('session_attendance')
    .select('*')
    .eq('session_id', data.session_id)
    .eq('player_id', data.player_id)
    .maybeSingle();

  // checked_in_at is deliberately omitted: on conflict the player's original
  // self check-in timestamp is preserved; for walk-ins it defaults to now().
  const { data: row, error } = await adminClient
    .from('session_attendance')
    .upsert({
      session_id: data.session_id,
      player_id: data.player_id,
      status: data.status,
      marked_by: admin.id,
      marked_at: new Date().toISOString(),
    }, { onConflict: 'session_id,player_id' })
    .select()
    .single();

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'session_attendance_marked',
    target_type: 'session_attendance',
    target_id: row.id,
    old_value: old ?? undefined,
    new_value: data,
  }, { sessionId: data.session_id });

  revalidatePath('/sessions');
}

export async function clearAttendanceMark(sessionId: string, playerId: string) {
  parseOrThrow(z.string().uuid(), sessionId);
  parseOrThrow(z.string().uuid(), playerId);
  const admin = await getExecOrAdmin();
  const adminClient = createAdminClient();

  const { data: old } = await adminClient
    .from('session_attendance')
    .select('*')
    .eq('session_id', sessionId)
    .eq('player_id', playerId)
    .maybeSingle();

  if (!old) return;

  const { error } = await adminClient
    .from('session_attendance')
    .delete()
    .eq('session_id', sessionId)
    .eq('player_id', playerId);

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'session_attendance_removed',
    target_type: 'session_attendance',
    target_id: old.id,
    old_value: old,
  }, { sessionId });

  revalidatePath('/sessions');
}

export async function deleteSession(sessionId: string) {
  const admin = await getExecOrAdmin();
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
