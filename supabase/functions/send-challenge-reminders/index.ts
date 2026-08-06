// Runs daily via cron
// Notifies players of challenges awaiting their response (accepted but unplayed, past agreed date)

import { requireCronSecret } from '../_shared/auth.ts';
import { createServiceClient, jsonResponse } from '../_shared/client.ts';
import { sendPushToPlayers } from '../_shared/push.ts';

Deno.serve(async (req) => {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const supabase = createServiceClient();

  // Find accepted challenges with a scheduled_date that has passed
  const { data: overdue, error } = await supabase
    .from('challenges')
    .select('id, created_by, scheduled_date, challenge_participants(player_id, role)')
    .eq('status', 'accepted')
    .lt('scheduled_date', new Date().toISOString().split('T')[0])
    .not('scheduled_date', 'is', null);

  if (error) {
    console.error('send-challenge-reminders error:', error);
    return jsonResponse({ error: error.message }, 500);
  }

  // Find pending challenges (proposed/partially_confirmed) expiring in next 12 hours
  const soon = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  const { data: expiringSoon } = await supabase
    .from('challenges')
    .select('id, created_by, expires_at, challenge_participants(player_id, confirmation_status)')
    .in('status', ['proposed', 'partially_confirmed'])
    .lt('expires_at', soon)
    .gt('expires_at', new Date().toISOString());

  let notifCount = 0;

  // Remind participants of overdue accepted challenges
  if (overdue && overdue.length > 0) {
    const typedOverdue = overdue as Array<{
      id: string;
      challenge_participants: Array<{ player_id: string; role: string }>;
    }>;
    const reminders = typedOverdue.flatMap((c) =>
      c.challenge_participants.map((cp) => ({
        player_id: cp.player_id,
        type: 'general',
        title: 'Unplayed Challenge',
        body: 'You have an accepted challenge that is past its scheduled date. Please play it or cancel.',
        metadata: { challenge_id: c.id },
      }))
    );
    if (reminders.length > 0) {
      await supabase.from('notifications').insert(reminders);
      notifCount += reminders.length;

      for (const c of typedOverdue) {
        await sendPushToPlayers(
          supabase,
          c.challenge_participants.map((cp) => cp.player_id),
          {
            title: 'Unplayed Challenge',
            body: 'You have an accepted challenge that is past its scheduled date. Please play it or cancel.',
            url: `/challenges/${c.id}`,
          },
          'challenges'
        );
      }
    }
  }

  // Remind pending participants of challenges expiring soon
  if (expiringSoon && expiringSoon.length > 0) {
    const typedExpiring = expiringSoon as Array<{
      id: string;
      challenge_participants: Array<{ player_id: string; confirmation_status: string }>;
    }>;
    const urgentReminders = typedExpiring.flatMap((c) =>
      c.challenge_participants
        .filter((cp) => cp.confirmation_status === 'pending')
        .map((cp) => ({
          player_id: cp.player_id,
          type: 'challenge_received',
          title: 'Challenge Expiring Soon',
          body: 'A challenge awaiting your response expires in less than 12 hours.',
          metadata: { challenge_id: c.id },
        }))
    );
    if (urgentReminders.length > 0) {
      await supabase.from('notifications').insert(urgentReminders);
      notifCount += urgentReminders.length;

      for (const c of typedExpiring) {
        const pendingIds = c.challenge_participants
          .filter((cp) => cp.confirmation_status === 'pending')
          .map((cp) => cp.player_id);
        await sendPushToPlayers(supabase, pendingIds, {
          title: 'Challenge Expiring Soon',
          body: 'A challenge awaiting your response expires in less than 12 hours.',
          url: `/challenges/${c.id}`,
        }, 'challenges');
      }
    }
  }

  console.log(`Sent ${notifCount} challenge reminders`);
  return jsonResponse({ notifications_sent: notifCount });
});
