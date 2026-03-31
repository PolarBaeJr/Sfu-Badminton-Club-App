// Runs hourly via cron
// Auto-expires challenges past 72 hours with status 'proposed' or 'partially_confirmed'

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (_req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const { data: expired, error } = await supabase
    .from('challenges')
    .update({ status: 'expired', updated_at: new Date().toISOString() })
    .in('status', ['proposed', 'partially_confirmed'])
    .lt('expires_at', new Date().toISOString())
    .select('id, created_by');

  if (error) {
    console.error('expire-challenges error:', error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
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
  return new Response(JSON.stringify({ expired: expired?.length ?? 0 }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
