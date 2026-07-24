'use client';
import { useState } from 'react';
import { checkInToSession } from '@/lib/actions';
import { CheckCircle2 } from 'lucide-react';
import { useToast } from '@/components/toast-provider';

interface CheckInButtonProps {
  sessionId: string;
  myStatus: 'checked_in' | 'present' | 'no_show' | 'excused' | null;
  canCheckIn: boolean;
  windowLabel?: string;
  myIntent?: 'going' | 'declined' | null;
}

export function CheckInButton({ sessionId, myStatus, canCheckIn, windowLabel, myIntent }: CheckInButtonProps) {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  if (myStatus === 'checked_in' || myStatus === 'present') {
    return (
      <span className="chip chip-success">
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
        {myStatus === 'present' ? 'Attended' : 'Checked In'}
      </span>
    );
  }

  if (myStatus === 'no_show') {
    return <span className="chip">No-show</span>;
  }

  if (myStatus === 'excused') {
    return <span className="chip">Excused</span>;
  }

  // Declined ("Not going") — don't offer check-in; the RSVP row keeps a way to
  // switch to Going.
  if (myIntent === 'declined') {
    return null;
  }

  // Check-in not open (and no attendance status to show) — render nothing
  // rather than a dead, disabled "Check-in closed" button.
  if (!canCheckIn) {
    return null;
  }

  async function handleCheckIn() {
    setLoading(true);
    try {
      const res = await checkInToSession(sessionId);
      if (!res.ok) {
        toast(res.error, 'error');
        setLoading(false);
      }
    } catch (err) {
      console.error(err);
      toast(err instanceof Error ? err.message : 'Failed to check in. Please try again.', 'error');
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleCheckIn}
      disabled={loading || !canCheckIn}
      className="press btn-primary-cta text-white rounded-xl px-4 py-2 text-sm font-semibold min-h-[44px] whitespace-nowrap disabled:opacity-60 disabled:cursor-not-allowed"
    >
      {!canCheckIn ? (windowLabel ?? 'Check-in closed') : loading ? 'Checking in...' : 'Check In'}
    </button>
  );
}
