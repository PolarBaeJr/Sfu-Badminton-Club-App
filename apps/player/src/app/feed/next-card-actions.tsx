'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { acceptChallenge, rejectChallenge } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';

/**
 * Desktop /feed Next Challenge accept / decline actions. Renders the design's
 * text-button pair (.d-btn-red Accept + .d-btn-ghost Decline) — distinct from
 * the icon-button incoming-pending mode in challenges/inline-actions.tsx,
 * which is sized for the mobile cards.
 *
 * Decline uses the standard 2-tap confirm guard (first tap arms, second tap
 * commits) so a stray click on the dashboard doesn't reject a real challenge.
 */
export function NextCardActions({ challengeId }: { challengeId: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, setPending] = useState<'accept' | 'reject' | null>(null);
  const [armDecline, setArmDecline] = useState(false);

  async function run(label: 'accept' | 'reject', fn: () => Promise<unknown>, msg: string) {
    setPending(label);
    setArmDecline(false);
    try {
      await fn();
      toast(msg, 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
      setPending(null);
    }
    // Leave `pending` set on success — the parent re-renders without this card.
  }

  return (
    <>
      <button
        type="button"
        className="d-btn d-btn-red"
        disabled={pending !== null}
        onClick={() =>
          void run('accept', () => acceptChallenge(challengeId), 'Challenge accepted')
        }
      >
        {pending === 'accept' ? 'Accepting…' : 'Accept'}
      </button>
      <button
        type="button"
        className="d-btn d-btn-ghost"
        disabled={pending !== null}
        onClick={() => {
          if (!armDecline) {
            setArmDecline(true);
            return;
          }
          void run('reject', () => rejectChallenge(challengeId), 'Challenge declined');
        }}
      >
        {pending === 'reject' ? 'Declining…' : armDecline ? 'Tap to confirm' : 'Decline'}
      </button>
    </>
  );
}
