export const dynamic = 'force-dynamic';
import { createAdminClient } from '@/lib/supabase-server';
import { Card, Badge, PageHeader } from '@badminton/ui';
import { formatRelativeTime } from '@badminton/shared';
import { WalkoverActions } from './actions';
import { Clock, User, AlertTriangle, MessageSquare, CheckCircle2 } from 'lucide-react';

export default async function WalkoversPage() {
  const supabase = createAdminClient();

  const { data: walkovers } = await supabase
    .from('walkovers')
    .select('*, reporter:players!walkovers_reported_by_fkey(full_name), forfeit:players!walkovers_forfeit_player_id_fkey(full_name), challenge:challenges(type, format)')
    .order('created_at', { ascending: false });

  const pendingCount = walkovers?.filter((w) => w.status === 'pending').length ?? 0;

  const borderColor = (status: string) => {
    if (status === 'pending') return 'border-l-[var(--color-warning)]';
    if (status === 'confirmed') return 'border-l-[var(--color-success)]';
    return 'border-l-[var(--color-danger)]';
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <PageHeader
        title="Walkovers"
        watermark="W"
        sub={
          <>
            Review and manage walkover reports
            {pendingCount > 0 && (
              <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 bg-[var(--color-warning)] text-black text-xs font-semibold">
                {pendingCount} pending
              </span>
            )}
          </>
        }
      />

      {/* Walkover Cards */}
      <div className="grid gap-4">
        {walkovers?.map((w) => (
          <div key={w.id} className={`rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-5 border-l-4 ${borderColor(w.status)}`}>
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col gap-2.5 flex-1">
                {/* Status and Type Badges */}
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant={w.status === 'pending' ? 'warning' : w.status === 'confirmed' ? 'success' : 'danger'}>
                    {w.status === 'confirmed' && <CheckCircle2 className="w-3 h-3 inline mr-1" />}
                    {w.status}
                  </Badge>
                  <Badge variant={w.walkover_type === 'no_show' ? 'danger' : 'warning'}>
                    <AlertTriangle className="w-3 h-3 inline mr-1" />
                    {w.walkover_type}
                  </Badge>
                </div>

                {/* Reporter */}
                <div className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
                  <User className="w-4 h-4 text-[var(--text-muted)] flex-shrink-0" />
                  <span className="text-[var(--text-muted)]">Reported by:</span>
                  <span className="font-medium">{(w.reporter as Record<string, unknown>)?.full_name as string}</span>
                </div>

                {/* Forfeiting Player */}
                <div className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
                  <AlertTriangle className="w-4 h-4 text-[var(--color-danger)] flex-shrink-0" />
                  <span className="text-[var(--text-muted)]">Forfeiting:</span>
                  <span className="font-medium">{(w.forfeit as Record<string, unknown>)?.full_name as string}</span>
                </div>

                {/* Notice Hours */}
                {w.notice_hours !== null && (
                  <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                    <Clock className="w-3.5 h-3.5 flex-shrink-0" />
                    <span>Notice: {w.notice_hours} hours</span>
                  </div>
                )}

                {/* Timestamp */}
                <p className="text-xs text-[var(--text-muted)] opacity-70">
                  {formatRelativeTime(w.reported_at)}
                </p>

                {/* Admin Notes */}
                {w.admin_notes && (
                  <div className="mt-1 p-3 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border)] flex items-start gap-2">
                    <MessageSquare className="w-3.5 h-3.5 text-[var(--color-accent)] flex-shrink-0 mt-0.5" />
                    <span className="text-sm text-[var(--text-primary)]">{w.admin_notes}</span>
                  </div>
                )}
              </div>

              {/* Actions */}
              {w.status === 'pending' && <WalkoverActions walkoverId={w.id} />}
            </div>
          </div>
        ))}

        {/* Empty State */}
        {(!walkovers || walkovers.length === 0) && (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-12 flex flex-col items-center gap-3">
            <div className="w-14 h-14 rounded-full bg-[var(--color-success)]/10 flex items-center justify-center">
              <CheckCircle2 className="w-7 h-7 text-[var(--color-success)]" />
            </div>
            <p className="text-[var(--text-primary)] font-medium">No walkovers to review</p>
            <p className="text-sm text-[var(--text-muted)]">All walkover reports have been handled.</p>
          </div>
        )}
      </div>
    </div>
  );
}
