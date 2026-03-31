// Runs daily via cron
// Notifies players of upcoming sessions they are registered to attend

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (_req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // Find sessions scheduled for tomorrow
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowDate = tomorrow.toISOString().split('T')[0];

  const { data: sessions, error } = await supabase
    .from('sessions')
    .select('id, name, date, location, session_attendance(player_id)')
    .eq('status', 'open')
    .eq('date', tomorrowDate);

  if (error) {
    console.error('send-session-reminders error:', error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  let notifCount = 0;

  if (sessions && sessions.length > 0) {
    const reminders = (sessions as Array<{
      id: string;
      name: string | null;
      date: string;
      location: string;
      session_attendance: Array<{ player_id: string }>;
    }>).flatMap((s) =>
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
    }
  }

  console.log(`Sent ${notifCount} session reminders`);
  return new Response(JSON.stringify({ notifications_sent: notifCount }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
