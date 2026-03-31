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
    // Doubles registration requires admin for now
    return null;
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
        <Button onClick={handleRegister} loading={loading} size="sm">
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
        <Button onClick={handleCheckIn} loading={loading} size="sm">
          <CheckCircle className="w-3.5 h-3.5 mr-1.5" /> Check In
        </Button>
      )}
      {(regStatus === 'registered' || regStatus === 'checked_in') && eventStatus !== 'completed' && (
        <Button onClick={handleWithdraw} loading={loading} size="sm" variant="ghost">
          <UserMinus className="w-3.5 h-3.5 mr-1.5" /> Withdraw
        </Button>
      )}
    </div>
  );
}
