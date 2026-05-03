'use client';
import { useState } from 'react';
import { checkInToSession } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';

interface CheckInButtonProps {
  sessionId: string;
  isCheckedIn: boolean;
}

export function CheckInButton({ sessionId, isCheckedIn }: CheckInButtonProps) {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

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

  if (isCheckedIn) {
    return (
      <button
        type="button"
        disabled
        style={{
          height: 36,
          padding: '0 16px',
          background: 'transparent',
          color: 'var(--green)',
          border: '1px solid var(--green)',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '1.4px',
          textTransform: 'uppercase',
          cursor: 'default',
          fontFamily: 'inherit',
        }}
      >
        ✓ Going
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleCheckIn}
      disabled={loading}
      style={{
        height: 36,
        padding: '0 16px',
        background: 'var(--red)',
        color: '#F2F2F2',
        border: 'none',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '1.4px',
        textTransform: 'uppercase',
        cursor: loading ? 'not-allowed' : 'pointer',
        opacity: loading ? 0.6 : 1,
        fontFamily: 'inherit',
      }}
    >
      {loading ? 'RSVP…' : 'RSVP'}
    </button>
  );
}
