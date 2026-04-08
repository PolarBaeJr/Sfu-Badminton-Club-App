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

  if (isDoubles) {
    if (registration) {
      return (
        <span
          className={`chip ${registration.status === 'checked_in' ? 'chip-success' : 'chip-info'}`}
          role="status"
        >
          <span className="sr-only">Registration status: </span>
          {registration.status === 'checked_in' ? 'Checked In' : 'Registered'}
        </span>
      );
    }
    return (
      <span className="text-[10px] text-[var(--text-muted)] italic">
        Doubles — admin managed
      </span>
    );
  }

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
        <Button
          size="sm"
          loading={loading}
          onClick={() => act(() => registerForEvent(eventId), 'Registered!')}
          className="press focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none min-h-[36px]"
        >
          Register
        </Button>
      );
    }
    return null;
  }

  const s = registration.status;

  return (
    <div className="flex items-center gap-1.5" onClick={(e) => e.preventDefault()}>
      {s === 'registered' && eventStatus === 'checkin' && (
        <Button
          size="sm"
          loading={loading}
          onClick={() => act(() => selfCheckIn(eventId), 'Checked in!')}
          className="press focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none min-h-[36px]"
        >
          Check In
        </Button>
      )}
      {(s === 'registered' || s === 'checked_in') && eventStatus !== 'completed' && (
        <Button
          size="sm"
          variant="ghost"
          loading={loading}
          className="press focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none min-h-[36px]"
          onClick={() => {
            if (confirm('Are you sure you want to withdraw from this event?')) {
              act(() => withdrawFromEvent(eventId), 'Withdrawn');
            }
          }}
        >
          Withdraw
        </Button>
      )}
      {s === 'checked_in' && (
        <span className="chip chip-success" role="status">
          <span className="sr-only">Registration status: </span>Checked In
        </span>
      )}
      {s === 'registered' && eventStatus !== 'checkin' && (
        <span
          className="chip chip-info"
          role="status"
        >
          <span className="sr-only">Registration status: </span>Registered
        </span>
      )}
    </div>
  );
}
