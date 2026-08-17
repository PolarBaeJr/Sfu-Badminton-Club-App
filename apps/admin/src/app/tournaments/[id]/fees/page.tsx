import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { Card, Badge, AvatarChip, PageHeader, ResponsiveTable, TableCard } from '@badminton/ui';
import { unwrap, quoteEntryFee } from '@badminton/shared';
import { isWaivedFee } from '@/lib/fee-status';
import type { TournamentFeeTier, ClubFee, Player, MembershipType } from '@badminton/shared';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { TournamentFeeActions } from './tournament-fee-actions';

/** Card identity line: the same avatar + name + email the Player cell shows. */
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

export default async function TournamentFeesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Entry money is its own capability, in nobody's baseline — defence in depth
  // beyond the middleware gate, which asks the same question about the route.
  await requireCapability('tournaments.fees.read');
  const supabase = createAdminClient();

  const { data: tournament } = await supabase.from('tournaments').select('id, name').eq('id', id).single();
  if (!tournament) notFound();

  const tiers = unwrap(
    await supabase
      .from('tournament_fee_tiers')
      .select('id, tournament_id, name, amount_cents, is_default, sort_order, applies_to, created_at')
      .eq('tournament_id', id)
      .order('sort_order')
  ) as TournamentFeeTier[];
  const tierById = new Map(tiers.map((t) => [t.id, t]));

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

  const liveEntrants = new Set(playerIds);

  // Entry fees off the club's one ledger (00094), which is also where the
  // /fees page and the member's own screen read them — so "who has paid for
  // this tournament" and "what does this member owe" can no longer disagree.
  // fee_type is not optional: without it this reads every member's dues and
  // every reinstatement in the club through a capability that buys neither.
  const fees = unwrap(
    await supabase
      .from('club_fees')
      .select('player_id, tier_id, amount_cents, paid_at, method')
      .eq('tournament_id', id)
      .eq('fee_type', 'tournament')
  ) as Pick<ClubFee, 'player_id' | 'tier_id' | 'amount_cents' | 'paid_at' | 'method'>[];
  const feeByPlayer = new Map(fees.map((f) => [f.player_id, f]));

  // WHO IS ON THIS PAGE: everyone currently entered, PLUS everyone who has a
  // fee row for this tournament whether or not they still are.
  //
  // The second half is not tidiness. Self-withdrawal is allowed right up until
  // the draw is published, and a withdrawal does not cancel the fee — an entry
  // that was made is a fact, and a ledger that deletes its own rows when
  // somebody changes their mind cannot be reconciled. The member's own /fees
  // screen reads the ledger and shows it, so a row this page hid would be money
  // one side could see and the other side could not settle. The exemptions are
  // applied the same way and for the same reason: an entrant promoted to exec
  // after entering keeps the fee they already owe.
  for (const fee of fees) playerIds.add(fee.player_id as string);

  const roster = playerIds.size > 0
    ? (unwrap(
        await supabase
          .from('players')
          // membership_type is what DECIDES the price (00094): the tiers name
          // membership groups, and selectFeeTier reads this column to pick one.
          // Without it every row on this page — and every dialog opened from one
          // — falls back to the tournament's default tier, which on the live
          // tournament is the $25 External price for members who owe $15.
          .select('id, full_name, email, avatar_url, is_exec, fee_exempt, membership_type')
          .in('id', Array.from(playerIds))
          .order('full_name')
      ) as (Pick<Player, 'id' | 'full_name' | 'email' | 'avatar_url'> & {
        is_exec: boolean; fee_exempt: boolean; membership_type: MembershipType | null;
      })[])
    : [];
  const players = roster.filter(
    (p) => feeByPlayer.has(p.id) || (!p.is_exec && !p.fee_exempt),
  );

  // WAIVED IS NOT PAID, and this page was the last fee surface in the app that
  // said otherwise — a waiver is stored as a paid row with amount_cents 0 and
  // method 'waived' (fee-status.ts), so `Boolean(paid_at)` rendered a green
  // "Paid · $0.00" for a fee the club deliberately wrote off. /admin/fees and
  // the member's own screen have both read it correctly for a while; this now
  // agrees with them.
  const stateOf = (fee?: { paid_at: string | null; method: string | null }) => {
    const waived = isWaivedFee(fee);
    return { waived, paid: Boolean(fee?.paid_at) && !waived };
  };

  const paidCount = players.filter((p) => stateOf(feeByPlayer.get(p.id)).paid).length;
  const waivedCount = players.filter((p) => stateOf(feeByPlayer.get(p.id)).waived).length;
  const outstandingCount = players.length - paidCount - waivedCount;

  return (
    <div className="space-y-6">
      <Link href={`/tournaments/${id}`} className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--color-accent)] transition-colors rounded">
        <ArrowLeft className="w-4 h-4" />
        Back to Tournament
      </Link>

      <PageHeader className="no-period" title={`${tournament.name} — Fees`} watermark="F" />

      <TournamentFeeActions mode="tiers" tournamentId={id} tiers={tiers} />

      {/* Summary */}
      {/* Paid + Waived + Outstanding = the rows in the table below, by
          construction — Outstanding is the remainder rather than its own test,
          the same shape /admin/fees uses. Waived appears only when the club has
          actually waived somebody. */}
      <div className={`grid gap-4 ${waivedCount > 0 ? 'grid-cols-3' : 'grid-cols-2'}`}>
        <Card>
          <p className="text-xs text-[var(--text-muted)] uppercase">Paid</p>
          <p className="text-2xl font-bold font-mono text-[var(--color-success)]">{paidCount}</p>
        </Card>
        <Card>
          <p className="text-xs text-[var(--text-muted)] uppercase">Outstanding</p>
          {/* Amber only when there is something to act on. A permanently amber
              zero trains people to ignore the colour that matters. */}
          <p className={`text-2xl font-bold font-mono ${outstandingCount > 0 ? 'text-[var(--color-warning)]' : ''}`}>
            {outstandingCount}
          </p>
        </Card>
        {waivedCount > 0 && (
          <Card>
            <p className="text-xs text-[var(--text-muted)] uppercase">Waived</p>
            <p className="text-2xl font-bold font-mono">{waivedCount}</p>
          </Card>
        )}
      </div>

      {/* Fee Table */}
      <Card padding={false}>
        <ResponsiveTable
          cards={players.map((player) => {
            const fee = feeByPlayer.get(player.id);
            const { paid, waived } = stateOf(fee);
            // ONE DERIVATION, shared with the dialog this row opens. The old
            // fallback was the tournament's default tier regardless of who the
            // member is; quoteEntryFee asks selectFeeTier, which is the rule the
            // fee was actually written by.
            const quote = quoteEntryFee(player.membership_type, tiers, fee);
            const tier = quote.tierId ? tierById.get(quote.tierId) : null;
            const owedCents = quote.amountCents;
            return (
              <TableCard
                key={player.id}
                title={personTitle(
                  player.full_name,
                  // Says WHY somebody with no live entry is on the list, rather
                  // than leaving an exec to wonder.
                  liveEntrants.has(player.id) ? player.email ?? '' : 'Withdrawn · fee still on the books',
                  player.avatar_url,
                  player.id,
                )}
                value={owedCents != null ? `$${(owedCents / 100).toFixed(2)}` : '-'}
                badges={
                  <Badge variant={paid ? 'success' : waived ? 'neutral' : 'warning'}>
                    {paid ? 'Paid' : waived ? 'Waived' : 'Unpaid'}
                  </Badge>
                }
                fields={[
                  { label: 'Tier', value: tier?.name ?? '-' },
                  { label: 'Method', value: (paid && fee?.method) || '-' },
                ]}
                actions={
                  <TournamentFeeActions
                    mode="mark"
                    tournamentId={id}
                    playerId={player.id}
                    playerName={player.full_name}
                    tiers={tiers}
                    paid={paid}
                    membershipType={player.membership_type}
                    fee={fee ?? null}
                  />
                }
              />
            );
          })}
        >
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
                const { paid, waived } = stateOf(fee);
                // Same derivation as the card above — see the note there.
                const quote = quoteEntryFee(player.membership_type, tiers, fee);
                const tier = quote.tierId ? tierById.get(quote.tierId) : null;
                const owedCents = quote.amountCents;
                return (
                  <tr key={player.id} className="hover:bg-[var(--border-hover)] transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <AvatarChip name={player.full_name} src={player.avatar_url} size="sm" id={player.id} />
                        <div>
                          <p className="text-sm font-medium text-[var(--text-primary)]">{player.full_name}</p>
                          <p className="text-xs text-[var(--text-muted)]">
                            {liveEntrants.has(player.id) ? player.email : 'Withdrawn · fee still on the books'}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={paid ? 'success' : waived ? 'neutral' : 'warning'}>
                        {paid ? 'Paid' : waived ? 'Waived' : 'Unpaid'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">
                      {tier?.name ?? '-'}
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
                        membershipType={player.membership_type}
                        fee={fee ?? null}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ResponsiveTable>
        {players.length === 0 && (
          <p className="text-center text-[var(--text-muted)] py-8">No players owe fees for this tournament</p>
        )}
      </Card>
    </div>
  );
}
