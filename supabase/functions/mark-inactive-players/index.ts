// Runs daily via cron
// Marks players inactive after 45 days without a rated match or session check-in

import { requireCronSecret } from '../_shared/auth.ts';
import { createServiceClient, jsonResponse } from '../_shared/client.ts';
import { INACTIVITY_DAYS } from '../_shared/constants.ts';

Deno.serve(async (req) => {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const supabase = createServiceClient();

  // Get threshold from platform_settings
  const { data: setting } = await supabase
    .from('platform_settings')
    .select('value')
    .eq('key', 'inactivity_rules')
    .single();

  const thresholdDays: number = (setting?.value as Record<string, number>)?.inactive_threshold_days ?? INACTIVITY_DAYS;
  const cutoff = new Date(Date.now() - thresholdDays * 24 * 60 * 60 * 1000).toISOString();

  // Find active players whose last_active_at is past the threshold.
  //
  // Admins and execs are exempt. Since migration 00057 the admin console
  // requires good standing, and admin_access_level() counts a cleared
  // active_flag as bad standing — so this job, which measures attendance,
  // silently revoked console access. An exec or admin runs the club and may
  // legitimately not play for a whole term; taking the console off them on an
  // attendance metric is a failure, and one nobody would connect to a nightly
  // cron.
  //
  // Varsity trainers are NOT exempt, on purpose. A trainer's console access is
  // scoped to reading the roster and writing notes; if they have gone inactive
  // as a member, letting that lapse is the correct outcome and an exec undoes
  // it by setting them active again.
  //
  // role and is_exec are both NOT NULL with defaults (00001_schema), so these
  // filters have no NULL hole to fall through.
  const { data: toMark, error } = await supabase
    .from('players')
    .update({ active_flag: false, updated_at: new Date().toISOString() })
    .in('status', ['competitive', 'recreational'])
    .eq('active_flag', true)
    .lt('last_active_at', cutoff)
    .neq('role', 'admin')
    .eq('is_exec', false)
    .select('id, full_name');

  if (error) {
    console.error('mark-inactive-players error:', error);
    return jsonResponse({ error: error.message }, 500);
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
  return jsonResponse({ marked_inactive: toMark?.length ?? 0 });
});
