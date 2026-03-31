// Runs daily via cron
// Alerts admins about match results awaiting confirmation for 48+ hours

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (_req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  // Find matches pending confirmation older than 48h
  const { data: stale, error } = await supabase
    .from('matches')
    .select('id, challenge_id, format, created_at')
    .eq('result_status', 'pending_confirmation')
    .lt('created_at', cutoff);

  if (error) {
    console.error('send-stale-confirmation-alerts error:', error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
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
          body: `${m.format} match awaiting confirmation for 48+ hours.`,
          metadata: { match_id: m.id },
        }))
      );
      await supabase.from('notifications').insert(alerts);
    }
  }

  console.log(`Found ${stale?.length ?? 0} stale match confirmations`);
  return new Response(JSON.stringify({ stale: stale?.length ?? 0 }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
