import 'server-only';
import { createAdminClient } from './supabase-server';
import { logAdminAudit } from './audit';
import { notifyPlayers } from './notify';
import { formatDate, formatTime } from '@badminton/shared';

// The reminder itself, with no opinion about who asked for it. Two callers need
// it and they authenticate completely differently: the admin "Send reminder"
// menu item (an exec/admin session) and the scheduled job (a shared secret, no
// session at all). Keeping the auth check in the callers lets the cron route
// reuse this without pretending to be a logged-in admin.
export async function remindSessionGoers(
  sessionId: string,
  actorId: string | null,
): Promise<{ notified: number }> {
  const adminClient = createAdminClient();

  const { data: session, error: sErr } = await adminClient
    .from('sessions')
    .select('id, name, date, start_time, location')
    .eq('id', sessionId)
    .single();
  if (sErr || !session) throw new Error(sErr?.message ?? 'Session not found');

  const { data: rsvps, error: rErr } = await adminClient
    .from('session_rsvp')
    .select('player_id')
    .eq('session_id', sessionId)
    .eq('intent', 'going');
  if (rErr) throw new Error(rErr.message);

  const playerIds = (rsvps ?? []).map((r) => r.player_id);
  if (playerIds.length === 0) return { notified: 0 };

  const label = session.name?.trim() || 'Session';
  const when = `${formatDate(session.date)}${session.start_time ? ` · ${formatTime(session.start_time)}` : ''}`;
  const body = `${label} at ${session.location} · ${when}`;

  await notifyPlayers(
    adminClient,
    playerIds,
    {
      type: 'session_reminder',
      title: 'Session reminder',
      body,
      metadata: { session_id: sessionId, kind: 'session_reminder' },
    },
    { title: 'Session reminder', body, url: '/sessions' },
    'sessions',
  );

  await logAdminAudit(adminClient, {
    // Null actor = the scheduled job rather than a person.
    actor_id: actorId,
    action_type: 'session_reminders_sent',
    target_type: 'session',
    target_id: sessionId,
    new_value: { notified: playerIds.length, automatic: actorId === null },
  });

  return { notified: playerIds.length };
}
