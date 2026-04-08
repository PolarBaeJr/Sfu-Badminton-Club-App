// Runs daily via cron
// Marks players inactive after 45 days without a rated match or session check-in

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (_req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // Get threshold from platform_settings
  const { data: setting } = await supabase
    .from('platform_settings')
    .select('value')
    .eq('key', 'inactivity_rules')
    .single();

  const thresholdDays: number = (setting?.value as Record<string, number>)?.inactive_threshold_days ?? 45;
  const cutoff = new Date(Date.now() - thresholdDays * 24 * 60 * 60 * 1000).toISOString();

  // Find active players whose last_active_at is past the threshold
  const { data: toMark, error } = await supabase
    .from('players')
    .update({ active_flag: false, updated_at: new Date().toISOString() })
    .in('status', ['competitive', 'recreational'])
    .eq('active_flag', true)
    .lt('last_active_at', cutoff)
    .select('id, full_name');

  if (error) {
    console.error('mark-inactive-players error:', error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  // Log to audit
  if (toMark && toMark.length > 0) {
    const auditEntries = (toMark as Array<{ id: string; full_name: string }>).map((p) => ({
      actor_id: null,
      action_type: 'auto_marked_inactive',
      target_type: 'player',
      target_id: p.id,
      old_value: { active_flag: true },
      new_value: { active_flag: false },
      reason: `No activity for ${thresholdDays} days`,
    }));
    await supabase.from('audit_logs').insert(auditEntries);
  }

  console.log(`Marked ${toMark?.length ?? 0} players inactive`);
  return new Response(JSON.stringify({ marked_inactive: toMark?.length ?? 0 }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
