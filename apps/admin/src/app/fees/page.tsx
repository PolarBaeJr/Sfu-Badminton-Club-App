import { createAdminClient } from '@/lib/supabase-server';
import { Badge, Card, Avatar } from '@badminton/ui';
import { unwrap } from '@badminton/shared';
import { PeriodSelector, FeeActions } from './fee-actions';

// Derive the current SFU term: Spring (Jan-Apr), Summer (May-Aug), Fall (Sep-Dec).
function currentPeriod(): string {
  const now = new Date();
  const month = now.getMonth();
  const term = month <= 3 ? 'Spring' : month <= 7 ? 'Summer' : 'Fall';
  return `${now.getFullYear()} ${term}`;
}

export default async function FeesPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const params = await searchParams;
  const period = params.period || currentPeriod();
  const supabase = createAdminClient();

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
      .select('player_id, amount_cents, paid_at, method')
      .eq('period', period)
  );
  const feeByPlayer = new Map(fees.map((f) => [f.player_id, f]));

  const paidCount = players.filter((p) => feeByPlayer.get(p.id)?.paid_at).length;
  const outstandingCount = players.length - paidCount;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold font-display text-[var(--text-primary)]">FEES</h1>
        <PeriodSelector period={period} />
      </div>

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
                      <FeeActions playerId={player.id} playerName={player.full_name} period={period} paid={paid} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {players.length === 0 && (
          <p className="text-center text-[var(--text-muted)] py-8">No players owe fees for this period</p>
        )}
      </Card>
    </div>
  );
}
