// Runs hourly via cron
// Auto-expires challenges past 72 hours with status 'proposed' or 'partially_confirmed'

import { requireCronSecret } from '../_shared/auth.ts';
import { createServiceClient, jsonResponse } from '../_shared/client.ts';

Deno.serve(async (req) => {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const supabase = createServiceClient();

  const { data: expired, error } = await supabase
    .from('challenges')
    .update({ status: 'expired', updated_at: new Date().toISOString() })
    .in('status', ['proposed', 'partially_confirmed'])
    .lt('expires_at', new Date().toISOString())
    .select('id, created_by');

  if (error) {
    console.error('expire-challenges error:', error);
    return jsonResponse({ error: error.message }, 500);
  }

  // Notify creators of expired challenges
  if (expired && expired.length > 0) {
    const notifications = expired.map((c: { id: string; created_by: string }) => ({
      player_id: c.created_by,
      type: 'challenge_expired',
      title: 'Challenge Expired',
      body: 'Your challenge expired without a response.',
      metadata: { challenge_id: c.id },
    }));

    await supabase.from('notifications').insert(notifications);

    // Increment challenges_expired in reliability_metrics
    for (const c of expired) {
      const { data: current } = await supabase
        .from('reliability_metrics')
        .select('challenges_expired')
        .eq('player_id', c.created_by)
        .single();

      if (current) {
        await supabase
          .from('reliability_metrics')
          .update({
            challenges_expired: (current.challenges_expired ?? 0) + 1,
            updated_at: new Date().toISOString(),
          })
          .eq('player_id', c.created_by);
      }
    }
  }

  console.log(`Expired ${expired?.length ?? 0} challenges`);
  return jsonResponse({ expired: expired?.length ?? 0 });
});
