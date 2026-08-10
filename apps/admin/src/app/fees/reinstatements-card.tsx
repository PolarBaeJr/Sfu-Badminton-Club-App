import { createAdminClient } from '@/lib/supabase-server';
import { Badge, Card, AvatarChip, EmptyState, ResponsiveTable, TableCard, Atomic } from '@badminton/ui';
import { unwrap, formatPaymentMethod } from '@badminton/shared';
import { RecordReinstatementPayment } from './fee-actions';

/**
 * Reinstatement payments, and the ones nobody has been able to write down.
 *
 * An exec may lift a ban but may not touch the ledger, so their unban files a
 * reinstatement_fees row with no amount and no paid_at. Before this section
 * existed there was no route back to that row at all — the member was no longer
 * banned, so the Unban dialog was gone, and 00065 forbids a second row for the
 * same ban. Whatever changed hands stayed off the books permanently.
 *
 * Its own component, rendered on /fees whether or not a season is active. The
 * rest of that page is meaningless without a season and bails out early — but a
 * lapsed member coming back BETWEEN terms is the ordinary case, not the odd one
 * (it is why reinstatement_fees.season_id is nullable, see 00069), and those are
 * exactly the rows that must not be hidden.
 */

const COLS = 'id, player_id, amount_cents, paid_at, method, reference, ban_reason, created_at, season_id';

/** Card identity line, matching the Player cell on the main fee table. */
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

export async function ReinstatementsCard({
  seasonId,
  canRead,
}: {
  seasonId: string | null;
  /**
   * May the viewer see the ROWS? False is a real state: recording a payment and
   * reading the ledger are separate capabilities, and a holder of only the write
   * used to get no card at all — the write was not merely blank, it was
   * unreachable.
   *
   * WHAT THAT HOLDER CAN AND CANNOT DO, said plainly because the answer is
   * awkward: recordReinstatementPayment takes the id of a ROW, and the only
   * place a row id comes from is this list. So the write genuinely needs the
   * read to be usable, and the honest card says so rather than showing a control
   * with nothing to point it at. The query is skipped either way — a row that
   * reaches this component reaches the RSC payload whether or not it is drawn.
   */
  canRead: boolean;
}) {
  const supabase = createAdminClient();

  if (!canRead) {
    return (
      <Card padding={false}>
        <div className="px-4 pt-4">
          <h2 className="text-sm font-medium text-[var(--text-primary)]">Reinstatements</h2>
        </div>
        <EmptyState
          title="Reinstatement payments are not shown to you"
          description="You can record a reinstatement payment, but it is recorded against the row it belongs to — and those rows are not yours to see."
        />
      </Card>
    );
  }

  // Three narrow queries merged in JS rather than one `.or()`: this season's
  // rows, every row whose amount was never recorded, and every row attached to
  // no season. The last two are the ones that would otherwise disappear —
  // an unrecorded payment is the whole point of the section, and a row recorded
  // while the club was between terms belongs to no season's income and would be
  // findable nowhere else.
  const queries = [
    supabase.from('reinstatement_fees').select(COLS).is('amount_cents', null),
    supabase.from('reinstatement_fees').select(COLS).is('season_id', null),
  ];
  if (seasonId) queries.push(supabase.from('reinstatement_fees').select(COLS).eq('season_id', seasonId));

  const results = await Promise.all(queries);
  const rows = results
    .flatMap((r) => unwrap(r))
    .filter((row, i, all) => all.findIndex((r) => r.id === row.id) === i)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  if (rows.length === 0) return null;

  const playerIds = [...new Set(rows.map((r) => r.player_id))];
  const people = unwrap(
    await supabase.from('players').select('id, full_name, email, avatar_url').in('id', playerIds)
  );
  const personById = new Map(people.map((p) => [p.id, p]));

  const nameOf = (playerId: string) => personById.get(playerId)?.full_name ?? 'Former member';
  const isRecorded = (fee: { amount_cents: number | null }) => fee.amount_cents != null;
  const money = (cents: number | null) => (cents == null ? '-' : `$${(cents / 100).toFixed(2)}`);

  return (
    <Card padding={false}>
      <div className="px-4 pt-4">
        <h2 className="text-sm font-medium text-[var(--text-primary)]">Reinstatements</h2>
        <p className="text-xs text-[var(--text-muted)]">
          Bans lifted this season, and any reinstatement whose payment has not been recorded yet.
        </p>
      </div>
      <ResponsiveTable
        cards={rows.map((fee) => (
          <TableCard
            key={fee.id}
            title={personTitle(
              nameOf(fee.player_id),
              fee.ban_reason ?? 'Reinstated',
              personById.get(fee.player_id)?.avatar_url,
              fee.player_id,
            )}
            value={money(fee.amount_cents)}
            badges={
              <Badge variant={isRecorded(fee) ? 'success' : 'warning'}>
                {isRecorded(fee) ? 'Recorded' : 'Not recorded'}
              </Badge>
            }
            fields={[
              { label: 'Method', value: fee.method ? formatPaymentMethod(fee.method) : '-' },
              { label: 'Reference', value: fee.reference ? <Atomic className="font-mono text-xs">{fee.reference}</Atomic> : '-' },
            ]}
            actions={
              isRecorded(fee) ? null : (
                <RecordReinstatementPayment feeId={fee.id} playerName={nameOf(fee.player_id)} />
              )
            }
          />
        ))}
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
            {rows.map((fee) => (
              <tr key={fee.id} className="hover:bg-[var(--border-hover)] transition-colors">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <AvatarChip name={nameOf(fee.player_id)} src={personById.get(fee.player_id)?.avatar_url} size="sm" id={fee.player_id} />
                    <div>
                      <p className="text-sm font-medium text-[var(--text-primary)]">{nameOf(fee.player_id)}</p>
                      <p className="text-xs text-[var(--text-muted)]">{fee.ban_reason ?? 'Reinstated'}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <Badge variant={isRecorded(fee) ? 'success' : 'warning'}>
                    {isRecorded(fee) ? 'Recorded' : 'Not recorded'}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  <span className="font-mono text-[var(--text-primary)]">{money(fee.amount_cents)}</span>
                </td>
                <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">
                  {fee.method ? formatPaymentMethod(fee.method) : '-'}
                  {fee.reference && (
                    <span className="block font-mono text-xs text-[var(--text-muted)]">{fee.reference}</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  {!isRecorded(fee) && (
                    <RecordReinstatementPayment feeId={fee.id} playerName={nameOf(fee.player_id)} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ResponsiveTable>
    </Card>
  );
}
