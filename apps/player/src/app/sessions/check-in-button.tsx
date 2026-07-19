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
}

export function CheckInButton({ sessionId, myStatus, canCheckIn, windowLabel }: CheckInButtonProps) {
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

  async function handleCheckIn() {
    setLoading(true);
    try {
      await checkInToSession(sessionId);
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
      className="press btn-primary-cta text-white rounded-full px-4 py-2 text-sm font-semibold min-h-[44px] disabled:opacity-60 disabled:cursor-not-allowed"
    >
      {!canCheckIn ? (windowLabel ?? 'Check-in closed') : loading ? 'Checking in...' : 'Check In'}
    </button>
  );
}
