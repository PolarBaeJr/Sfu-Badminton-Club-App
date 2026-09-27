import { formatPaymentMethod } from '@badminton/shared';
import { Badge, Card, EmptyState, ResponsiveTable, TableCard, Atomic } from '@badminton/ui';
import { createAdminClient } from '@/lib/supabase-server';
import { loadPendingSubmissions } from '@/lib/fee-submissions';
import { CardHeading } from './card-heading';
import { SubmissionActions } from './submission-actions';

// PAYMENT RECEIPTS WAITING FOR AN EXEC (00248, 00253): dues and club events,
// oldest first. "Paid by" is what the member's browser read off the receipt;
// Unclear when it could not tell, and confirming then asks. Rendered only for a holder of fees.clubfees.markpaid.write,
// the capability that settles them; tournament entries are on their own page.

const money = (cents: number | null) => (cents != null ? `$${(cents / 100).toFixed(2)}` : 'No amount');

const paidBy = (method: string | null) =>
  method ? formatPaymentMethod(method) : <Badge variant="warning">Unclear</Badge>;

export async function SubmittedCard() {
  const submissions = await loadPendingSubmissions(createAdminClient(), 'club');

  return (
    <Card padding={false}>
      <CardHeading
        title="Submitted receipts"
        sub="Receipts members sent for an e-transfer or an SFU Rec purchase. Check each against the club account or SFU Rec, then confirm or reject it."
      />
      {submissions.length === 0 ? (
        <EmptyState title="Nothing waiting" description="No member has a receipt waiting for review." />
      ) : (
        <ResponsiveTable
          cards={submissions.map((s) => (
            <TableCard
              key={s.id}
              title={
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--text-primary)]">{s.playerName}</p>
                  <p className="text-xs font-normal text-[var(--text-muted)]">{s.line}</p>
                </div>
              }
              value={<Atomic>{money(s.amountCents)}</Atomic>}
              badges={s.withdrawn ? <Badge variant="warning">Withdrawn</Badge> : undefined}
              fields={[
                { label: 'Paid by', value: paidBy(s.method) },
                { label: 'Reference', value: <Atomic className="font-mono text-xs">{s.reference}</Atomic> },
                { label: 'Sent', value: new Date(s.submittedAt).toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' }) },
              ]}
              actions={
                <SubmissionActions
                  submissionId={s.id}
                  memberName={s.playerName}
                  line={s.line}
                  amount={money(s.amountCents)}
                  reference={s.reference}
                  proofHref={s.hasScreenshot ? `/fees/proof/${s.id}` : null}
                  method={s.method}
                  feeType={s.feeType}
                />
              }
            />
          ))}
        >
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--border)]">
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Member</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">For</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Amount</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Paid by</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Reference</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Sent</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {submissions.map((s) => (
                <tr key={s.id} className="hover:bg-[var(--border-hover)] transition-colors">
                  <td className="px-4 py-3">
                    <p className="text-sm font-medium text-[var(--text-primary)]">{s.playerName}</p>
                    {s.playerEmail && <p className="text-xs text-[var(--text-muted)]">{s.playerEmail}</p>}
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">
                    {s.line}
                    {/* The member left the event after sending this. The fee
                        was kept because money may have moved: an exec's call. */}
                    {s.withdrawn && (
                      <span className="ml-2">
                        <Badge variant="warning">Withdrawn</Badge>
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Atomic className="font-mono text-[var(--text-primary)]">{money(s.amountCents)}</Atomic>
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">{paidBy(s.method)}</td>
                  <td className="px-4 py-3">
                    <Atomic className="font-mono text-xs">{s.reference}</Atomic>
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">
                    {new Date(s.submittedAt).toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' })}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <SubmissionActions
                      submissionId={s.id}
                      memberName={s.playerName}
                      line={s.line}
                      amount={money(s.amountCents)}
                      reference={s.reference}
                      proofHref={s.hasScreenshot ? `/fees/proof/${s.id}` : null}
                      method={s.method}
                      feeType={s.feeType}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ResponsiveTable>
      )}
    </Card>
  );
}
