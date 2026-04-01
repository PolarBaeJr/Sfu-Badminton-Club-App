export const dynamic = 'force-dynamic';
import { createAdminClient } from '@/lib/supabase-server';
import { Card, Badge } from '@badminton/ui';
import { formatDateTime } from '@badminton/shared';
import { ScrollText, User, Inbox } from 'lucide-react';

const actionCategory = (action: string): 'success' | 'danger' | 'warning' | 'info' | 'neutral' => {
  if (action.includes('created') || action.includes('added')) return 'success';
  if (action.includes('voided') || action.includes('removed') || action.includes('rejected')) return 'danger';
  if (action.includes('expired') || action.includes('ended') || action.includes('closed')) return 'warning';
  if (action.includes('updated') || action.includes('changed') || action.includes('converted')) return 'info';
  return 'neutral';
};

export default async function AuditPage() {
  const supabase = createAdminClient();

  const { data: logs } = await supabase
    .from('audit_logs')
    .select('*, actor:players!audit_logs_actor_id_fkey(full_name)')
    .order('created_at', { ascending: false })
    .limit(100);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-[var(--color-accent)]/10">
          <ScrollText className="w-5 h-5 text-[var(--color-accent)]" />
        </div>
        <div>
          <h1 className="text-3xl font-bold font-display text-[var(--text-primary)]">AUDIT LOG</h1>
          <p className="text-sm text-[var(--text-muted)]">Track all administrative actions</p>
        </div>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b-2 border-[var(--border)]">
                <th className="px-5 py-4 text-left text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Time</th>
                <th className="px-5 py-4 text-left text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Actor</th>
                <th className="px-5 py-4 text-left text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Action</th>
                <th className="px-5 py-4 text-left text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Target</th>
                <th className="px-5 py-4 text-left text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {logs?.map((log) => (
                <tr key={log.id} className="hover:bg-white/[0.03] transition-colors">
                  <td className="px-5 py-3.5 text-sm text-[var(--text-muted)] whitespace-nowrap font-mono text-xs">
                    {formatDateTime(log.created_at)}
                  </td>
                  <td className="px-5 py-3.5 text-sm text-[var(--text-primary)]">
                    <div className="flex items-center gap-2">
                      <User className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                      {(log.actor as Record<string, unknown>)?.full_name as string || <span className="text-[var(--text-muted)] italic">System</span>}
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <Badge variant={actionCategory(log.action_type)}>{log.action_type.replace(/_/g, ' ')}</Badge>
                  </td>
                  <td className="px-5 py-3.5 text-sm text-[var(--text-secondary)]">
                    <span className="capitalize">{log.target_type}</span>
                    {log.target_id && (
                      <span className="text-xs text-[var(--text-muted)] font-mono ml-1.5 bg-[var(--border-hover)] px-1.5 py-0.5 rounded">
                        {String(log.target_id).slice(0, 8)}
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3.5 text-sm text-[var(--text-muted)] max-w-xs truncate">
                    {log.reason || <span className="opacity-40">-</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(!logs || logs.length === 0) && (
          <div className="flex flex-col items-center py-12 gap-3">
            <div className="w-14 h-14 rounded-full bg-[var(--border-hover)] flex items-center justify-center">
              <Inbox className="w-7 h-7 text-[var(--text-muted)]" />
            </div>
            <p className="text-[var(--text-muted)]">No audit entries yet</p>
          </div>
        )}
      </div>
    </div>
  );
}
