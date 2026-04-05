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
}

export function EventActions({ eventId, eventStatus, playerRegistration, isDoubles }: Props) {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  if (isDoubles) {
    if (playerRegistration) {
      return (
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-[#3B82F6]/15 text-[#3B82F6]" role="status">
            <span className="sr-only">Registration status: </span>{playerRegistration.status === 'checked_in' ? '\u2713 Checked In' : 'Registered (Doubles)'}
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
    // Not registered
    if (eventStatus === 'registration') {
      return (
        <Button onClick={handleRegister} loading={loading} size="sm" className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none">
          <UserPlus className="w-3.5 h-3.5 mr-1.5" /> Register
        </Button>
      );
    }
    return null;
  }

  const regStatus = playerRegistration.status;

  return (
    <div className="flex items-center gap-2">
      {regStatus === 'registered' && eventStatus === 'checkin' && (
        <Button onClick={handleCheckIn} loading={loading} size="sm" className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none">
          <CheckCircle className="w-3.5 h-3.5 mr-1.5" /> Check In
        </Button>
      )}
      {(regStatus === 'registered' || regStatus === 'checked_in') && eventStatus !== 'completed' && (
        <Button onClick={handleWithdraw} loading={loading} size="sm" variant="ghost" className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none">
          <UserMinus className="w-3.5 h-3.5 mr-1.5" /> Withdraw
        </Button>
      )}
    </div>
  );
}
