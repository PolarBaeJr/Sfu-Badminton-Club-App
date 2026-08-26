'use server';

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import { CHECKIN_TOKEN_REGEX, CLUB_TIMEZONE, ExpectedError, formatTime, getCheckinWindow, isCheckinOpen } from '@badminton/shared';
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
  await assertScanNotRequired(sessionId);
  // The button flow treats a duplicate as an error; the QR flow doesn't.
  const { alreadyCheckedIn } = await performCheckIn(player, sessionId);
  if (alreadyCheckedIn) throw new ExpectedError('Already checked in');
}

// The server half of the per-session scan policy.
//
// Hiding the buttons is not enforcement: this action is reachable by anyone who
// can post to it, and "the exec set this night to require the door code" is a
// rule about attendance, not about which controls happen to be on screen. So it
// is asserted HERE, on the tokenless path, and pointedly NOT inside
// performCheckIn — the token flow is the way in that the policy exists to
// require, and gating it there would close the only door it leaves open.
//
// ITS OWN QUERY, AND ITS OWN ERROR HANDLING, for the reason spelled out over
// the select in performCheckIn: migrations here are applied by hand, so the app
// can be deployed against a database that has never heard of this column.
// Naming an unknown column is a 42703 that would arrive as `session == null`
// and turn into "This session is closed" for every member in the club. Folded
// into the select below, one missing column would break check-in outright;
// isolated here, a failure of any kind means the policy is unknown, and unknown
// resolves to the permissive answer that has always been in force.
async function assertScanNotRequired(sessionId: string) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from('sessions')
    .select('require_scan_to_check_in')
    .eq('id', sessionId)
    .maybeSingle();
  // No throw, no Sentry: before 00116 lands this errors on every single call,
  // and that is an expected state of the world rather than an incident.
  if (error || !data) return;
  if (data.require_scan_to_check_in === true) {
    throw new ExpectedError(
      'This session needs the check-in code on the door — scan it to check in.',
    );
  }
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
    // Deliberately NOT selecting starts_at/ends_at (00110), even though this is
    // the call site closest to the gate. Naming a column PostgREST does not
    // know yet is a 42703, which arrives here as `session == null` and turns
    // into "This session is closed" for every member in the club — and the
    // migration is applied by hand, so the app can be deployed first. The
    // wall-clock path below reaches the same answer: getCheckinWindow uses the
    // same pinned resolver the database does. The sessions LIST pages select
    // '*' and so pick the instants up automatically once they exist, with no
    // such hazard.
    .select('date, start_time, end_time, status')
    .eq('id', sessionId)
    .single();

  if (!session || session.status !== 'open') throw new ExpectedError('This session is closed');

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
      throw new ExpectedError(`Check-in opens at ${formatTime(opensLocal)}`);
    }
    throw new ExpectedError('Check-in for this session has ended');
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
  // Identity first, before the token table is touched at all. The edge rate
  // limit on /checkin does not cover someone calling this action directly
  // (a server action posts to the page it was rendered from, but a scripted
  // caller need not go near /checkin at all), and if the
  // lookup ran first a logged-out caller could tell a real token ('Not
  // authenticated') from an unknown one ('Invalid check-in code') — exactly the
  // enumeration oracle the uniform message exists to prevent.
  const player = await requirePlayer();

  if (!CHECKIN_TOKEN_REGEX.test(token)) throw new ExpectedError('Invalid check-in code');

  // session_checkin_tokens has RLS on with no policies (00024) — only the
  // service-role client can resolve a token.
  const serviceClient = createServiceRoleClient();
  const { data: tokenRow } = await serviceClient
    .from('session_checkin_tokens')
    .select('session_id')
    .eq('token', token)
    .maybeSingle();
  if (!tokenRow) throw new ExpectedError('Invalid check-in code');

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
  if (!session || session.status !== 'open') throw new ExpectedError('This session is closed');

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
