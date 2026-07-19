// Runs daily via cron
// Notifies players of upcoming sessions they are registered to attend

import { requireCronSecret } from '../_shared/auth.ts';
import { createServiceClient, jsonResponse } from '../_shared/client.ts';
import { sendPushToPlayers } from '../_shared/push.ts';

Deno.serve(async (req) => {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const supabase = createServiceClient();

  // Find sessions scheduled for tomorrow
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowDate = tomorrow.toISOString().split('T')[0];

  const { data: sessions, error } = await supabase
    .from('sessions')
    .select('id, name, date, location, session_attendance(player_id, status)')
    .eq('status', 'open')
    .eq('date', tomorrowDate);

  if (error) {
    console.error('send-session-reminders error:', error);
    return jsonResponse({ error: error.message }, 500);
  }

  let notifCount = 0;

  if (sessions && sessions.length > 0) {
    const rawSessions = sessions as Array<{
      id: string;
      name: string | null;
      date: string;
      location: string;
      session_attendance: Array<{ player_id: string; status: string }>;
    }>;
    // Don't remind players an admin already marked as not coming.
    const typedSessions = rawSessions.map((s) => ({
      ...s,
      session_attendance: s.session_attendance.filter(
        (a) => a.status !== 'no_show' && a.status !== 'excused'
      ),
    }));
    const reminders = typedSessions.flatMap((s) =>
      s.session_attendance.map((a) => ({
        player_id: a.player_id,
        type: 'session_reminder',
        title: 'Session Tomorrow',
        body: `${s.name || 'Session'} at ${s.location} is tomorrow (${s.date}).`,
        metadata: { session_id: s.id },
      }))
    );

    if (reminders.length > 0) {
      await supabase.from('notifications').insert(reminders);
      notifCount = reminders.length;

      for (const s of typedSessions) {
        await sendPushToPlayers(
          supabase,
          s.session_attendance.map((a) => a.player_id),
          {
            title: 'Session Tomorrow',
            body: `${s.name || 'Session'} at ${s.location} is tomorrow (${s.date}).`,
            url: '/sessions',
          }
        );
      }
    }
  }

  console.log(`Sent ${notifCount} session reminders`);
  return jsonResponse({ notifications_sent: notifCount });
});
