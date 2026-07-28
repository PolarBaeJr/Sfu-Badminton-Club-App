'use server';

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import { CHECKIN_TOKEN_REGEX, CLUB_TIMEZONE, formatTime, getCheckinWindow, isCheckinOpen } from '@badminton/shared';
import { createServerSupabaseClient, createServiceRoleClient } from '../supabase-server';
import { getCheckinSettings } from '../checkin-settings';
import { requirePlayer, getPlayerProps, trackServerEvent, assertCurrentWaiver, runAction, type ActionResult } from './_shared';

// Wrapped so its validation messages ("Already checked in", "Check-in opens at
// 6:00 PM", etc.) survive to the client — Next.js redacts thrown Server Action
// errors in production.
export async function checkInToSession(sessionId: string): Promise<ActionResult> {
  return runAction(() => checkInToSessionImpl(sessionId));
}

async function checkInToSessionImpl(sessionId: string) {
  const player = await requirePlayer();
  // The button flow treats a duplicate as an error; the QR flow doesn't.
  const { alreadyCheckedIn } = await performCheckIn(player, sessionId);
  if (alreadyCheckedIn) throw new Error('Already checked in');
}

// The one place a player checks themselves in. `player` is always the caller's
// own requirePlayer() row — never anything a caller supplied — so every entry
// point (button, QR) inherits the same identity, waiver and window gates.
async function performCheckIn(
  player: Awaited<ReturnType<typeof requirePlayer>>,
  sessionId: string
): Promise<{ alreadyCheckedIn: boolean }> {
  const supabase = await createServerSupabaseClient();
  await assertCurrentWaiver(supabase, player);

  const { data: session } = await supabase
    .from('sessions')
    .select('date, start_time, end_time, status')
    .eq('id', sessionId)
    .single();

  if (!session || session.status !== 'open') throw new Error('This session is closed');

  // Read the live window tunables rather than the fallback constants, so the
  // message shown here matches what session_checkin_open() will actually allow.
  const checkinSettings = await getCheckinSettings();

  const now = new Date();
  if (!isCheckinOpen(session, now, checkinSettings)) {
    const { opensAt } = getCheckinWindow(session, checkinSettings);
    if (opensAt && now < opensAt) {
      // Club-local HH:MM of the opening instant, rendered like session times.
      const opensLocal = opensAt.toLocaleTimeString('en-GB', {
        timeZone: CLUB_TIMEZONE,
        hourCycle: 'h23',
        hour: '2-digit',
        minute: '2-digit',
      });
      throw new Error(`Check-in opens at ${formatTime(opensLocal)}`);
    }
    throw new Error('Check-in for this session has ended');
  }

  const { error } = await supabase.from('session_attendance').insert({
    session_id: sessionId,
    player_id: player.id,
  });

  if (error) {
    // Idempotent: they're already on the list. Return before the activity
    // ping / analytics event so a re-check-in isn't counted twice.
    if (error.code === '23505') return { alreadyCheckedIn: true };
    // RLS backstop: session_checkin_open() rejected the insert.
    if (error.code === '42501') throw new Error('Check-in is not open for this session');
    Sentry.captureException(error, { extra: { action: 'checkInToSession', sessionId } });
    throw new Error(error.message);
  }

  await supabase.from('players').update({ last_active_at: new Date().toISOString() }).eq('id', player.id);

  trackServerEvent(player.id, 'session_checked_in', { ...getPlayerProps(player), session_id: sessionId });
  revalidatePath('/sessions');
  revalidatePath(`/sessions/${sessionId}`);
  return { alreadyCheckedIn: false };
}

// QR flow: the admin displays one code per session, the player scans it with
// their phone camera and lands on /checkin/[token]. The token is a gate that
// resolves to a session_id — it never carries an identity, so this is exactly
// checkInToSession with a lookup in front.
//
// Every miss returns the SAME message: distinguishing "malformed" from
// "unknown" would turn this into an oracle for enumerating live tokens.
export async function checkInWithToken(
  token: string
): Promise<ActionResult<{ sessionId: string; alreadyCheckedIn: boolean }>> {
  return runAction(() => checkInWithTokenImpl(token));
}

async function checkInWithTokenImpl(token: string) {
  // Identity first, before the token table is touched at all. The page-level
  // rate limit doesn't cover someone calling this action directly, and if the
  // lookup ran first a logged-out caller could tell a real token ('Not
  // authenticated') from an unknown one ('Invalid check-in code') — exactly the
  // enumeration oracle the uniform message exists to prevent.
  const player = await requirePlayer();

  if (!CHECKIN_TOKEN_REGEX.test(token)) throw new Error('Invalid check-in code');

  // session_checkin_tokens has RLS on with no policies (00024) — only the
  // service-role client can resolve a token.
  const serviceClient = createServiceRoleClient();
  const { data: tokenRow } = await serviceClient
    .from('session_checkin_tokens')
    .select('session_id')
    .eq('token', token)
    .maybeSingle();
  if (!tokenRow) throw new Error('Invalid check-in code');

  const sessionId = tokenRow.session_id as string;
  const { alreadyCheckedIn } = await performCheckIn(player, sessionId);
  return { sessionId, alreadyCheckedIn };
}

export async function setSessionIntent(
  sessionId: string,
  intent: 'going' | 'declined' | null
): Promise<ActionResult> {
  return runAction(() => setSessionIntentImpl(sessionId, intent));
}

async function setSessionIntentImpl(
  sessionId: string,
  intent: 'going' | 'declined' | null
) {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();
  await assertCurrentWaiver(supabase, player);

  const { data: session } = await supabase
    .from('sessions').select('status').eq('id', sessionId).single();
  if (!session || session.status !== 'open') throw new Error('This session is closed');

  if (intent === null) {
    const { error } = await supabase
      .from('session_rsvp').delete()
      .eq('session_id', sessionId).eq('player_id', player.id);
    if (error) {
      Sentry.captureException(error, { extra: { action: 'setSessionIntent', sessionId, intent } });
      throw new Error(error.message);
    }
  } else {
    const { error } = await supabase
      .from('session_rsvp')
      .upsert(
        { session_id: sessionId, player_id: player.id, intent, updated_at: new Date().toISOString() },
        { onConflict: 'session_id,player_id' }
      );
    if (error) {
      if (error.code === '42501') throw new Error('RSVP is not open for this session');
      Sentry.captureException(error, { extra: { action: 'setSessionIntent', sessionId, intent } });
      throw new Error(error.message);
    }
  }

  trackServerEvent(player.id, 'session_rsvp', { ...getPlayerProps(player), session_id: sessionId, intent });
  revalidatePath('/sessions');
}
