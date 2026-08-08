export const dynamic = 'force-dynamic';
import { createAdminClient, getAuthenticatedExecOrAdmin } from '@/lib/supabase-server';
import { Card, Badge, PageHeader, ResponsiveTable, TableCard, Atomic } from '@badminton/ui';
import { formatDate } from '@badminton/shared';
import { CreateSeasonForm, SeasonActions, SeasonFeesEditor } from './actions';
import { Medal, Calendar, CheckCircle2, XCircle, Clock } from 'lucide-react';
import { accessLevelFor } from '@/lib/permissions';

export default async function SeasonsPage() {
  // Reachable at exec level (permissions.ts), but updateSeasonFees calls
  // getAdminPlayer(). Without this the page opened a fee editor for every exec,
  // accepted their typing, and rejected them at Save — the route and the nav
  // agreed, and the rendered CONTROL was the layer that disagreed. Same shape
  // the Legal page already uses: the flag decides what is offered, the server
  // action is still the boundary.
  const viewer = await getAuthenticatedExecOrAdmin();
  const canEditFees = accessLevelFor(viewer) === 'admin';

  const supabase = createAdminClient();

  const { data: seasons } = await supabase
    .from('seasons')
    .select('*')
    .order('start_date', { ascending: false });

  // Shared by the table cell and the card so the two can't drift apart.
  const statusBadge = (s: { active_flag: boolean; end_date: string | null }) =>
    s.active_flag ? (
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
    );

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <PageHeader
        title="Seasons"
        sub="Manage club seasons, set active periods, and track history"
        watermark="S"
        actions={<CreateSeasonForm />}
      />

      {/* Seasons Table */}
      <Card padding={false}>
        {seasons && seasons.length > 0 ? (
          <ResponsiveTable
            cards={seasons.map((s) => (
              <TableCard
                key={s.id}
                title={s.name}
                badges={statusBadge(s)}
                fields={[
                  { label: 'Start date', value: <Atomic>{formatDate(s.start_date)}</Atomic> },
                  { label: 'End date', value: s.end_date ? <Atomic>{formatDate(s.end_date)}</Atomic> : '--' },
                  {
                    label: 'Fees',
                    wide: true,
                    value: canEditFees ? (
                      <SeasonFeesEditor
                        seasonId={s.id}
                        competitiveFeeCents={s.competitive_fee_cents ?? 0}
                        recreationalFeeCents={s.recreational_fee_cents ?? 0}
                      />
                    ) : (
                      <Atomic>
                        {`Competitive $${((s.competitive_fee_cents ?? 0) / 100).toFixed(2)} · `}
                        {`Recreational $${((s.recreational_fee_cents ?? 0) / 100).toFixed(2)}`}
                      </Atomic>
                    ),
                  },
                ]}
                actions={<SeasonActions seasonId={s.id} seasonName={s.name} isActive={s.active_flag} />}
              />
            ))}
          >
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
                      {statusBadge(s)}
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
          </ResponsiveTable>
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
