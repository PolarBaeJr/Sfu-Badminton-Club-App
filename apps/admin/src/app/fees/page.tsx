import Link from 'next/link';
import { createAdminClient } from '@/lib/supabase-server';
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
const TABS = [
  { id: 'fees', label: 'Club fees' },
  { id: 'income', label: 'Other income' },
  { id: 'expenses', label: 'Expenses' },
] as const;

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
  searchParams: Promise<{ tab?: string }>;
}) {
  const params = await searchParams;
  const tab: TabId = TABS.some((t) => t.id === params.tab) ? (params.tab as TabId) : 'fees';
  const supabase = createAdminClient();

  const season = unwrapMaybe<Season>(
    await supabase
      .from('seasons')
      .select('id, name, competitive_fee_cents, recreational_fee_cents')
      .eq('active_flag', true)
      .maybeSingle()
  );

  if (!season) {
    return (
      <div className="space-y-6">
        <PageHeader title="Fees" watermark="F" />
        <Card>
          {/* No season means no net position either: other_income and
              club_expenses are season_id NOT NULL (00073), so there is nothing
              to add up and no season to add it up for. Said out loud here
              rather than leaving an admin to wonder where the tabs went. */}
          <EmptyState
            title="No active season"
            description="Fees, other income and expenses all follow the active season. Create and activate a season to start tracking money in and out."
            action={
              <Link href="/seasons" className="text-[var(--color-accent)] font-medium">
                Go to Seasons
              </Link>
            }
          />
        </Card>
        {/* Rendered here too, deliberately. Club fees need a season and the
            rest of this page cannot be drawn without one — but a lapsed member
            coming back between terms is the ordinary reinstatement, and those
            rows would otherwise be unreachable for exactly as long as the club
            is between seasons. */}
        <ReinstatementsCard seasonId={null} />
      </div>
    );
  }

  const feeForStatus = (status: string) =>
    status === 'competitive' ? season.competitive_fee_cents : season.recreational_fee_cents;

  // Only the Club fees tab renders the roster table, so only it pays for the
  // two queries behind it. The derived counts below all collapse to 0 on an
  // empty list and none of them are rendered off that tab.
  const showFeeTable = tab === 'fees';

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
  const finances = await getSeasonFinances(supabase, season);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Finances"
        watermark="F"
        sub={`${season.name} · Competitive $${(season.competitive_fee_cents / 100).toFixed(2)} · Recreational $${(season.recreational_fee_cents / 100).toFixed(2)}`}
        actions={showFeeTable ? <AddManualFee seasonId={season.id} seasonName={season.name} /> : undefined}
      />

      {/* The answer to "are we in the positives", above the tabs so it is on
          screen no matter which ledger is open. */}
      <NetPositionStrip finances={finances} seasonName={season.name} />

      {/* Tabs. Plain links, matching /players?tab= — the page is an async
          server component, so a client tab control would mean shipping every
          ledger's rows to the browser to show one of them. */}
      <Card padding={false}>
        <div className="flex gap-1 p-1 overflow-x-auto">
          {TABS.map((t) => (
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

      {tab === 'income' && (
        <LedgerCard kind="income" seasonId={season.id} seasonName={season.name} />
      )}

      {tab === 'expenses' && (
        <LedgerCard kind="expense" seasonId={season.id} seasonName={season.name} />
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
      <ReinstatementsCard seasonId={season.id} />
      </>
      )}
    </div>
  );
}
