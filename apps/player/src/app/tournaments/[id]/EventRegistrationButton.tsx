'use client';

import { useState } from 'react';
import { Button } from '@badminton/ui';
import { registerForEvent, withdrawFromEvent, selfCheckIn } from '@/lib/tournament-actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';

interface Props {
  eventId: string;
  eventStatus: string;
  registration: { status: string } | null;
  isDoubles: boolean;
}

export function EventRegistrationButton({ eventId, eventStatus, registration, isDoubles }: Props) {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  if (isDoubles) return null;

  async function act(fn: () => Promise<void>, msg: string) {
    setLoading(true);
    try {
      await fn();
      toast(msg, 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  if (!registration) {
    if (eventStatus === 'registration') {
      return (
        <Button size="sm" loading={loading} onClick={() => act(() => registerForEvent(eventId), 'Registered!')}>
          Register
        </Button>
      );
    }
    return null;
  }

  const s = registration.status;

  return (
    <div className="flex gap-1.5" onClick={(e) => e.preventDefault()}>
      {s === 'registered' && eventStatus === 'checkin' && (
        <Button size="sm" loading={loading} onClick={() => act(() => selfCheckIn(eventId), 'Checked in!')}>
          Check In
        </Button>
      )}
      {(s === 'registered' || s === 'checked_in') && eventStatus !== 'completed' && (
        <Button size="sm" variant="ghost" loading={loading} onClick={() => act(() => withdrawFromEvent(eventId), 'Withdrawn')}>
          Withdraw
        </Button>
      )}
      {s === 'checked_in' && (
        <span className="text-[10px] font-semibold px-2 py-1 rounded-full bg-[#22C55E]/15 text-[#22C55E] self-center">
          Checked In
        </span>
      )}
      {s === 'registered' && eventStatus !== 'checkin' && (
        <span className="text-[10px] font-semibold px-2 py-1 rounded-full bg-[#3B82F6]/15 text-[#3B82F6] self-center">
          Registered
        </span>
      )}
    </div>
  );
}
