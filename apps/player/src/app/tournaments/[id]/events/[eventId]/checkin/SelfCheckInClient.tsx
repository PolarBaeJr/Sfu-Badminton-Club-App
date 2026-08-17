'use client';

import { useState } from 'react';
import { Button } from '@badminton/ui';
import { selfCheckIn } from '@/lib/tournament-actions';
import { useToast } from '@/components/toast-provider';
import { useStanding } from '@/components/standing-provider';
import { useRouter } from 'next/navigation';
import { CheckCircle, XCircle, AlertTriangle } from 'lucide-react';
import Link from 'next/link';

interface Props {
  eventId: string;
  tournamentId: string;
  eventStatus: string;
  registration: { id: string; status: string } | null;
  playerName: string;
  tournamentSuspended: boolean;
}

export function SelfCheckInClient({ eventId, tournamentId, eventStatus, registration, playerName, tournamentSuspended }: Props) {
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const { toast } = useToast();
  const router = useRouter();
  const standing = useStanding();

  async function handleCheckIn() {
    setLoading(true);
    try {
      const res = await selfCheckIn(eventId);
      if (!res.ok) {
        toast(res.error, 'error');
        setLoading(false);
        return;
      }
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
        <div className="w-20 h-20 rounded-full bg-[color-mix(in_oklab,var(--color-success)_15%,transparent)] flex items-center justify-center glow-soft">
          <CheckCircle className="w-10 h-10 text-[var(--color-success)]" />
        </div>
        <div>
          <p className="eyebrow mb-1">Success</p>
          <h1 className="display-lg">You&apos;re In!</h1>
          <p className="text-[var(--text-muted)] text-sm mt-1">{playerName}</p>
        </div>
        <Link
          href={backLink}
          className="press inline-flex items-center gap-2 px-5 py-3 min-h-[48px] bg-[color-mix(in_oklab,var(--color-success)_10%,transparent)] text-[var(--color-success)] text-sm font-bold rounded-xl border border-[color-mix(in_oklab,var(--color-success)_25%,transparent)] hover:bg-[color-mix(in_oklab,var(--color-success)_20%,transparent)] transition-all duration-200"
        >
          View Event Details
        </Link>
      </div>
    );
  }

  // The member's own standing, checked before the tournament's — selfCheckIn
  // starts with requirePlayer(), so this refusal comes first there too, and
  // someone at the desk should be told the reason that actually applies to
  // them rather than one about the event.
  if (!standing.ok) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-5 text-center px-6 pb-28">
        <div className="w-20 h-20 rounded-full bg-[color-mix(in_oklab,var(--color-accent)_15%,transparent)] flex items-center justify-center">
          <XCircle className="w-10 h-10 text-[var(--color-accent)]" />
        </div>
        <div>
          <h1 className="display-md">Check-in Paused</h1>
          <p className="text-[var(--text-muted)] text-sm mt-2" style={{ maxWidth: '44ch' }}>{standing.detail}</p>
        </div>
        <Link
          href={backLink}
          className="press text-sm text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors min-h-[44px] flex items-center"
        >
          Back to Event
        </Link>
      </div>
    );
  }

  if (tournamentSuspended) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-5 text-center px-6 pb-28">
        <div className="w-20 h-20 rounded-full bg-[color-mix(in_oklab,var(--color-accent)_15%,transparent)] flex items-center justify-center">
          <XCircle className="w-10 h-10 text-[var(--color-accent)]" />
        </div>
        <div>
          <h1 className="display-md">Check-in Paused</h1>
          <p className="text-[var(--text-muted)] text-sm mt-2">This tournament is currently suspended, so check-in is paused.</p>
        </div>
        <Link
          href={backLink}
          className="press text-sm text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors min-h-[44px] flex items-center"
        >
          Back to Event
        </Link>
      </div>
    );
  }

  if (eventStatus !== 'checkin') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-5 text-center px-6 pb-28">
        <div className="w-20 h-20 rounded-full bg-[color-mix(in_oklab,var(--color-accent)_15%,transparent)] flex items-center justify-center">
          <XCircle className="w-10 h-10 text-[var(--color-accent)]" />
        </div>
        <div>
          <h1 className="display-md">Check-in Not Available</h1>
          <p className="text-[var(--text-muted)] text-sm mt-2">Check-in is not currently open for this event.</p>
        </div>
        <Link
          href={backLink}
          className="press text-sm text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors min-h-[44px] flex items-center"
        >
          Back to Event
        </Link>
      </div>
    );
  }

  if (!registration) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-5 text-center px-6 pb-28">
        <div className="w-20 h-20 rounded-full bg-[color-mix(in_oklab,var(--color-warning)_15%,transparent)] flex items-center justify-center">
          <AlertTriangle className="w-10 h-10 text-[var(--color-warning)]" />
        </div>
        <div>
          <h1 className="display-md">Not Registered</h1>
          <p className="text-[var(--text-muted)] text-sm mt-2">You are not registered for this event.</p>
        </div>
        <Link
          href={backLink}
          className="press text-sm text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors min-h-[44px] flex items-center"
        >
          Back to Event
        </Link>
      </div>
    );
  }

  if (registration.status === 'checked_in') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-5 text-center px-6 pb-28">
        <div className="w-20 h-20 rounded-full bg-[color-mix(in_oklab,var(--color-success)_15%,transparent)] flex items-center justify-center glow-soft">
          <CheckCircle className="w-10 h-10 text-[var(--color-success)]" />
        </div>
        <div>
          <p className="eyebrow mb-1 text-[var(--color-success)]">Already Done</p>
          <h1 className="display-lg">Already Checked In</h1>
          <p className="text-[var(--text-muted)] text-sm mt-1">{playerName}</p>
        </div>
        <Link
          href={backLink}
          className="press text-sm text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors min-h-[44px] flex items-center"
        >
          View Event Details
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-6 text-center px-6 pb-28">
      <div className="w-24 h-24 rounded-full bg-[color-mix(in_oklab,var(--color-accent)_10%,transparent)] flex items-center justify-center glow-red">
        <CheckCircle className="w-12 h-12 text-[var(--color-accent)]" />
      </div>
      <div>
        <p className="eyebrow mb-1">Ready?</p>
        <h1 className="display-lg">Self Check-In</h1>
        <p className="text-[var(--text-muted)] text-sm mt-1">{playerName}</p>
      </div>
      {/* Self-service check-in by button is gone: a member could check
          themselves in from anywhere, which made "checked in" mean nothing more
          than "tapped a button at home". Check-in is now proof of presence —
          scan the code an exec is showing at the door. One scan covers every
          event you are entered in, so this page no longer needs a per-event
          action at all. */}
      <Button
        onClick={() => router.push('/tournaments/checkin')}
        size="lg"
        className="press w-full max-w-xs min-h-[52px]"
      >
        Scan check-in code
      </Button>
      <p className="text-[var(--text-muted)] text-xs max-w-xs text-center">
        An exec will display the code. Scanning it checks you into every event
        you are entered in.
      </p>
      <Link
        href={backLink}
        className="text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors min-h-[44px] flex items-center"
      >
        Cancel
      </Link>
    </div>
  );
}
