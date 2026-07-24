'use client';
import { useState } from 'react';
import { setSessionIntent } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';

interface RsvpButtonsProps {
  sessionId: string;
  myIntent: 'going' | 'declined' | null;
}

const base = 'press rounded-xl px-4 py-2 text-sm font-semibold min-h-[44px] whitespace-nowrap disabled:opacity-60 disabled:cursor-not-allowed';
const goingActive = 'btn-primary-cta text-white';
const declinedActive = 'bg-[var(--bg-card)] border border-[var(--line)] text-[var(--text-muted)]';
const inactive = 'bg-transparent border border-[var(--line)] text-[var(--text-muted)] opacity-70';

export function RsvpButtons({ sessionId, myIntent }: RsvpButtonsProps) {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

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

  // Going — show the state and only the option to switch to Not going (the
  // "Going" action button is redundant once you're going).
  if (myIntent === 'going') {
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="chip chip-success">Going</span>
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

  // Declined ("Not going") — surface only the option to switch to Going; no
  // check-in and no other actions.
  if (myIntent === 'declined') {
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="chip">Not going</span>
        <button
          onClick={() => choose('going')}
          disabled={loading}
          className={`${base} ${inactive}`}
        >
          Going
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button
        onClick={() => choose('going')}
        disabled={loading}
        className={`${base} ${myIntent === 'going' ? goingActive : inactive}`}
      >
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
