'use client';
import { useState } from 'react';
import { checkInToSession } from '@/lib/actions';
import { CheckCircle2 } from 'lucide-react';

interface CheckInButtonProps {
  sessionId: string;
  isCheckedIn: boolean;
}

export function CheckInButton({ sessionId, isCheckedIn }: CheckInButtonProps) {
  const [loading, setLoading] = useState(false);

  if (isCheckedIn) {
    return (
      <span className="inline-flex items-center gap-1.5 bg-emerald-500/10 text-emerald-400 text-xs font-semibold px-3 py-1.5 rounded-lg">
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
      alert(err instanceof Error ? err.message : 'Failed to check in. Please try again.');
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleCheckIn}
      disabled={loading}
      className="bg-[#EF4444] text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60 disabled:cursor-not-allowed transition-opacity"
    >
      {loading ? 'Checking in...' : 'Check In'}
    </button>
  );
}
