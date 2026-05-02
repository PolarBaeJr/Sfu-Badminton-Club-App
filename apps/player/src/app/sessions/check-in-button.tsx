'use client';
import { useState } from 'react';
import { checkInToSession } from '@/lib/actions';
import { CheckCircle2 } from 'lucide-react';
import { useToast } from '@/components/toast-provider';

interface CheckInButtonProps {
  sessionId: string;
  isCheckedIn: boolean;
}

export function CheckInButton({ sessionId, isCheckedIn }: CheckInButtonProps) {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  if (isCheckedIn) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-[0.06em] bg-[var(--bg-accent)] text-[var(--accent)] border border-[var(--accent-border)]">
        <CheckCircle2 className="w-3 h-3 shrink-0" />
        Checked In
      </span>
    );
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
      disabled={loading}
      className="press btn-primary-cta px-4 py-2 text-sm font-semibold min-h-[44px] disabled:opacity-60 disabled:cursor-not-allowed"
    >
      {loading ? 'Checking in...' : 'Check In'}
    </button>
  );
}
