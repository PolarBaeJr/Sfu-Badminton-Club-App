import { Badge, Card, EmptyState, ResponsiveTable, TableCard, Atomic, AvatarChip } from '@badminton/ui';
import { createAdminClient } from '@/lib/supabase-server';
import { loadOutstandingMembers } from '@/lib/fee-submissions';
import { CardHeading } from './card-heading';
import { RemindButton } from './submission-actions';

// WHO STILL OWES, for the season in view (00248): roster dues and club-event
// lines, one row per member. A holder of fees.clubfees.markpaid.write gets the
// reminders, and only for the running season; a reminder is an in-app
// notification and nothing else.

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function remindedText(at: Date | null, now: Date): string | null {
  if (!at) return null;
  const days = Math.floor((now.getTime() - at.getTime()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'Reminded today';
  return `Reminded ${days} ${days === 1 ? 'day' : 'days'} ago`;
}

export async function OutstandingCard({
  season,
  canRemind,
}: {
  season: { id: string; name: string; active_flag: boolean; competitive_fee_cents: number; recreational_fee_cents: number };
  canRemind: boolean;
}) {
  const now = new Date();
  const members = await loadOutstandingMembers(createAdminClient(), season, now);
  const remindable = canRemind && season.active_flag;
  const due = members.filter((m) => m.decision.remind).map((m) => m.id);

  const state = (m: (typeof members)[number]) => {
    if (m.decision.remind === false && m.decision.reason === 'submitted') {
      return <Badge variant="neutral">Receipt sent</Badge>;
    }
    return <Badge variant="warning">Unpaid</Badge>;
  };
  const note = (m: (typeof members)[number]) => {
    const parts = [
      m.pending && m.decision.remind ? 'A receipt is waiting on one line' : null,
      remindedText(m.remindedAt, now),
    ].filter(Boolean);
    return parts.length ? parts.join(' · ') : null;
  };
  const remindOne = (m: (typeof members)[number]) =>
    remindable && m.decision.remind ? (
      <RemindButton playerIds={[m.id]} label="Remind" noun={m.fullName} />
    ) : null;

  return (
    <Card padding={false}>
      <CardHeading
        title="Outstanding"
        sub={`Dues and club events unpaid for ${season.name}. Receipts waiting for review are on the Submitted tab.`}
        action={
          remindable && due.length > 0 ? (
            <RemindButton
              playerIds={due}
              label="Remind unpaid"
              noun={`${due.length} ${due.length === 1 ? 'member' : 'members'}`}
            />
          ) : undefined
        }
      />
      {members.length === 0 ? (
        <EmptyState title="Nothing outstanding" description={`Nobody owes dues or event fees for ${season.name}.`} />
      ) : (
        <ResponsiveTable
          cards={members.map((m) => (
            <TableCard
              key={m.id}
              title={
                <div className="flex items-center gap-3">
                  <AvatarChip name={m.fullName} src={m.avatarUrl ?? undefined} size="sm" id={m.id} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-[var(--text-primary)]">{m.fullName}</p>
                    <p className="text-xs font-normal text-[var(--text-muted)]">{m.lines.map((l) => l.name).join(', ')}</p>
                  </div>
                </div>
              }
              value={<Atomic>{money(m.totalCents)}</Atomic>}
              badges={state(m)}
              fields={note(m) ? [{ label: 'Reminder', value: note(m) }] : undefined}
              actions={remindOne(m)}
            />
          ))}
        >
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--border)]">
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Member</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Owes for</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Amount</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Status</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {members.map((m) => (
                <tr key={m.id} className="hover:bg-[var(--border-hover)] transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <AvatarChip name={m.fullName} src={m.avatarUrl ?? undefined} size="sm" id={m.id} />
                      <div>
                        <p className="text-sm font-medium text-[var(--text-primary)]">{m.fullName}</p>
                        {m.email && <p className="text-xs text-[var(--text-muted)]">{m.email}</p>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">
                    {m.lines.map((l) => (
                      <span key={l.feeId ?? l.name} className="block">
                        {l.name}
                        {l.amountCents != null ? ` · ${money(l.amountCents)}` : ' · no amount'}
                        {l.pending ? ' · receipt sent' : ''}
                      </span>
                    ))}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Atomic className="font-mono text-[var(--text-primary)]">{money(m.totalCents)}</Atomic>
                  </td>
                  <td className="px-4 py-3">
                    {state(m)}
                    {note(m) && <p className="text-xs text-[var(--text-muted)] mt-1">{note(m)}</p>}
                  </td>
                  <td className="px-4 py-3 text-right">{remindOne(m)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ResponsiveTable>
      )}
    </Card>
  );
}
