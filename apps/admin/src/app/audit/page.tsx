export const dynamic = 'force-dynamic';
import { createAdminClient } from '@/lib/supabase-server';
import { PageHero } from '@badminton/ui';
import { AuditLogClient, type AuditEntry } from './audit-log-client';

export default async function AuditPage() {
  const supabase = createAdminClient();

  const { data: logs } = await supabase
    .from('audit_logs')
    .select('id, action_type, target_type, target_id, reason, created_at, actor:players!audit_logs_actor_id_fkey(full_name, role)')
    .order('created_at', { ascending: false })
    .limit(200);

  const entries: AuditEntry[] = (logs ?? []).map((log) => {
    const actor = Array.isArray(log.actor) ? log.actor[0] : (log.actor as { full_name: string; role: string } | null);
    return {
      id: log.id as string,
      action_type: log.action_type as string,
      target_type: (log.target_type as string) ?? '',
      target_id: (log.target_id as string | null) ?? null,
      reason: (log.reason as string | null) ?? null,
      created_at: log.created_at as string,
      actor_name: actor?.full_name ?? 'System',
      actor_role: actor?.role ?? '',
    };
  });

  const counts = {
    all: entries.length,
    players: entries.filter((e) => e.target_type === 'player').length,
    matches: entries.filter((e) => e.target_type === 'match').length,
    disputes: entries.filter((e) => e.target_type === 'dispute').length,
    sessions: entries.filter((e) => e.target_type === 'session').length,
    settings: entries.filter((e) => e.target_type === 'platform_setting' || e.target_type === 'setting').length,
  };

  return (
    <div>
      <PageHero
        eyebrow="Last 30 days"
        title="Audit Log."
        subtitle="Every administrative action, surfaced and timestamped. This log is append-only and exportable."
        watermark="A"
      />
      <AuditLogClient entries={entries} counts={counts} />
    </div>
  );
}
