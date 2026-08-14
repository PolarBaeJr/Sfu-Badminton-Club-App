'use client';
import { useState } from 'react';
import { setSessionIntent } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { useStanding } from '@/components/standing-provider';

interface RsvpButtonsProps {
  sessionId: string;
  myIntent: 'going' | 'declined' | null;
  /**
   * Check-in is open for this session RIGHT NOW.
   *
   * When it is, the RSVP is largely spent: "Going" is a promise about a night
   * the member could simply check in to, and the check-in button is the thing
   * on the card the doorway queue is waiting for. So the pills demote to text
   * controls, and the bare "Going" action retires entirely — see the branch
   * below for why "Can't make it" does not.
   */
  demoted?: boolean;
}

// `rounded-xl` is deliberate-looking but compiles to nothing: tailwind.config
// zeroes the whole borderRadius scale for the sharp-cornered reference design.
// Left as-is rather than "fixed" to a literal radius — a rounded RSVP pill
// beside a square .session-card would be the odd one out.
const base = 'press rounded-xl px-4 py-2 text-sm font-semibold min-h-[44px] whitespace-nowrap disabled:opacity-60 disabled:cursor-not-allowed';
const inactive = 'bg-transparent border border-[var(--line)] text-[var(--text-muted)] opacity-70';

export function RsvpButtons({ sessionId, myIntent, demoted = false }: RsvpButtonsProps) {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const standing = useStanding();

  // setSessionIntent -> requirePlayer() refuses this outright, so drop the
  // buttons but keep whatever RSVP already exists on show — a member who was
  // going before being suspended should still see that they said so. The
  // schedule itself, and the one line explaining the missing buttons, are on
  // the page around us.
  if (!standing.ok) {
    if (myIntent === 'going') return <span className="chip chip-success">Going</span>;
    if (myIntent === 'declined') return <span className="chip">Not going</span>;
    return null;
  }

  async function choose(choice: 'going' | 'declined') {
    if (loading) return;
    const next = choice === myIntent ? null : choice;
    setLoading(true);
    try {
      const res = await setSessionIntent(sessionId, next);
      if (!res.ok) {
        toast(res.error, 'error');
        return;
      }
    } catch (err) {
      console.error(err);
      toast(err instanceof Error ? err.message : 'Failed to update your RSVP. Please try again.', 'error');
    } finally {
      // Unlike CheckInButton (which unmounts into a chip on success), this
      // component persists across the revalidate, so clear loading either way.
      setLoading(false);
    }
  }

  // The pill treatment while the night is still ahead; a quiet text control
  // once check-in has opened and the card already carries a primary. Both
  // clear the 44px floor — .sess-textlink sets its own min-height, which is
  // the point of demoting the LOOK rather than the size.
  const actionClass = demoted ? 'sess-textlink' : `${base} ${inactive}`;

  // Going — show the state and only the option to switch to Not going (the
  // "Going" action button is redundant once you're going).
  if (myIntent === 'going') {
    return (
      <div className="sess-rsvp">
        <span className="chip chip-success">Going</span>
        <button onClick={() => choose('declined')} disabled={loading} className={actionClass}>
          Can&apos;t make it
        </button>
      </div>
    );
  }

  // Declined ("Not going") — surface only the option to switch to Going; no
  // check-in and no other actions. This one survives demotion: with the intent
  // set to declined, CheckInButton returns null, so this button is the ONLY
  // way back into the night.
  if (myIntent === 'declined') {
    return (
      <div className="sess-rsvp">
        <span className="chip">Not going</span>
        <button onClick={() => choose('going')} disabled={loading} className={actionClass}>
          Going
        </button>
      </div>
    );
  }

  // No answer yet, and check-in is open. "Going" is dropped rather than
  // demoted: with a live check-in button an arm's length away, saying you
  // intend to come is a strictly weaker version of coming, and it was the
  // fifth control competing on this row. "Can't make it" stays because it is
  // the one thing check-in cannot express — it tells the exec to stop
  // expecting you, which nothing else on the card does.
  //
  // UNCONDITIONAL, and deliberately so. This used to make an exception for the
  // scan-required policy, on the reasoning that a member half an hour out could
  // no longer express "going" by simply checking in — check-in would need the
  // door code they are not yet standing at. The owner has overruled it: an open
  // check-in has no use for a bare "Going" button, because checking in already
  // flags both intent and attendance, and a control that appears on some nights
  // and not others is worse than one that is never there.
  //
  // The residual he accepted, written down so it is a decision rather than a
  // surprise: on a scan-required night a member who has not arrived cannot say
  // they are coming at all. The exec sees them when they walk in and scan.
  if (demoted) {
    return (
      <div className="sess-rsvp">
        <button onClick={() => choose('declined')} disabled={loading} className="sess-textlink">
          Can&apos;t make it
        </button>
      </div>
    );
  }

  return (
    <div className="sess-rsvp">
      <button onClick={() => choose('going')} disabled={loading} className={`${base} ${inactive}`}>
        Going
      </button>
      <button
        onClick={() => choose('declined')}
        disabled={loading}
        className={`${base} ${inactive}`}
      >
        Can&apos;t make it
      </button>
    </div>
  );
}
