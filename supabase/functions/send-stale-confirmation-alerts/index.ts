// Runs daily via cron
// Alerts admins about match results awaiting confirmation for 48+ hours

import { requireCronSecret } from '../_shared/auth.ts';
import { createServiceClient, jsonResponse } from '../_shared/client.ts';
import { WALKOVER_REVIEW_HOURS } from '../_shared/constants.ts';

Deno.serve(async (req) => {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const supabase = createServiceClient();

  // Match confirmations intentionally share the walkover 48h review window.
  const cutoff = new Date(Date.now() - WALKOVER_REVIEW_HOURS * 60 * 60 * 1000).toISOString();

  // Find matches pending confirmation older than the review window
  const { data: stale, error } = await supabase
    .from('matches')
    .select('id, challenge_id, format, created_at')
    .eq('result_status', 'pending_confirmation')
    .lt('created_at', cutoff);

  if (error) {
    console.error('send-stale-confirmation-alerts error:', error);
    return jsonResponse({ error: error.message }, 500);
  }

  if (stale && stale.length > 0) {
    const { data: admins } = await supabase
      .from('players')
      .select('id')
      .eq('role', 'admin');

    if (admins && admins.length > 0) {
      const alerts = admins.flatMap((admin: { id: string }) =>
        (stale as Array<{ id: string; format: string }>).map((m) => ({
          player_id: admin.id,
          type: 'admin_alert',
          title: 'Stale Match Confirmation',
          body: `${m.format} match awaiting confirmation for ${WALKOVER_REVIEW_HOURS}+ hours.`,
          metadata: { match_id: m.id },
        }))
      );
      await supabase.from('notifications').insert(alerts);
    }
  }

  console.log(`Found ${stale?.length ?? 0} stale match confirmations`);
  return jsonResponse({ stale: stale?.length ?? 0 });
});
