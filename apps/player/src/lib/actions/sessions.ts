'use server';

import { revalidatePath } from 'next/cache';
import { CLUB_TIMEZONE, formatTime, getCheckinWindow, isCheckinOpen } from '@badminton/shared';
import { createServerSupabaseClient } from '../supabase-server';
import { requirePlayer, getPlayerProps, trackServerEvent } from './_shared';

export async function checkInToSession(sessionId: string) {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  const { data: session } = await supabase
    .from('sessions')
    .select('date, start_time, end_time, status')
    .eq('id', sessionId)
    .single();

  if (!session || session.status !== 'open') throw new Error('This session is closed');

  const now = new Date();
  if (!isCheckinOpen(session, now)) {
    const { opensAt } = getCheckinWindow(session);
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
    if (error.code === '23505') throw new Error('Already checked in');
    // RLS backstop: session_checkin_open() rejected the insert.
    if (error.code === '42501') throw new Error('Check-in is not open for this session');
    throw new Error(error.message);
  }

  await supabase.from('players').update({ last_active_at: new Date().toISOString() }).eq('id', player.id);

  trackServerEvent(player.id, 'session_checked_in', { ...getPlayerProps(player), session_id: sessionId });
  revalidatePath('/sessions');
  revalidatePath(`/sessions/${sessionId}`);
}
