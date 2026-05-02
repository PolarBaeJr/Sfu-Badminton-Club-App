'use client';

import { useState } from 'react';
import { Button } from '@badminton/ui';
import { selfCheckIn } from '@/lib/tournament-actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { CheckCircle, XCircle, AlertTriangle } from 'lucide-react';
import Link from 'next/link';

interface Props {
  eventId: string;
  tournamentId: string;
  eventStatus: string;
  registration: { id: string; status: string } | null;
  playerName: string;
}

export function SelfCheckInClient({ eventId, tournamentId, eventStatus, registration, playerName }: Props) {
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  async function handleCheckIn() {
    setLoading(true);
    try {
      await selfCheckIn(eventId);
      setSuccess(true);
      toast('Checked in successfully!', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Check-in failed', 'error');
    }
    setLoading(false);
  }

  const backLink = `/tournaments/${tournamentId}/events/${eventId}`;

  if (success) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-5 text-center px-6 pb-28">
        <div className="w-20 h-20 rounded-full bg-[var(--color-success)]/15 flex items-center justify-center glow-soft">
          <CheckCircle className="w-10 h-10 text-[var(--color-success)]" />
        </div>
        <div>
          <p className="eyebrow mb-1">Success</p>
          <h1 className="display-lg">You&apos;re In!</h1>
          <p className="text-[var(--text-muted)] text-sm mt-1">{playerName}</p>
        </div>
        <Link
          href={backLink}
          className="press inline-flex items-center gap-2 px-5 py-3 min-h-[48px] bg-[var(--color-success)]/10 text-[var(--color-success)] text-sm font-bold border border-[var(--color-success)]/25 hover:bg-[var(--color-success)]/20 transition-all duration-200"
        >
          View Event Details
        </Link>
      </div>
    );
  }

  if (eventStatus !== 'checkin') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-5 text-center px-6 pb-28">
        <div className="w-20 h-20 rounded-full bg-[var(--ds-accent)]/15 flex items-center justify-center">
          <XCircle className="w-10 h-10 text-[var(--ds-accent)]" />
        </div>
        <div>
          <h1 className="display-md">Check-in Not Available</h1>
          <p className="text-[var(--text-muted)] text-sm mt-2">Check-in is not currently open for this event.</p>
        </div>
        <Link
          href={backLink}
          className="press text-sm text-[var(--ds-accent)] hover:text-[var(--ds-accent)]/80 transition-colors min-h-[44px] flex items-center"
        >
          Back to Event
        </Link>
      </div>
    );
  }

  if (!registration) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-5 text-center px-6 pb-28">
        <div className="w-20 h-20 rounded-full bg-[var(--color-warning)]/15 flex items-center justify-center">
          <AlertTriangle className="w-10 h-10 text-[var(--color-warning)]" />
        </div>
        <div>
          <h1 className="display-md">Not Registered</h1>
          <p className="text-[var(--text-muted)] text-sm mt-2">You are not registered for this event.</p>
        </div>
        <Link
          href={backLink}
          className="press text-sm text-[var(--ds-accent)] hover:text-[var(--ds-accent)]/80 transition-colors min-h-[44px] flex items-center"
        >
          Back to Event
        </Link>
      </div>
    );
  }

  if (registration.status === 'checked_in') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-5 text-center px-6 pb-28">
        <div className="w-20 h-20 rounded-full bg-[var(--color-success)]/15 flex items-center justify-center glow-soft">
          <CheckCircle className="w-10 h-10 text-[var(--color-success)]" />
        </div>
        <div>
          <p className="eyebrow mb-1 text-[var(--color-success)]">Already Done</p>
          <h1 className="display-lg">Already Checked In</h1>
          <p className="text-[var(--text-muted)] text-sm mt-1">{playerName}</p>
        </div>
        <Link
          href={backLink}
          className="press text-sm text-[var(--ds-accent)] hover:text-[var(--ds-accent)]/80 transition-colors min-h-[44px] flex items-center"
        >
          View Event Details
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-6 text-center px-6 pb-28">
      <div className="w-24 h-24 rounded-full bg-[var(--ds-accent)]/10 flex items-center justify-center glow-red">
        <CheckCircle className="w-12 h-12 text-[var(--ds-accent)]" />
      </div>
      <div>
        <p className="eyebrow mb-1">Ready?</p>
        <h1 className="display-lg">Self Check-In</h1>
        <p className="text-[var(--text-muted)] text-sm mt-1">{playerName}</p>
      </div>
      <Button
        onClick={handleCheckIn}
        loading={loading}
        size="lg"
        className="press w-full max-w-xs min-h-[52px]"
      >
        Confirm Check-In
      </Button>
      <Link
        href={backLink}
        className="text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors min-h-[44px] flex items-center"
      >
        Cancel
      </Link>
    </div>
  );
}
