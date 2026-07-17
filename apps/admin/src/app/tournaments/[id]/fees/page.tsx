import { createAdminClient } from '@/lib/supabase-server';
import { Card, Badge, Avatar } from '@badminton/ui';
import { unwrap } from '@badminton/shared';
import type { TournamentFeeTier, TournamentFee, Player } from '@badminton/shared';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { TournamentFeeActions } from './tournament-fee-actions';

export default async function TournamentFeesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = createAdminClient();

  const { data: tournament } = await supabase.from('tournaments').select('id, name').eq('id', id).single();
  if (!tournament) notFound();

  const tiers = unwrap(
    await supabase
      .from('tournament_fee_tiers')
      .select('id, tournament_id, name, amount_cents, is_default, sort_order, created_at')
      .eq('tournament_id', id)
      .order('sort_order')
  ) as TournamentFeeTier[];
  const tierById = new Map(tiers.map((t) => [t.id, t]));
  const defaultTier = tiers.find((t) => t.is_default) ?? null;

  // Owed list: every player entered in any of this tournament's events, from
  // both singles participants and doubles pairs, excluding withdrawn entries.
  const events = unwrap(
    await supabase.from('tournament_events').select('id').eq('tournament_id', id)
  );
  const eventIds = events.map((e) => e.id);

  const playerIds = new Set<string>();
  if (eventIds.length > 0) {
    const [participants, pairs] = await Promise.all([
      supabase
        .from('tournament_participants')
        .select('player_id')
        .in('event_id', eventIds)
        .neq('status', 'withdrawn'),
      supabase
        .from('tournament_pairs')
        .select('player1_id, player2_id')
        .in('event_id', eventIds)
        .neq('status', 'withdrawn'),
    ]);
    for (const row of participants.data ?? []) playerIds.add(row.player_id);
    for (const row of pairs.data ?? []) {
      playerIds.add(row.player1_id);
      playerIds.add(row.player2_id);
    }
  }

  const players = playerIds.size > 0
    ? (unwrap(
        await supabase
          .from('players')
          .select('id, full_name, email, avatar_url')
          .in('id', Array.from(playerIds))
          .eq('is_exec', false)
          .eq('fee_exempt', false)
          .order('full_name')
      ) as Pick<Player, 'id' | 'full_name' | 'email' | 'avatar_url'>[])
    : [];

  const fees = unwrap(
    await supabase
      .from('tournament_fees')
      .select('player_id, tier_id, amount_cents, paid_at, method')
      .eq('tournament_id', id)
  ) as Pick<TournamentFee, 'player_id' | 'tier_id' | 'amount_cents' | 'paid_at' | 'method'>[];
  const feeByPlayer = new Map(fees.map((f) => [f.player_id, f]));

  const paidCount = players.filter((p) => feeByPlayer.get(p.id)?.paid_at).length;
  const outstandingCount = players.length - paidCount;

  return (
    <div className="space-y-6">
      <Link href={`/tournaments/${id}`} className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--color-accent)] transition-colors rounded">
        <ArrowLeft className="w-4 h-4" />
        Back to Tournament
      </Link>

      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold font-display text-[var(--text-primary)]">{tournament.name} — Fees</h1>
      </div>

      <TournamentFeeActions mode="tiers" tournamentId={id} tiers={tiers} />

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
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Tier</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Amount</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Method</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {players.map((player) => {
                const fee = feeByPlayer.get(player.id);
                const paid = Boolean(fee?.paid_at);
                const tier = fee?.tier_id ? tierById.get(fee.tier_id) : null;
                const owedCents = fee?.amount_cents ?? defaultTier?.amount_cents ?? null;
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
                    <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">
                      {tier?.name ?? defaultTier?.name ?? '-'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="font-mono text-[var(--text-primary)]">
                        {owedCents != null ? `$${(owedCents / 100).toFixed(2)}` : '-'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">
                      {(paid && fee?.method) || '-'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <TournamentFeeActions
                        mode="mark"
                        tournamentId={id}
                        playerId={player.id}
                        playerName={player.full_name}
                        tiers={tiers}
                        paid={paid}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {players.length === 0 && (
          <p className="text-center text-[var(--text-muted)] py-8">No players owe fees for this tournament</p>
        )}
      </Card>
    </div>
  );
}
