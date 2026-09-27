import Link from 'next/link';
import { getPaymentPrompt } from '@/lib/member-fees';
import { money } from '@/lib/fees';

// "You have $X unpaid", on /feed and above the member section of /membership.
//
// The caller decides who sees it (an approved member, fees switch on); this
// decides what it says. getPaymentPrompt never throws, so a failed read
// renders nothing rather than breaking the page.
//
// `showSubmitted` is for /membership only: once every unpaid line has a
// receipt waiting, the feed goes quiet and the membership page says so.
export async function PaymentBanner({
  player,
  showSubmitted = false,
}: {
  player: { id: string; status?: string | null; is_exec?: boolean | null; fee_exempt?: boolean | null };
  showSubmitted?: boolean;
}) {
  const prompt = await getPaymentPrompt(player);

  if (prompt.kind === 'owing') {
    const amount =
      prompt.totalCents === 0 && prompt.unknownCount > 0 ? 'fees' : money(prompt.totalCents);
    return (
      <div
        className="card-base"
        role="status"
        style={{ marginBottom: 20, borderLeft: '3px solid var(--gold)' }}
      >
        <p style={{ fontSize: 14, lineHeight: 1.55, margin: 0 }}>
          You have {amount} unpaid. Pay and upload your receipt.{' '}
          <Link href="/membership#pay" className="fees-link">
            Pay now
          </Link>
        </p>
      </div>
    );
  }

  if (prompt.kind === 'submitted' && showSubmitted) {
    return (
      <div className="card-base" role="status" style={{ marginBottom: 20, borderLeft: '3px solid var(--line)' }}>
        <p className="muted" style={{ fontSize: 14, lineHeight: 1.55, margin: 0 }}>
          Receipt submitted, waiting for an exec to confirm.
        </p>
      </div>
    );
  }

  return null;
}
