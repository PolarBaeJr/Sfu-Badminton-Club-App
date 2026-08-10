export const dynamic = 'force-dynamic';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { Card, Badge, PageHeader, ResponsiveTable, TableCard, Atomic } from '@badminton/ui';
import { formatDate } from '@badminton/shared';
import { CreateSeasonForm, SeasonActions, SeasonFeesEditor } from './actions';
import { Medal, Calendar, CalendarClock, CheckCircle2, XCircle, Clock, AlertTriangle } from 'lucide-react';
import { accessLevelFor, permissionsOf, permits } from '@/lib/permissions';

export default async function SeasonsPage() {
  // seasons.read opens the page, but updateSeasonFees asks for
  // seasons.fees.write, which no baseline below admin holds. Without this flag
  // the page opened a fee editor for every exec, accepted their typing, and
  // rejected them at Save — the route and the nav agreed, and the rendered
  // CONTROL was the layer that disagreed. Same shape the Legal page uses: the
  // flag decides what is offered, the server action is still the boundary.
  const viewer = await requireCapability('seasons.read');
  const canEditFees = permits(accessLevelFor(viewer), permissionsOf(viewer), 'seasons.fees.write');

  const supabase = createAdminClient();

  const { data: seasons } = await supabase
    .from('seasons')
    .select('*')
    .order('start_date', { ascending: false });

  // Today as a plain calendar date, for comparing against DATE columns.
  //
  // en-CA rather than toISOString(): the latter converts to UTC first, so from
  // 5pm Pacific onwards it reports tomorrow's date and a season would be called
  // "started" the evening before it does.
  const today = new Date().toLocaleDateString('en-CA');

  // The active season whose last day has already passed, if there is one.
  const overdueSeason =
    (seasons ?? []).find((s) => s.active_flag && s.end_date && s.end_date < today) ?? null;

  // Shared by the table cell and the card so the two can't drift apart.
  //
  // "Ended" used to mean nothing more than "has an end_date", which every
  // properly filled-in season has from the day it is created. A season running
  // September to December therefore read as Ended all summer, before it had
  // begun. The dates decide it now.
  const statusBadge = (s: { active_flag: boolean; start_date: string | null; end_date: string | null }) =>
    // The DATES come first, including ahead of active_flag.
    //
    // A season is a semester: it runs from its first day to its last and then it
    // is over, whether or not anybody pressed a button. Letting the flag win
    // meant a season that finished last week still read "Active" — which is
    // exactly what production was showing, a term that ended yesterday
    // presented as the one currently being played.
    //
    // Still flagged active AFTER its end date is a state worth shouting about
    // rather than hiding: it means the rollover has not happened, and until it
    // does every new session, tournament and fee is still being filed under the
    // finished term. Warning colour, and the page says so above the table.
    s.end_date && s.end_date < today ? (
      <Badge variant={s.active_flag ? 'warning' : 'neutral'}>
        <span className="flex items-center gap-1.5">
          <XCircle className="w-3.5 h-3.5" />
          Ended
        </span>
      </Badge>
    ) : s.active_flag ? (
      <Badge variant="success">
        <span className="flex items-center gap-1.5">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Active
        </span>
      </Badge>
    ) : s.start_date && s.start_date > today ? (
      <Badge variant="info">
        <span className="flex items-center gap-1.5">
          <CalendarClock className="w-3.5 h-3.5" />
          Upcoming
        </span>
      </Badge>
    ) : (
      // Started, not finished, but not the active season either — someone has
      // not pressed Activate.
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

      {/* The rollover is overdue.
          Every season-scoped write — sessions, tournaments, matches, fees — is
          still being filed under a term that is over, and nothing else in the
          console says so. The badge alone is too quiet for that: it is one word
          in a table somebody has to think to visit. */}
      {overdueSeason && (
        <Card>
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-[var(--color-warning)]" />
            <div className="space-y-1">
              <p className="text-sm font-semibold text-[var(--text-primary)]">
                {overdueSeason.name} ended on {formatDate(overdueSeason.end_date!)} and is still the active season.
              </p>
              <p className="text-sm text-[var(--text-secondary)]">
                Until the next season is activated, every new session, tournament, match and fee is still recorded
                against this one. Activate the season the club is actually playing to roll over.
              </p>
            </div>
          </div>
        </Card>
      )}

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
