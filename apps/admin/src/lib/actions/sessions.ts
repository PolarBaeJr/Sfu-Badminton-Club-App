'use server';

import { randomBytes } from 'crypto';
import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { requireReason } from '../audit-reason';
import { notifyPlayers } from '../notify';
import { revalidatePath } from 'next/cache';
import {
  parseOrThrow,
  sessionCreateSchema,
  sessionGroupSchema,
  attendanceMarkSchema,
  formatDate,
  formatTime,
  type SessionGroupInput,
  type AttendanceMarkInput,
  requireActiveSeasonId,
} from '@badminton/shared';
import { z } from 'zod';
import { requireCapability } from './_shared';
import { runAction, type ActionResult } from '../action-result';
import { remindSessionGoers } from '../session-reminders';

export async function createSession(data: {
  name: string;
  date: string;
  time?: string;
  end_time?: string;
  location: string;
  notes?: string;
  track: SessionGroupInput;
  repeat_until?: string;
  excluded_dates?: string[];
}): Promise<ActionResult<Awaited<ReturnType<typeof createSessionImpl>>>> {
  return runAction(() => createSessionImpl(data));
}

// Remind every player who RSVP'd "going" to a session. This is the reusable
// core a scheduled reminder job will call later; for now it's driven manually
// by the admin "Send reminder" button. Best-effort push (category 'sessions')
// plus the always-on in-app bell.
export async function sendSessionReminders(sessionId: string): Promise<ActionResult<{ notified: number }>> {
  return runAction(async () => {
    const admin = await requireCapability('sessions.reminders.write');
    return remindSessionGoers(sessionId, admin.id);
  });
}

async function createSessionImpl(data: {
  name: string;
  date: string;
  time?: string;
  end_time?: string;
  location: string;
  notes?: string;
  track: SessionGroupInput;
  repeat_until?: string;
  excluded_dates?: string[];
}) {
  parseOrThrow(sessionCreateSchema, data);
  const admin = await requireCapability('sessions.create.write');
  const adminClient = createAdminClient();

  // Weekly recurrence: same weekday, stepping +7 days up to repeat_until.
  // UTC math on the YYYY-MM-DD string — a local Date would drift across DST.
  const series = [data.date];
  if (data.repeat_until) {
    // Date-only strings parse as UTC midnight per the ECMAScript spec.
    let ms = Date.parse(data.date);
    for (;;) {
      ms += 7 * 86400000;
      const next = new Date(ms).toISOString().slice(0, 10);
      if (next > data.repeat_until) break;
      series.push(next);
    }
  }
  // The 40-cap is on the pre-exclusion series: it bounds the date window being
  // reviewed, so excluding dates doesn't buy a longer window.
  if (series.length > 40) {
    throw new Error('Too many sessions (max 40) — pick an earlier end date');
  }
  // Exclusions only apply to a series; stray ones without repeat_until are ignored.
  const excluded = new Set(data.repeat_until ? data.excluded_dates ?? [] : []);
  const dates = series.filter((d) => !excluded.has(d));
  if (dates.length === 0) {
    throw new Error('All dates in the series are excluded');
  }

  const activeSeason = await adminClient.from('seasons').select('id').eq('active_flag', true).maybeSingle();
  // Refuse rather than stamp NULL — see requireActiveSeasonId. A row with no
  // season is invisible to every season total and there is no page that lists
  // the orphans. maybeSingle() so TWO active seasons surface as an error here
  // rather than as a silent "no active season".
  const seasonId = requireActiveSeasonId(activeSeason.data?.id, 'session');

  const rows = dates.map((date) => ({
    name: data.name,
    date,
    start_time: data.time ?? null,
    end_time: data.end_time ?? null,
    location: data.location,
    notes: data.notes || null,
    status: 'open',
    track: data.track,
    season_id: seasonId,
    host_player_id: admin.id,
  }));

  const { data: sessions, error } = await adminClient.from('sessions').insert(rows).select('id, date');

  if (error || !sessions?.[0]) throw new Error(error?.message ?? 'Failed to create sessions');

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: dates.length > 1 ? 'sessions_batch_created' : 'session_created',
    target_type: 'session',
    target_id: sessions[0].id,
    new_value: { ...data, count: dates.length, dates, excluded_dates: excluded.size > 0 ? [...excluded] : undefined },
  });

  revalidatePath('/sessions');
  return { sessions, count: dates.length };
}

// "PostgREST/Postgres has never heard of this column."
//
// The one failure a write of `require_scan_to_check_in` is allowed to shrug
// off, because migration 00116 is applied by hand and this console is
// routinely deployed ahead of it. Everything else is a real error and is
// rethrown — see the call site in updateSessionImpl.
//
// Local rather than exported: this file is 'use server' and may only export
// async functions, so a predicate declared here can be neither shared nor
// unit-tested directly — the same constraint that put requireReason in
// lib/audit-reason.
function isUnknownColumnError(error: { code?: string | null; message?: string | null }): boolean {
  if (error.code === 'PGRST204' || error.code === '42703') return true;
  // Backstop for a client that surfaces the message without a code.
  return (error.message ?? '').includes('require_scan_to_check_in');
}

// A typed reason on every audited session write.
//
// The console's rule is that every audited action carries one — ban, remove,
// restore, EDIT, approve — and `audit_logs` already has the column:
// logAdminAudit takes `reason`, and voidMatch, removePlayer and approvePlayer
// all fill it. The session writes did not, so the log recorded that a night's
// schedule changed and never why.
//
// Editing needs it as much as the destructive pair, for a different reason.
// Archiving silently ends check-in for everybody still walking through the door
// and deleting takes the attendance rows with it — loud, obvious harm. An edit
// is quiet: a date or a location moved, old_value and new_value dutifully
// recorded, and no way to tell a correction of a typo from a room change
// somebody needs to have been told about. The diff says what moved; only the
// reason says whether anyone should care.
//
// The floor itself is in lib/audit-reason — this file is 'use server' and may
// only export async functions, so a predicate declared here could be neither
// shared with another action nor unit-tested.
export async function updateSession(sessionId: string, data: {
  name: string;
  date: string;
  time?: string;
  end_time?: string;
  location: string;
  notes?: string;
  track: SessionGroupInput;
  require_scan_to_check_in?: boolean;
}, reason: string): Promise<ActionResult<void>> {
  return runAction(() => updateSessionImpl(sessionId, data, reason));
}

async function updateSessionImpl(sessionId: string, data: {
  name: string;
  date: string;
  time?: string;
  end_time?: string;
  location: string;
  notes?: string;
  track: SessionGroupInput;
  require_scan_to_check_in?: boolean;
}, reason: string) {
  const why = requireReason(reason, 'Editing a session');
  parseOrThrow(sessionGroupSchema, data.track);
  const admin = await requireCapability('sessions.update.write');
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

  // A SECOND, SEPARATE UPDATE, and it is separate on purpose.
  //
  // `require_scan_to_check_in` arrives with migration 00116, which the owner
  // applies by hand — so this console can be, and routinely is, deployed
  // against a database that does not have the column yet. Folded into the
  // update above, an unknown column would fail the WHOLE statement (PostgREST
  // answers PGRST204 out of its schema cache, or 42703 from Postgres itself,
  // and `if (error) throw` turns either into a red toast): every session edit
  // in the console would break — name, date, location and all — for a checkbox
  // nobody had touched. Isolated here, a pre-migration edit saves everything
  // else and the checkbox is silently a no-op until the SQL lands.
  //
  // The same reasoning as the deliberately-narrow select in the player app's
  // performCheckIn; this is the write-side half of it, which has no `select('*')`
  // to hide behind.
  let scanPolicyWritten = false;
  if (data.require_scan_to_check_in !== undefined) {
    const { error: scanError } = await adminClient
      .from('sessions')
      .update({ require_scan_to_check_in: data.require_scan_to_check_in })
      .eq('id', sessionId);
    // ONLY "the column is not there yet" is swallowed. Swallowing everything
    // would mean that after 00116 lands, a transient failure on this statement
    // still ends in a green "Session updated" — and the exec walks away
    // believing the night is strict when the database says it is not. That is
    // the same fiction this feature exists to prevent, arriving through the
    // console instead of through the app.
    //
    // PGRST204 is what PostgREST answers out of its schema cache for a column
    // it does not know ("Could not find the '…' column of 'sessions' in the
    // schema cache"); 42703 is Postgres's own undefined_column, which is what
    // arrives if the statement reaches the database instead. Both are the
    // pre-migration state of the world. The message test is a backstop for the
    // case where neither code is populated.
    if (scanError && !isUnknownColumnError(scanError)) throw new Error(scanError.message);
    scanPolicyWritten = !scanError;
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'session_updated',
    target_type: 'session',
    target_id: sessionId,
    old_value: old,
    // What was actually written, not what was asked for. If the column is not
    // there yet the audit row must not claim a policy change that never
    // happened — that log is the only record of who made a night strict.
    new_value: scanPolicyWritten
      ? data
      : { ...data, require_scan_to_check_in: undefined },
    reason: why,
  }, { sessionId });

  revalidatePath('/sessions');
}

export async function archiveSession(sessionId: string, reason: string): Promise<ActionResult<void>> {
  return runAction(() => archiveSessionImpl(sessionId, reason));
}

async function archiveSessionImpl(sessionId: string, reason: string) {
  const why = requireReason(reason, 'Archiving a session');
  const admin = await requireCapability('sessions.archive.write');
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
    reason: why,
  }, { sessionId });

  revalidatePath('/sessions');
}

// 24 random bytes -> 48 hex chars; the player app's /checkin/[token] page
// validates this exact shape (CHECKIN_TOKEN_REGEX).
function newCheckinToken(): string {
  return randomBytes(24).toString('hex');
}

// Returns the session's QR check-in token, creating one on first use.
// session_checkin_tokens has RLS enabled with no policies (00024), so every
// read and write goes through the service-role admin client.
export async function getOrCreateSessionCheckinToken(sessionId: string): Promise<ActionResult<string>> {
  return runAction(() => getOrCreateSessionCheckinTokenImpl(sessionId));
}

async function getOrCreateSessionCheckinTokenImpl(sessionId: string): Promise<string> {
  parseOrThrow(z.string().uuid(), sessionId);
  await requireCapability('sessions.checkin.token.write');
  const adminClient = createAdminClient();

  const { data: existing } = await adminClient
    .from('session_checkin_tokens')
    .select('token')
    .eq('session_id', sessionId)
    .maybeSingle();
  if (existing) return existing.token;

  const token = newCheckinToken();
  const { error } = await adminClient
    .from('session_checkin_tokens')
    .insert({ session_id: sessionId, token });
  if (error) {
    // Unique-violation race: a concurrent request created the row first —
    // return its token instead of failing.
    const { data: raced } = await adminClient
      .from('session_checkin_tokens')
      .select('token')
      .eq('session_id', sessionId)
      .maybeSingle();
    if (raced) return raced.token;
    throw new Error(error.message);
  }

  revalidatePath('/sessions');
  return token;
}

// Issues a fresh token, immediately invalidating every printed/photographed
// copy of the old QR. This is the club's answer to a forwarded code.
export async function rotateSessionCheckinToken(sessionId: string): Promise<ActionResult<string>> {
  return runAction(() => rotateSessionCheckinTokenImpl(sessionId));
}

async function rotateSessionCheckinTokenImpl(sessionId: string): Promise<string> {
  parseOrThrow(z.string().uuid(), sessionId);
  const admin = await requireCapability('sessions.checkin.token.write');
  const adminClient = createAdminClient();

  const token = newCheckinToken();
  const rotatedAt = new Date().toISOString();
  const { error } = await adminClient
    .from('session_checkin_tokens')
    .upsert({ session_id: sessionId, token, rotated_at: rotatedAt }, { onConflict: 'session_id' });
  if (error) throw new Error(error.message);

  // The token is deliberately not written to the audit row — it's a
  // credential, and audit_logs is readable by every admin.
  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'session_checkin_token_rotated',
    target_type: 'session',
    target_id: sessionId,
    new_value: { rotated_at: rotatedAt },
  }, { sessionId });

  revalidatePath('/sessions');
  return token;
}

export async function markAttendance(input: AttendanceMarkInput): Promise<ActionResult<void>> {
  return runAction(() => markAttendanceImpl(input));
}

async function markAttendanceImpl(input: AttendanceMarkInput) {
  const data = parseOrThrow(attendanceMarkSchema, input);
  const admin = await requireCapability('sessions.attendance.write');
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

export async function clearAttendanceMark(sessionId: string, playerId: string): Promise<ActionResult<void>> {
  return runAction(() => clearAttendanceMarkImpl(sessionId, playerId));
}

async function clearAttendanceMarkImpl(sessionId: string, playerId: string) {
  parseOrThrow(z.string().uuid(), sessionId);
  parseOrThrow(z.string().uuid(), playerId);
  const admin = await requireCapability('sessions.attendance.write');
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

export async function deleteSession(sessionId: string, reason: string): Promise<ActionResult<void>> {
  return runAction(() => deleteSessionImpl(sessionId, reason));
}

async function deleteSessionImpl(sessionId: string, reason: string) {
  const why = requireReason(reason, 'Deleting a session');
  const admin = await requireCapability('sessions.delete.write');
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
    reason: why,
  }, { sessionId });

  revalidatePath('/sessions');
}
