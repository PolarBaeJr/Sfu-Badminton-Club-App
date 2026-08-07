import Link from 'next/link';
import { createAdminClient } from '@/lib/supabase-server';
import { Badge, Card, AvatarChip, EmptyState, PageHeader, ResponsiveTable, TableCard, Atomic } from '@badminton/ui';
import { unwrap, unwrapMaybe, formatPaymentMethod } from '@badminton/shared';
import type { Season } from '@badminton/shared';
import { isWaivedFee } from '@/lib/fee-status';
import { getSeasonIncome } from '@/lib/season-income';
import { FeeActions, AddManualFee, RemoveManualFee, RecordReinstatementPayment } from './fee-actions';

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

export default async function FeesPage() {
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
          <EmptyState
            title="No active season"
            description="Club fees follow the active season. Create and activate a season to start tracking fees."
            action={
              <Link href="/seasons" className="text-[var(--color-accent)] font-medium">
                Go to Seasons
              </Link>
            }
          />
        </Card>
      </div>
    );
  }

  const feeForStatus = (status: string) =>
    status === 'competitive' ? season.competitive_fee_cents : season.recreational_fee_cents;

  // Fee-collection list: active players (competitive/recreational) who are
  // neither exec nor fee-exempt.
  const players = unwrap(
    await supabase
      .from('players')
      .select('id, full_name, email, avatar_url, status')
      .in('status', ['competitive', 'recreational'])
      .eq('is_exec', false)
      .eq('fee_exempt', false)
      .order('full_name')
  );

  const fees = unwrap(
    await supabase
      .from('club_fees')
      .select('id, player_id, manual_name, amount_cents, paid_at, method, reference')
      .eq('season_id', season.id)
  );
  const feeByPlayer = new Map(
    fees.filter((f) => f.player_id != null).map((f) => [f.player_id, f])
  );
  const manualFees = fees.filter((f) => f.manual_name != null);

  // Reinstatements. Two queries rather than one `.or()`: this season's rows,
  // plus every row anywhere whose amount was never recorded.
  //
  // The second half is the point. An exec may lift a ban but may not touch the
  // ledger, so their unban files a reinstatement with no amount — and one taken
  // between terms carries no season either. Listing only the active season's
  // rows would hide exactly the payments nobody has recorded yet, which is the
  // state this section exists to make actionable.
  const REINSTATEMENT_COLS = 'id, player_id, amount_cents, paid_at, method, reference, ban_reason, created_at';
  const [thisSeason, unrecorded] = await Promise.all([
    supabase.from('reinstatement_fees').select(REINSTATEMENT_COLS).eq('season_id', season.id),
    supabase.from('reinstatement_fees').select(REINSTATEMENT_COLS).is('amount_cents', null),
  ]);
  const reinstatements = [...unwrap(thisSeason), ...unwrap(unrecorded)]
    .filter((row, i, all) => all.findIndex((r) => r.id === row.id) === i)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  const reinstatedPlayerIds = [...new Set(reinstatements.map((r) => r.player_id))];
  const reinstatedPlayers = reinstatedPlayerIds.length
    ? unwrap(
        await supabase
          .from('players')
          .select('id, full_name, email, avatar_url')
          .in('id', reinstatedPlayerIds)
      )
    : [];
  const reinstatedById = new Map(reinstatedPlayers.map((p) => [p.id, p]));

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

  // Income collected this season across ALL three fee ledgers. This used to sum
  // club_fees only, so a recorded reinstatement or tournament payment left the
  // headline reading $0.00 while the money sat in the database.
  const income = await getSeasonIncome(supabase, season);
  const collectedCents = income.totalCents;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Fees"
        watermark="F"
        sub={`${season.name} · Competitive $${(season.competitive_fee_cents / 100).toFixed(2)} · Recreational $${(season.recreational_fee_cents / 100).toFixed(2)}`}
        actions={<AddManualFee seasonId={season.id} seasonName={season.name} />}
      />

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <p className="text-xs text-[var(--text-muted)] uppercase">Collected</p>
          <p className="text-2xl font-bold font-mono text-[var(--text-primary)]">${(collectedCents / 100).toFixed(2)}</p>
          <p className="text-xs text-[var(--text-muted)] mt-1">Season income</p>
        </Card>
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

      {/* Reinstatements. A row with no amount is money that may have changed
          hands without anyone being able to write it down — an exec lifts the
          ban, the payment fields are admin-only, and there was no way back to
          the record afterwards. This is that way back. */}
      {reinstatements.length > 0 && (
        <Card padding={false}>
          <div className="px-4 pt-4">
            <h2 className="text-sm font-medium text-[var(--text-primary)]">Reinstatements</h2>
            <p className="text-xs text-[var(--text-muted)]">
              Bans lifted this season, and any reinstatement whose payment has not been recorded yet.
            </p>
          </div>
          <ResponsiveTable
            cards={reinstatements.map((fee) => {
              const person = reinstatedById.get(fee.player_id);
              const recorded = fee.amount_cents != null;
              return (
                <TableCard
                  key={fee.id}
                  title={personTitle(
                    person?.full_name ?? 'Former member',
                    fee.ban_reason ?? 'Reinstated',
                    person?.avatar_url,
                    fee.player_id,
                  )}
                  value={recorded ? `$${(fee.amount_cents / 100).toFixed(2)}` : '-'}
                  badges={
                    <Badge variant={recorded ? 'success' : 'warning'}>
                      {recorded ? 'Recorded' : 'Not recorded'}
                    </Badge>
                  }
                  fields={[
                    { label: 'Method', value: fee.method ? formatPaymentMethod(fee.method) : '-' },
                    { label: 'Reference', value: fee.reference ? <Atomic className="font-mono text-xs">{fee.reference}</Atomic> : '-' },
                  ]}
                  actions={
                    recorded ? null : (
                      <RecordReinstatementPayment
                        feeId={fee.id}
                        playerName={person?.full_name ?? 'this member'}
                      />
                    )
                  }
                />
              );
            })}
          >
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Member</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Payment</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Amount</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Method</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {reinstatements.map((fee) => {
                  const person = reinstatedById.get(fee.player_id);
                  const recorded = fee.amount_cents != null;
                  return (
                    <tr key={fee.id} className="hover:bg-[var(--border-hover)] transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <AvatarChip name={person?.full_name ?? '?'} src={person?.avatar_url} size="sm" id={fee.player_id} />
                          <div>
                            <p className="text-sm font-medium text-[var(--text-primary)]">{person?.full_name ?? 'Former member'}</p>
                            <p className="text-xs text-[var(--text-muted)]">{fee.ban_reason ?? 'Reinstated'}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={recorded ? 'success' : 'warning'}>
                          {recorded ? 'Recorded' : 'Not recorded'}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="font-mono text-[var(--text-primary)]">
                          {recorded ? `$${(fee.amount_cents / 100).toFixed(2)}` : '-'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">
                        {fee.method ? formatPaymentMethod(fee.method) : '-'}
                        {fee.reference && (
                          <span className="block font-mono text-xs text-[var(--text-muted)]">{fee.reference}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {!recorded && (
                          <RecordReinstatementPayment
                            feeId={fee.id}
                            playerName={person?.full_name ?? 'this member'}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ResponsiveTable>
        </Card>
      )}
    </div>
  );
}
