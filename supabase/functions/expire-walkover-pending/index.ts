// Runs hourly via cron
// Auto-escalates walkover reports unreviewed past 48 hours to admin alert

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (_req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  // Find pending walkovers older than 48h
  const { data: stale, error } = await supabase
    .from('walkovers')
    .select('id, challenge_id, forfeit_player_id, walkover_type, reported_at')
    .eq('status', 'pending')
    .lt('reported_at', cutoff);

  if (error) {
    console.error('expire-walkover-pending error:', error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  if (stale && stale.length > 0) {
    // Get all admin players
    const { data: admins } = await supabase
      .from('players')
      .select('id')
      .eq('role', 'admin');

    if (admins && admins.length > 0) {
      const alerts = admins.flatMap((admin: { id: string }) =>
        (stale as Array<{ id: string; forfeit_player_id: string; walkover_type: string }>).map((w) => ({
          player_id: admin.id,
          type: 'admin_alert',
          title: 'Stale Walkover Report',
          body: `Walkover report unreviewed for 48+ hours. Type: ${w.walkover_type}`,
          metadata: { walkover_id: w.id },
        }))
      );
      await supabase.from('notifications').insert(alerts);
    }
  }

  console.log(`Found ${stale?.length ?? 0} stale walkover reports`);
  return new Response(JSON.stringify({ stale: stale?.length ?? 0 }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
