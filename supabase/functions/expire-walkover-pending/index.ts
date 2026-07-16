// Runs hourly via cron
// Auto-escalates walkover reports unreviewed past 48 hours to admin alert

import { requireCronSecret } from '../_shared/auth.ts';
import { createServiceClient, jsonResponse } from '../_shared/client.ts';
import { WALKOVER_REVIEW_HOURS } from '../_shared/constants.ts';

Deno.serve(async (req) => {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const supabase = createServiceClient();

  const cutoff = new Date(Date.now() - WALKOVER_REVIEW_HOURS * 60 * 60 * 1000).toISOString();

  // Find pending walkovers older than the review window
  const { data: stale, error } = await supabase
    .from('walkovers')
    .select('id, challenge_id, forfeit_player_id, walkover_type, reported_at')
    .eq('status', 'pending')
    .lt('reported_at', cutoff);

  if (error) {
    console.error('expire-walkover-pending error:', error);
    return jsonResponse({ error: error.message }, 500);
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
          body: `Walkover report unreviewed for ${WALKOVER_REVIEW_HOURS}+ hours. Type: ${w.walkover_type}`,
          metadata: { walkover_id: w.id },
        }))
      );
      await supabase.from('notifications').insert(alerts);
    }
  }

  console.log(`Found ${stale?.length ?? 0} stale walkover reports`);
  return jsonResponse({ stale: stale?.length ?? 0 });
});
