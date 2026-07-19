'use client';

import { useState } from 'react';
import { Button } from '@badminton/ui';
import { registerForEvent, withdrawFromEvent, selfCheckIn } from '@/lib/tournament-actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { UserPlus, UserMinus, CheckCircle } from 'lucide-react';

interface Props {
  eventId: string;
  eventStatus: string;
  playerRegistration: {
    status: string;
  } | null;
  isDoubles: boolean;
  suspended?: boolean;
}

export function EventActions({ eventId, eventStatus, playerRegistration, isDoubles, suspended }: Props) {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  if (isDoubles) {
    if (playerRegistration) {
      return (
        <div className="flex items-center gap-2">
          <span
            className={`chip ${playerRegistration.status === 'checked_in' ? 'chip-success' : ''}`}
            style={playerRegistration.status !== 'checked_in' ? { borderColor: 'rgba(59,130,246,0.35)', background: 'rgba(59,130,246,0.1)', color: '#93C5FD' } : undefined}
            role="status"
          >
            <span className="sr-only">Registration status: </span>
            {playerRegistration.status === 'checked_in' ? '✓ Checked In' : 'Registered (Doubles)'}
          </span>
        </div>
      );
    }
    return (
      <p className="text-xs text-[var(--text-secondary)] italic">
        Doubles registration is managed by the tournament admin.
      </p>
    );
  }

  async function handleRegister() {
    setLoading(true);
    try {
      await registerForEvent(eventId);
      toast('Registered successfully!', 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to register', 'error');
    }
    setLoading(false);
  }

  async function handleWithdraw() {
    if (!confirm('Are you sure you want to withdraw from this event?')) return;
    setLoading(true);
    try {
      await withdrawFromEvent(eventId);
      toast('Withdrawn from event', 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to withdraw', 'error');
    }
    setLoading(false);
  }

  async function handleCheckIn() {
    setLoading(true);
    try {
      await selfCheckIn(eventId);
      toast('Checked in!', 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to check in', 'error');
    }
    setLoading(false);
  }

  if (!playerRegistration) {
    if (eventStatus === 'registration' && !suspended) {
      return (
        <Button
          onClick={handleRegister}
          loading={loading}
          size="sm"
          className="press min-h-[44px] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
        >
          <UserPlus className="w-3.5 h-3.5 mr-1.5" />
          Register
        </Button>
      );
    }
    return null;
  }

  const regStatus = playerRegistration.status;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {regStatus === 'registered' && eventStatus === 'checkin' && !suspended && (
        <Button
          onClick={handleCheckIn}
          loading={loading}
          size="sm"
          className="press min-h-[44px] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
        >
          <CheckCircle className="w-3.5 h-3.5 mr-1.5" />
          Check In
        </Button>
      )}
      {(regStatus === 'registered' || regStatus === 'checked_in') && eventStatus !== 'completed' && (
        <Button
          onClick={handleWithdraw}
          loading={loading}
          size="sm"
          variant="ghost"
          className="press min-h-[44px] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
        >
          <UserMinus className="w-3.5 h-3.5 mr-1.5" />
          Withdraw
        </Button>
      )}
    </div>
  );
}
