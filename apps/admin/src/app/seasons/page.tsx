export const dynamic = 'force-dynamic';
import { createAdminClient } from '@/lib/supabase-server';
import { Card, Badge } from '@badminton/ui';
import { formatDate } from '@badminton/shared';
import { CreateSeasonForm, SeasonActions, SeasonFeesEditor } from './actions';
import { Medal, Calendar, CheckCircle2, XCircle, Clock } from 'lucide-react';

export default async function SeasonsPage() {
  const supabase = createAdminClient();

  const { data: seasons } = await supabase
    .from('seasons')
    .select('*')
    .order('start_date', { ascending: false });

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-[var(--color-accent)]/10">
            <Medal className="w-5 h-5 text-[var(--color-accent)]" />
          </div>
          <div>
            <h1 className="text-3xl font-bold font-display text-[var(--text-primary)]">SEASONS</h1>
            <p className="text-sm text-[var(--text-muted)] mt-0.5">
              Manage club seasons, set active periods, and track history
            </p>
          </div>
        </div>
        <CreateSeasonForm />
      </div>

      {/* Seasons Table */}
      <Card padding={false}>
        {seasons && seasons.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b-2 border-[var(--border)] bg-[var(--bg-surface)]/50">
                  <th className="px-5 py-3.5 text-left text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                    Name
                  </th>
                  <th className="px-5 py-3.5 text-left text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                    Start Date
                  </th>
                  <th className="px-5 py-3.5 text-left text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                    End Date
                  </th>
                  <th className="px-5 py-3.5 text-left text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-5 py-3.5 text-left text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                    Fees
                  </th>
                  <th className="px-5 py-3.5 text-right text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {seasons.map((s, index) => (
                  <tr
                    key={s.id}
                    className={`
                      group transition-colors duration-150 hover:bg-[var(--color-accent)]/5
                      ${index !== seasons.length - 1 ? 'border-b border-[var(--border)]' : ''}
                    `}
                  >
                    <td className="px-5 py-4 text-sm text-[var(--text-primary)] font-semibold">
                      <div className="flex items-center gap-2">
                        <Medal className="w-4 h-4 text-[var(--text-muted)] opacity-0 group-hover:opacity-100 transition-opacity" />
                        {s.name}
                      </div>
                    </td>
                    <td className="px-5 py-4 text-sm text-[var(--text-secondary)]">
                      <div className="flex items-center gap-2">
                        <Calendar className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                        {formatDate(s.start_date)}
                      </div>
                    </td>
                    <td className="px-5 py-4 text-sm text-[var(--text-secondary)]">
                      {s.end_date ? (
                        <div className="flex items-center gap-2">
                          <Calendar className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                          {formatDate(s.end_date)}
                        </div>
                      ) : (
                        <span className="text-[var(--text-muted)]">--</span>
                      )}
                    </td>
                    <td className="px-5 py-4">
                      {s.active_flag ? (
                        <Badge variant="success">
                          <span className="flex items-center gap-1.5">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Active
                          </span>
                        </Badge>
                      ) : s.end_date ? (
                        <Badge variant="neutral">
                          <span className="flex items-center gap-1.5">
                            <XCircle className="w-3.5 h-3.5" />
                            Ended
                          </span>
                        </Badge>
                      ) : (
                        <Badge variant="warning">
                          <span className="flex items-center gap-1.5">
                            <Clock className="w-3.5 h-3.5" />
                            Inactive
                          </span>
                        </Badge>
                      )}
                    </td>
                    <td className="px-5 py-4">
                      <SeasonFeesEditor
                        seasonId={s.id}
                        competitiveFeeCents={s.competitive_fee_cents ?? 0}
                        recreationalFeeCents={s.recreational_fee_cents ?? 0}
                      />
                    </td>
                    <td className="px-5 py-4 text-right">
                      <SeasonActions seasonId={s.id} seasonName={s.name} isActive={s.active_flag} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 px-4">
            <div className="flex items-center justify-center w-14 h-14 rounded-full bg-[var(--bg-surface)] mb-4">
              <Medal className="w-7 h-7 text-[var(--text-muted)]" />
            </div>
            <p className="text-[var(--text-primary)] font-medium mb-1">No seasons yet</p>
            <p className="text-sm text-[var(--text-muted)]">
              Create your first season to get started
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
