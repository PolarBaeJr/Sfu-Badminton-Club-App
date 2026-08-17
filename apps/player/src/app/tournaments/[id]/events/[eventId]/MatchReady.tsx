'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2 } from 'lucide-react';
import { setMyMatchReady } from '@/lib/tournament-actions';
import { useToast } from '@/components/toast-provider';

/**
 * THE CONTROL THAT USED TO BE A LABEL.
 *
 * The right-hand slot of a member's own match row printed the match status in a
 * bordered uppercase chip, so a match at 'ready' rendered a thing indistinguishable
 * from a READY button. The owner pressed it repeatedly and reported "it has never
 * worked". This is that press, wired.
 *
 * WHAT IT MEANS, and it is not the match's status: "I am standing here and I can
 * play now." The desk has no other way to find that out — today somebody shouts a
 * name across a gym and waits to see who looks up.
 *
 * FULL WIDTH AND 48px TALL. This is pressed one-handed, in a gym, by somebody
 * holding a racket. It is deliberately not a small right-aligned chip, which is
 * the mistake that started this.
 *
 * OPTIMISTIC, then reconciled. The tap flips the label immediately because the
 * round trip goes to a Pi over campus wifi; `router.refresh()` re-reads the truth
 * a moment later and the realtime channel would have brought it anyway. On a
 * refusal the local flip is rolled back and the reason is spoken, rather than the
 * button quietly returning to where it was — which is exactly how the original
 * label came to be described as broken.
 */
export function MatchReady({
  matchId,
  ready,
  partnerReady,
  isDoubles,
}: {
  matchId: string;
  /** Whether the viewer's own id is in the match's ready list. */
  ready: boolean;
  /**
   * DOUBLES ONLY, and null in singles. Whether the OTHER half of the viewer's
   * pair has said they are here — "you're here, your partner isn't" is the state
   * a member can actually do something about (ring them), so it is worth a line.
   */
  partnerReady: boolean | null;
  isDoubles: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  /**
   * The optimistic flip, held as null-when-absent rather than as a copy of the
   * prop. A plain `useState(ready)` would keep whatever it was initialised with
   * once the server value came back through the refresh, since state does not
   * re-derive from props; clearing to null hands the display back to the prop
   * the moment the truth arrives — including when the truth arrives because an
   * EXEC marked this member ready from the desk, which is a change this
   * component never made and must not fight.
   */
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const showing = optimistic ?? ready;

  function toggle() {
    const next = !showing;
    setOptimistic(next);
    startTransition(async () => {
      const res = await setMyMatchReady(matchId, next);
      if (!res.ok) {
        setOptimistic(null);
        toast(res.error, 'error');
        return;
      }
      router.refresh();
      setOptimistic(null);
    });
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        aria-pressed={showing}
        className={`w-full min-h-[48px] px-4 inline-flex items-center justify-center gap-2 border text-sm font-semibold uppercase tracking-wide transition-colors duration-150 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
          showing
            ? 'border-[var(--color-success)]/40 bg-[var(--color-success)]/12 text-[var(--color-success)]'
            : 'border-[var(--color-accent)]/45 bg-[var(--color-accent)]/10 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/16'
        }`}
      >
        {pending ? (
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
        ) : showing ? (
          <Check className="w-4 h-4" aria-hidden />
        ) : null}
        {showing ? "You're ready" : "I'm ready"}
      </button>
      {/* The undo, said out loud. A member who taps this and then leaves the
          hall has no reason to guess that pressing it again is allowed. */}
      <p className="mt-1.5 text-[11px] text-[var(--text-muted)]" role="status">
        {showing
          ? isDoubles && partnerReady === false
            ? 'The desk knows you are here. Your partner has not checked in yet — tap again if you step away.'
            : isDoubles && partnerReady
              ? 'You and your partner are both ready. Tap again if you step away.'
              : 'The desk knows you are here. Tap again if you step away.'
          : 'Tell the desk you are courtside and ready to play.'}
      </p>
    </div>
  );
}
