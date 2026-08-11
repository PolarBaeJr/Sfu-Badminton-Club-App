export const dynamic = 'force-dynamic';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { Card, Badge, PageHeader, ResponsiveTable, TableCard, Atomic, EmptyState } from '@badminton/ui';
import { CreateSeasonForm, SeasonRowActions, SeasonFeesPanel } from './actions';
import { SeasonProgressCard } from './season-progress';
import { PanelLabel, PANEL_NOTE } from './panel';
import { dateRange, hasStarted, seasonStatus, shortDate, today } from './season-shape';
import { AlertTriangle } from 'lucide-react';
import { accessLevelFor, permissionsOf, permits, type Capability } from '@/lib/permissions';

/** Cents as the club writes them. Mono, and never split across a line. */
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Distinct players with a recorded match, per season.
 *
 * There is no stored season headcount. `season_final_ratings` and
 * `season_snapshots` are written at ROLLOVER, so they answer for a season the
 * club has already left and are empty for the one being played — which is the
 * season anybody looking at this screen cares about. The live answer only
 * exists in match_participants, so it is counted here.
 *
 * Paged deliberately. PostgREST caps a response at 1000 rows by default, and a
 * single unpaged select would therefore have UNDER-counted silently once the
 * club passed a few hundred matches — a wrong number in a mono column is worse
 * than no number. The loop stops on the first short page; the iteration cap is
 * a guard against a misbehaving server, not a real limit (100 pages is 100,000
 * participant rows, roughly 30,000 matches).
 */
async function playersPlayedBySeason(
  supabase: ReturnType<typeof createAdminClient>,
): Promise<Map<string, number>> {
  const PAGE = 1000;
  const bySeason = new Map<string, Set<string>>();

  // The offset advances by WHAT CAME BACK, not by the window size, and the loop
  // stops on an empty page rather than on a short one. PostgREST's row cap is a
  // server setting: this is a self-hosted instance, and if `db-max-rows` is
  // below 1000 then page one is short while there is plenty more — "short page
  // means last page" would then have produced exactly the silent undercount the
  // paging exists to prevent. Advancing by the row count is correct under any
  // cap, because the cap limits the window and not the offset.
  let from = 0;

  for (let guard = 0; guard < 100; guard++) {
    const { data, error } = await supabase
      .from('match_participants')
      .select('player_id, matches!inner(season_id)')
      // Ordered so the ranges below partition the table instead of overlapping
      // it: an unordered paged read may return the same row twice and miss
      // another entirely.
      .order('id')
      .range(from, from + PAGE - 1);

    if (error || !data || data.length === 0) break;

    for (const row of data) {
      // A to-one embed comes back as an object, but the generated types for an
      // untyped client describe it as an array — the same shape-check every
      // other page here does on `players(full_name)`.
      const embedded = row.matches as
        | { season_id: string | null }
        | { season_id: string | null }[]
        | null;
      const seasonId = (Array.isArray(embedded) ? embedded[0] : embedded)?.season_id;
      // matches.season_id is nullable (ON DELETE SET NULL) — a match whose
      // season was removed belongs to no season and is counted under none.
      if (!seasonId) continue;
      let seen = bySeason.get(seasonId);
      if (!seen) bySeason.set(seasonId, (seen = new Set()));
      seen.add(row.player_id);
    }

    from += data.length;
  }

  return new Map([...bySeason].map(([id, players]) => [id, players.size]));
}

export default async function SeasonsPage() {
  // WHO IS LOOKING, and the only door on this screen.
  //
  // `seasons.page` admits somebody to the section; it does not decide what they
  // may do once here. Every control below asks for its own capability, and the
  // server action each one opens re-checks the same one — the route and the
  // rendered control cannot disagree, which is the bug this page had: an exec
  // holds no `seasons.fees.write`, and the desktop table handed them a fee
  // editor anyway, then rejected them at Save. (The mobile card already gated
  // it. Two halves of one component, one of them wrong.)
  //
  // EVERY FETCH ON THIS PAGE IS GATED BY THIS CALL AND NOTHING NARROWER, and
  // that is a statement about the capability vocabulary rather than an omission:
  // `seasons.*` has exactly one page key and four writes — there is no
  // `seasons.read` to gate a query on, and inventing one would move an answer in
  // the capability-equivalence table. Nothing read here belongs to another area:
  // the counts come from matches and match_participants, not from club_fees
  // (that is `fees.clubfees.read`) or platform_settings (`platform.page`).
  const viewer = await requireCapability('seasons.page');
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(viewer);
  const may = (capability: Capability) => permits(level, permissions, capability);

  const canCreate = may('seasons.create.write');
  const rowCapabilities = {
    fees: may('seasons.fees.write'),
    end: may('seasons.end.write'),
    activate: may('seasons.activate.write'),
  };

  const supabase = createAdminClient();

  const { data: seasons } = await supabase
    .from('seasons')
    // Explicit, so the RSC payload carries the eight columns this screen draws
    // and not whatever the table gains next.
    .select('id, name, start_date, end_date, active_flag, competitive_fee_cents, recreational_fee_cents')
    .order('start_date', { ascending: false });

  const rows = (seasons ?? []) as {
    id: string;
    name: string;
    start_date: string | null;
    end_date: string | null;
    active_flag: boolean;
    competitive_fee_cents: number | null;
    recreational_fee_cents: number | null;
  }[];

  const now = today();

  // Counts, only when there is something to count. Both reads sit behind
  // `seasons.page` above; skipping them on an empty list is about not making
  // six round trips to learn that zero seasons have zero matches.
  const [matchCounts, playerCounts] = rows.length
    ? await Promise.all([
        Promise.all(
          rows.map(async (s) => {
            // head + exact: a COUNT on the server, no rows over the wire, and no
            // 1000-row cap to trip over.
            const { count } = await supabase
              .from('matches')
              .select('id', { count: 'exact', head: true })
              .eq('season_id', s.id);
            return [s.id, count ?? 0] as const;
          }),
        ).then((entries) => new Map(entries)),
        playersPlayedBySeason(supabase),
      ])
    : [new Map<string, number>(), new Map<string, number>()];

  // The season the club is playing, as the right-hand column understands it.
  // The FLAG, not the dates: a term still flagged active after its last day is
  // where new matches and fees are being filed, so it is the one whose progress
  // and fees are worth showing — and the band below says it is overdue.
  const liveSeason = rows.find((s) => s.active_flag) ?? null;

  // The rollover is overdue. Every season-scoped write — sessions, tournaments,
  // matches, fees — is still being filed under a term that is over, and nothing
  // else in the console says so. The badge alone is too quiet for that: it is
  // one word in a table somebody has to think to visit.
  const overdueSeason = rows.find((s) => s.active_flag && s.end_date && s.end_date < now) ?? null;

  const statusBadge = (s: (typeof rows)[number]) => {
    const status = seasonStatus(s, now);
    return (
      <Badge variant={status.variant} className="uppercase tracking-[0.1em] text-[10px]">
        {status.label}
      </Badge>
    );
  };

  /** A count, or an em-dash for a season whose first day has not arrived. */
  const countCell = (s: (typeof rows)[number], count: number | undefined) =>
    hasStarted(s, now) ? (
      <span className="font-mono text-sm text-[var(--text-primary)]">{count ?? 0}</span>
    ) : (
      <span className="font-mono text-sm text-[var(--text-muted)]">—</span>
    );

  // separator="·" so the line may wrap BETWEEN the two amounts and never
  // inside one: `$25.` / `00` is the split Atomic was written to stop.
  const feesLine = (s: (typeof rows)[number]) => (
    <Atomic separator="·">
      {`Comp ${money(s.competitive_fee_cents ?? 0)} · Rec ${money(s.recreational_fee_cents ?? 0)}`}
    </Atomic>
  );

  const rowActions = (s: (typeof rows)[number]) => (
    <SeasonRowActions
      seasonId={s.id}
      seasonName={s.name}
      status={seasonStatus(s, now).key}
      competitiveFeeCents={s.competitive_fee_cents ?? 0}
      recreationalFeeCents={s.recreational_fee_cents ?? 0}
      can={rowCapabilities}
    />
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={`Ladder · ${rows.length} ${rows.length === 1 ? 'season' : 'seasons'}`}
        title="Seasons"
        sub="A rating only means something inside its season."
        watermark="S"
        actions={canCreate ? <CreateSeasonForm /> : undefined}
      />

      {overdueSeason && (
        <Card>
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-[var(--color-warning)]" />
            <div className="space-y-1">
              <p className="text-sm font-semibold text-[var(--text-primary)]">
                {overdueSeason.name} ended on {shortDate(overdueSeason.end_date!)} and is still the active season.
              </p>
              <p className="text-sm text-[var(--text-secondary)]">
                Until the next season is activated, every new session, tournament, match and fee is still recorded
                against this one. Set the season the club is actually playing active to roll over.
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* 2fr / 1fr, top-aligned — the table is as tall as the club's history and
          the two panels beside it are not. One column below `lg`, where the
          table has already become stacked cards. */}
      <div className="grid gap-5 items-start lg:grid-cols-[2fr_1fr]">
        <Card padding={false}>
          <PanelLabel label="All seasons" note="Newest first" className="px-5 pt-5 pb-3.5" />

          {rows.length > 0 ? (
            <>
              <ResponsiveTable
                cards={rows.map((s) => (
                  <TableCard
                    key={s.id}
                    title={s.name}
                    badges={statusBadge(s)}
                    fields={[
                      { label: 'Dates', value: <Atomic>{dateRange(s.start_date, s.end_date)}</Atomic> },
                      { label: 'Players', value: countCell(s, playerCounts.get(s.id)) },
                      { label: 'Matches', value: countCell(s, matchCounts.get(s.id)) },
                      { label: 'Fees', wide: true, value: feesLine(s) },
                    ]}
                    actions={rowActions(s)}
                  />
                ))}
              >
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className="px-5 pb-2 text-left font-mono text-[9px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">
                        Season
                      </th>
                      <th className="px-5 pb-2 text-left font-mono text-[9px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">
                        Status
                      </th>
                      <th className="px-5 pb-2 text-left font-mono text-[9px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">
                        Dates
                      </th>
                      <th className="px-5 pb-2 text-right font-mono text-[9px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">
                        Players
                      </th>
                      <th className="px-5 pb-2 text-right font-mono text-[9px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">
                        Matches
                      </th>
                      <th className="px-5 pb-2 text-right font-mono text-[9px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">
                        Action
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((s) => (
                      <tr key={s.id} className="border-t border-[var(--border)]">
                        <td className="px-5 py-4">
                          <div className="text-[14px] text-[var(--text-primary)]">{s.name}</div>
                          {/* The mockup's rule line (`CARRY-OVER 75% · K=24`)
                              names per-season rating knobs that do not exist —
                              those live in platform_settings, club-wide. The two
                              things a season genuinely carries of its own are
                              its fees. */}
                          <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
                            {feesLine(s)}
                          </div>
                        </td>
                        <td className="px-5 py-4">{statusBadge(s)}</td>
                        <td className="px-5 py-4 font-mono text-xs text-[var(--text-secondary)]">
                          <Atomic>{dateRange(s.start_date, s.end_date)}</Atomic>
                        </td>
                        <td className="px-5 py-4 text-right">{countCell(s, playerCounts.get(s.id))}</td>
                        <td className="px-5 py-4 text-right">{countCell(s, matchCounts.get(s.id))}</td>
                        <td className="px-5 py-4 text-right">{rowActions(s)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ResponsiveTable>

              {rowCapabilities.end && (
                <div className={`border-t border-[var(--border)] px-5 py-3.5 ${PANEL_NOTE}`}>
                  Closing a season freezes its ladder and takes a typed reason
                </div>
              )}
            </>
          ) : (
            // No second New season button here: the one in the header is this
            // screen's single primary, and the guidance is that two reds in one
            // view means one of them is wrong.
            <EmptyState
              title="No seasons yet"
              description={
                canCreate
                  ? 'Use New season above to set up the term the club is playing. Every match, fee and rating is filed against one.'
                  : 'Nothing has been created yet. An exec or admin sets the club’s first season up.'
              }
            />
          )}
        </Card>

        <div className="space-y-5">
          <SeasonProgressCard season={liveSeason} />
          <Card padding={false}>
            <SeasonFeesPanel
              season={
                liveSeason && {
                  id: liveSeason.id,
                  name: liveSeason.name,
                  competitive_fee_cents: liveSeason.competitive_fee_cents ?? 0,
                  recreational_fee_cents: liveSeason.recreational_fee_cents ?? 0,
                }
              }
              canEdit={rowCapabilities.fees}
            />
          </Card>
        </div>
      </div>
    </div>
  );
}
