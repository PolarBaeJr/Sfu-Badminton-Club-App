import Link from 'next/link';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { accessLevelFor, permissionsOf, permits, type Capability } from '@/lib/permissions';
import { PastSeasonNotice, resolveSeasonScope } from '@/components/season-scope';
import { SeasonSelect } from '@/components/season-select';
import { Badge, Card, AvatarChip, EmptyState, PageHeader, ResponsiveTable, TableCard, Atomic } from '@badminton/ui';
import { unwrap, unwrapMaybe, formatPaymentMethod } from '@badminton/shared';
import type { Season } from '@badminton/shared';
import { isWaivedFee } from '@/lib/fee-status';
import { getSeasonFinances } from '@/lib/season-finance';
import { FeeActions, AddManualFee, RemoveManualFee } from './fee-actions';
import { ReinstatementsCard } from './reinstatements-card';
import { LedgerCard } from './ledger-card';
import { NetPositionStrip } from './net-position-strip';

// The three sections of the money page. 'fees' is the original table; the other
// two are the ledgers the club owner asked for ("add other fees", "add another
// tab called expenses"). URL-driven rather than client state so each is a
// server render with its own query — the tab you are not looking at costs
// nothing, and a link to a tab is shareable.
//
// `read` is the exec split, and each tab names its OWN capability rather than
// sharing one flag. /fees admits anyone holding `fees.page`, and an exec holds
// exactly one of the reads beneath it — fees.expenses.read — because the club
// owner asked for "execs can add expenses", not for the finance page. An exec
// gets the Expenses tab and nothing else: no fee roster, no other income, no net
// position, and no tab strip advertising that they exist.
//
// A HOLDER OF THE PAGE AND NO READ AT ALL is a supported state, and the one this
// section was reshaped for: they get the header, the Add expense control if they
// hold that write, and not a single row of anybody's ledger.
// A tab is offered to somebody who may SEE its ledger or ADD to it. Those are
// two capabilities now, and the second without the first is the state this whole
// reshape exists for — offering the tab only on the read would leave a holder of
// the write with a control they cannot navigate to.
const TABS = [
  { id: 'fees', label: 'Club fees', read: 'fees.clubfees.read', add: 'fees.clubfees.addmanual.write' },
  { id: 'income', label: 'Other income', read: 'fees.otherincome.read', add: 'fees.otherincome.add.write' },
  { id: 'expenses', label: 'Expenses', read: 'fees.expenses.read', add: 'fees.expenses.add.write' },
] as const satisfies readonly { id: string; label: string; read: Capability; add: Capability }[];

type TabId = (typeof TABS)[number]['id'];

/** Card identity line: the same avatar + name + sub-line the Player cell shows. */
function personTitle(name: string, sub: string, avatarUrl?: string | null, id?: string) {
  return (
    <div className="flex items-center gap-3">
      <AvatarChip name={name} src={avatarUrl ?? undefined} size="sm" id={id} />
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--text-primary)]">{name}</p>
        <p className="text-xs font-normal text-[var(--text-muted)]">{sub}</p>
      </div>
    </div>
  );
}

export default async function FeesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; season?: string }>;
}) {
  const params = await searchParams;

  // Who is looking. requireCapability() is the gate — middleware already ran,
  // but a page that renders money must not depend on middleware having been
  // reached, and this is the same shape /legal uses. fees.page is the one
  // capability every viewer of this page must hold, and it buys the section
  // only; every ledger on it is asked for separately below.
  const viewer = await requireCapability('fees.page');
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(viewer);
  const may = (capability: Capability) => permits(level, permissions, capability);
  // Presentation only — the page is called "Finances" when it shows more than
  // one ledger. Every FETCH below asks for the capability its own data needs.
  const isAdmin = level === 'admin';
  const showExpenses = may('fees.expenses.read');
  const showClubFees = may('fees.clubfees.read');
  const showOtherIncome = may('fees.otherincome.read');
  const showNetPosition = may('fees.netposition.read');
  const showReinstatements = may('fees.reinstatements.read');
  // WHICH LEDGER CONTROLS ARE OFFERED, asked one capability at a time.
  //
  // These four used to be a single `isAdmin` handed to LedgerCard, which was
  // true of the boundary as it stood — filing an expense was exec work and
  // everything else on the row was admin work. It is not a boundary that can be
  // written down as one flag any more: the point of this model is that a
  // treasurer can be handed "edit and settle expenses" without being handed the
  // console. Each control names the capability its own action re-checks, so the
  // two agree by construction rather than by two people remembering one rule.
  const expenseWrites = {
    add: may('fees.expenses.add.write'),
    update: may('fees.expenses.update.write'),
    reimburse: may('fees.expenses.reimburse.write'),
    remove: may('fees.expenses.remove.write'),
  };
  const incomeWrites = {
    add: may('fees.otherincome.add.write'),
    // The income ledger has no payer, so nothing to edit in place and nothing
    // to settle — removeOtherIncome is the only write on a row.
    update: false,
    reimburse: false,
    remove: may('fees.otherincome.remove.write'),
  };

  const visibleTabs = TABS.filter((t) => may(t.read) || may(t.add));
  // An exec asking for ?tab=income lands on Expenses rather than /unauthorized:
  // the query string is not a route, so middleware cannot see it, and every
  // fetch below is gated on its own capability regardless of what `tab` says.
  // Forcing the tab is presentation; the gating underneath is the boundary.
  //
  // Falls back to Expenses when nothing is visible at all, which renders
  // nothing: a viewer with the page and no ledger capability sees the header and
  // the season picker, and that is the whole of it.
  const requested = visibleTabs.find((t) => t.id === params.tab)?.id;
  const tab: TabId = requested ?? visibleTabs[0]?.id ?? 'expenses';

  const supabase = createAdminClient();

  // The fee amounts are only ever rendered in the admin header line, so an exec
  // does not fetch them. Trimming the column list rather than the JSX is the
  // rule this whole page follows: a value that reaches the server component
  // reaches the RSC payload whether or not it is drawn.
  // Every season, so a finished term's books stay reachable. This page was
  // pinned to active_flag with no override, which meant that the moment a
  // season rolled over the club's own accounts for it — dues, other income,
  // expenses, the net position — could not be opened from the console at all.
  // The rows were always there and correctly stamped; nothing could name a
  // different season.
  const { data: allSeasons } = await supabase
    .from('seasons')
    .select('id, name, start_date, end_date, active_flag, competitive_fee_cents, recreational_fee_cents')
    .order('start_date', { ascending: false });
  const { seasons: seasonList, selected: scopedSeason, isPast } =
    resolveSeasonScope(allSeasons, params.season);
  const season = scopedSeason as Season | null;

  if (!season) {
    return (
      <div className="space-y-6">
        <PageHeader title={isAdmin ? 'Fees' : 'Expenses'} watermark={isAdmin ? 'F' : 'E'} />
        <Card>
          {/* No season means no net position either: other_income and
              club_expenses are season_id NOT NULL (00073), so there is nothing
              to add up and no season to add it up for. Said out loud here
              rather than leaving an admin to wonder where the tabs went. */}
          <EmptyState
            title="No active season"
            description={
              isAdmin
                ? 'Fees, other income and expenses all follow the active season. Create and activate a season to start tracking money in and out.'
                : 'Expenses follow the active season. An admin needs to activate one before spending can be recorded.'
            }
            action={
              isAdmin ? (
                <Link href="/seasons" className="text-[var(--color-accent)] font-medium">
                  Go to Seasons
                </Link>
              ) : undefined
            }
          />
        </Card>
        {/* Rendered here too, deliberately. Club fees need a season and the
            rest of this page cannot be drawn without one — but a lapsed member
            coming back between terms is the ordinary reinstatement, and those
            rows would otherwise be unreachable for exactly as long as the club
            is between seasons.
            Gated on its own capability rather than left to the tab logic: this
            branch returns BEFORE the tabs exist, and the card runs its own
            fetch — an exec opening /fees between seasons would otherwise have
            been handed the reinstatement ledger with no tab involved. */}
        {showReinstatements && <ReinstatementsCard seasonId={null} />}
      </div>
    );
  }

  const feeForStatus = (status: string) =>
    status === 'competitive' ? season.competitive_fee_cents : season.recreational_fee_cents;

  // Only the Club fees tab renders the roster table, so only it pays for the
  // two queries behind it. The derived counts below all collapse to 0 on an
  // empty list and none of them are rendered off that tab.
  //
  // `showClubFees &&` is belt as well as braces: `tab` can never be 'fees'
  // without it (the tab list would not contain it), but this flag gates the
  // FETCHES, and a fetch guarded only by a value derived from a query string is
  // one refactor away from being guarded by nothing.
  const showFeeTable = showClubFees && tab === 'fees';

  // Fee-collection list: active players (competitive/recreational) who are
  // neither exec nor fee-exempt.
  const players = showFeeTable
    ? unwrap(
        await supabase
          .from('players')
          .select('id, full_name, email, avatar_url, status')
          .in('status', ['competitive', 'recreational'])
          .eq('is_exec', false)
          .eq('fee_exempt', false)
          .order('full_name')
      )
    : [];

  const fees = showFeeTable
    ? unwrap(
        await supabase
          .from('club_fees')
          .select('id, player_id, manual_name, amount_cents, paid_at, method, reference')
          .eq('season_id', season.id)
      )
    : [];
  const feeByPlayer = new Map(
    fees.filter((f) => f.player_id != null).map((f) => [f.player_id, f])
  );
  const manualFees = fees.filter((f) => f.manual_name != null);

  // Shared with waiveFee (lib/fee-status) so the page and the action cannot
  // drift on what "already waived" means.
  const isWaived = isWaivedFee;

  // Waived players count as neither Paid nor Outstanding.
  const waivedPlayers = players.filter((p) => isWaived(feeByPlayer.get(p.id))).length;
  const paidPlayers = players.filter((p) => {
    const fee = feeByPlayer.get(p.id);
    return fee?.paid_at && !isWaived(fee);
  }).length;
  const paidCount = paidPlayers + manualFees.length;
  const outstandingCount = players.length - paidPlayers - waivedPlayers;

  // Everything in and everything out for this season, through the single
  // helper. Income used to be summed from club_fees only, so a recorded
  // reinstatement or tournament payment left the headline reading $0.00 while
  // the money sat in the database — and it was wrong on two pages at once
  // because each page did its own arithmetic. There is one implementation now
  // and both pages call it.
  //
  // Not fetched at all for an exec. This one call reads every income ledger the
  // club has; rendering it conditionally while still awaiting it would put
  // fees, tournament money, reinstatements, donations and the net position into
  // the RSC payload of someone shown none of them.
  const finances = showNetPosition ? await getSeasonFinances(supabase, season) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={isAdmin ? 'Finances' : 'Expenses'}
        watermark={isAdmin ? 'F' : 'E'}
        // The fee amounts are club pricing, and the exec header carries only
        // the season name — the columns behind the rest were never selected.
        sub={
          isAdmin
            ? `${season.name} · Competitive $${(season.competitive_fee_cents / 100).toFixed(2)} · Recreational $${(season.recreational_fee_cents / 100).toFixed(2)}`
            : `${season.name} · Money the club has spent`
        }
        // Adding a fee by hand is offered only for the CURRENT season. Browsing a
        // finished term is for reading its books, and a new fee filed into it
        // would land outside the season the club is actually collecting for.
        actions={
          tab === 'fees' && may('fees.clubfees.addmanual.write') && !isPast
            ? <AddManualFee seasonId={season.id} seasonName={season.name} />
            : undefined
        }
      />

      <div className="space-y-2">
        <SeasonSelect seasons={seasonList} selected={scopedSeason} basePath="/fees" />
        {isPast && scopedSeason && <PastSeasonNotice season={scopedSeason} />}
      </div>

      {/* The answer to "are we in the positives", above the tabs so it is on
          screen no matter which ledger is open. Admin-only, and `finances` is
          null rather than unrendered for an exec — there is nothing to leak
          because nothing was fetched. */}
      {finances && <NetPositionStrip finances={finances} seasonName={season.name} />}

      {/* Tabs. Plain links, matching /players?tab= — the page is an async
          server component, so a client tab control would mean shipping every
          ledger's rows to the browser to show one of them.
          Hidden entirely when there is only one tab to show: a lone "Expenses"
          pill an exec cannot navigate away from is noise, and a full strip
          would advertise two sections that would bounce them. */}
      {visibleTabs.length > 1 && (
      <Card padding={false}>
        <div className="flex gap-1 p-1 overflow-x-auto">
          {visibleTabs.map((t) => (
            <Link
              key={t.id}
              href={`/fees?tab=${t.id}`}
              className={`px-4 min-h-[44px] text-sm rounded-md transition-colors flex items-center ${
                tab === t.id
                  ? 'bg-[var(--color-accent)] text-white'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-hover)]'
              }`}
            >
              {t.label}
            </Link>
          ))}
        </div>
      </Card>
      )}

      {(showOtherIncome || incomeWrites.add) && tab === 'income' && (
        <LedgerCard
          kind="income"
          seasonId={season.id}
          seasonName={season.name}
          canRead={showOtherIncome}
          canWrite={incomeWrites}
        />
      )}

      {/* The Expenses ledger, or just its Add control. Rendered when the viewer
          may SEE it or may ADD to it — the two are separate permissions now, and
          somebody holding only the write is exactly the person this section was
          reshaped for. `tab` is not consulted for the write-only case: with no
          reads there is no tab strip to have chosen from, and it falls through
          to 'expenses' anyway. */}
      {(showExpenses || expenseWrites.add) && tab === 'expenses' && (
        <LedgerCard
          kind="expense"
          seasonId={season.id}
          seasonName={season.name}
          canRead={showExpenses}
          canWrite={expenseWrites}
        />
      )}

      {showFeeTable && (
      <>
      {/* Summary */}
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <p className="text-xs text-[var(--text-muted)] uppercase">Paid</p>
          <p className="text-2xl font-bold font-mono text-[var(--color-success)]">{paidCount}</p>
        </Card>
        <Card>
          <p className="text-xs text-[var(--text-muted)] uppercase">Outstanding</p>
          <p className="text-2xl font-bold font-mono text-[var(--color-warning)]">{outstandingCount}</p>
        </Card>
      </div>

      {/* Fee Table */}
      <Card padding={false}>
        <ResponsiveTable
          cards={[
            ...players.map((player) => {
              const fee = feeByPlayer.get(player.id);
              const waived = isWaived(fee);
              const paid = Boolean(fee?.paid_at) && !waived;
              return (
                <TableCard
                  key={player.id}
                  title={personTitle(player.full_name, player.email, player.avatar_url, player.id)}
                  value={paid && fee?.amount_cents != null ? `$${(fee.amount_cents / 100).toFixed(2)}` : '-'}
                  badges={
                    <Badge variant={paid ? 'success' : waived ? 'neutral' : 'warning'}>
                      {paid ? 'Paid' : waived ? 'Waived' : 'Unpaid'}
                    </Badge>
                  }
                  fields={[
                    { label: 'Method', value: paid && fee?.method ? formatPaymentMethod(fee.method) : '-' },
                    { label: 'Reference', value: paid && fee?.reference ? <Atomic className="font-mono text-xs">{fee.reference}</Atomic> : '-' },
                  ]}
                  actions={
                    <FeeActions
                      playerId={player.id}
                      playerName={player.full_name}
                      seasonId={season.id}
                      seasonName={season.name}
                      defaultFeeCents={feeForStatus(player.status)}
                      paid={paid}
                      waived={waived}
                    />
                  }
                />
              );
            }),
            ...manualFees.map((fee) => (
              <TableCard
                key={fee.id}
                title={personTitle(fee.manual_name, 'Manual entry')}
                value={fee.amount_cents != null ? `$${(fee.amount_cents / 100).toFixed(2)}` : '-'}
                badges={<Badge variant="success">Paid</Badge>}
                fields={[
                  { label: 'Method', value: fee.method ? formatPaymentMethod(fee.method) : '-' },
                  { label: 'Reference', value: fee.reference ? <Atomic className="font-mono text-xs">{fee.reference}</Atomic> : '-' },
                ]}
                actions={<RemoveManualFee id={fee.id} name={fee.manual_name} />}
              />
            )),
          ]}
        >
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--border)]">
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Player</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Status</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Amount</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Method</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {players.map((player) => {
                const fee = feeByPlayer.get(player.id);
                const waived = isWaived(fee);
                const paid = Boolean(fee?.paid_at) && !waived;
                return (
                  <tr key={player.id} className="hover:bg-[var(--border-hover)] transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <AvatarChip name={player.full_name} src={player.avatar_url} size="sm" id={player.id} />
                        <div>
                          <p className="text-sm font-medium text-[var(--text-primary)]">{player.full_name}</p>
                          <p className="text-xs text-[var(--text-muted)]">{player.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={paid ? 'success' : waived ? 'neutral' : 'warning'}>
                        {paid ? 'Paid' : waived ? 'Waived' : 'Unpaid'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="font-mono text-[var(--text-primary)]">
                        {paid && fee?.amount_cents != null ? `$${(fee.amount_cents / 100).toFixed(2)}` : '-'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">
                      {paid && fee?.method ? formatPaymentMethod(fee.method) : '-'}
                      {paid && fee?.reference && (
                        <span className="block font-mono text-xs text-[var(--text-muted)]">{fee.reference}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <FeeActions
                        playerId={player.id}
                        playerName={player.full_name}
                        seasonId={season.id}
                        seasonName={season.name}
                        defaultFeeCents={feeForStatus(player.status)}
                        paid={paid}
                        waived={waived}
                      />
                    </td>
                  </tr>
                );
              })}
              {manualFees.map((fee) => (
                <tr key={fee.id} className="hover:bg-[var(--border-hover)] transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <AvatarChip name={fee.manual_name} size="sm" />
                      <div>
                        <p className="text-sm font-medium text-[var(--text-primary)]">{fee.manual_name}</p>
                        <p className="text-xs text-[var(--text-muted)]">Manual entry</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="success">Paid</Badge>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className="font-mono text-[var(--text-primary)]">
                      {fee.amount_cents != null ? `$${(fee.amount_cents / 100).toFixed(2)}` : '-'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">
                    {fee.method ? formatPaymentMethod(fee.method) : '-'}
                    {fee.reference && (
                      <span className="block font-mono text-xs text-[var(--text-muted)]">{fee.reference}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <RemoveManualFee id={fee.id} name={fee.manual_name} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ResponsiveTable>
        {players.length === 0 && manualFees.length === 0 && (
          <p className="text-center text-[var(--text-muted)] py-8">No players owe fees for this season</p>
        )}
      </Card>

      {/* Stays on the Club fees tab: a reinstatement IS a fee, and the rows
          with no amount recorded are the ones an admin is meant to trip over
          while working through the fee list. */}
      {showReinstatements && <ReinstatementsCard seasonId={season.id} />}
      </>
      )}
    </div>
  );
}
