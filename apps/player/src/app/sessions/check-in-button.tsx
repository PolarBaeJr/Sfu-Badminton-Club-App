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
      <span className="chip chip-success">
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
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
      className="press gradient-court text-[#0A0A0A] rounded-lg px-4 py-2 text-sm font-semibold min-h-[44px] disabled:opacity-60 disabled:cursor-not-allowed transition-opacity"
    >
      {loading ? 'Checking in...' : 'Check In'}
    </button>
  );
}
