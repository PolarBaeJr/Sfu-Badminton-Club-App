import Link from 'next/link';
import { createAdminClient } from '@/lib/supabase-server';
import { Badge, Card, Avatar, EmptyState, PageHeader } from '@badminton/ui';
import { unwrap, unwrapMaybe } from '@badminton/shared';
import type { Season } from '@badminton/shared';
import { FeeActions, AddManualFee, RemoveManualFee } from './fee-actions';

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
      .select('id, player_id, manual_name, amount_cents, paid_at, method')
      .eq('season_id', season.id)
  );
  const feeByPlayer = new Map(
    fees.filter((f) => f.player_id != null).map((f) => [f.player_id, f])
  );
  const manualFees = fees.filter((f) => f.manual_name != null);

  const paidPlayers = players.filter((p) => feeByPlayer.get(p.id)?.paid_at).length;
  const paidCount = paidPlayers + manualFees.length;
  const outstandingCount = players.length - paidPlayers;

  // Total club-fee income collected this season (paid rows, incl. manual).
  const collectedCents = fees
    .filter((f) => f.paid_at != null)
    .reduce((sum, f) => sum + (f.amount_cents ?? 0), 0);

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
        <div className="overflow-x-auto">
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
                const paid = Boolean(fee?.paid_at);
                return (
                  <tr key={player.id} className="hover:bg-[var(--border-hover)] transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar name={player.full_name} src={player.avatar_url} size="sm" />
                        <div>
                          <p className="text-sm font-medium text-[var(--text-primary)]">{player.full_name}</p>
                          <p className="text-xs text-[var(--text-muted)]">{player.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={paid ? 'success' : 'warning'}>{paid ? 'Paid' : 'Unpaid'}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="font-mono text-[var(--text-primary)]">
                        {paid && fee?.amount_cents != null ? `$${(fee.amount_cents / 100).toFixed(2)}` : '-'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">
                      {(paid && fee?.method) || '-'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <FeeActions
                        playerId={player.id}
                        playerName={player.full_name}
                        seasonId={season.id}
                        seasonName={season.name}
                        defaultFeeCents={feeForStatus(player.status)}
                        paid={paid}
                      />
                    </td>
                  </tr>
                );
              })}
              {manualFees.map((fee) => (
                <tr key={fee.id} className="hover:bg-[var(--border-hover)] transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Avatar name={fee.manual_name} size="sm" />
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
                    {fee.method || '-'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <RemoveManualFee id={fee.id} name={fee.manual_name} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {players.length === 0 && manualFees.length === 0 && (
          <p className="text-center text-[var(--text-muted)] py-8">No players owe fees for this season</p>
        )}
      </Card>
    </div>
  );
}
