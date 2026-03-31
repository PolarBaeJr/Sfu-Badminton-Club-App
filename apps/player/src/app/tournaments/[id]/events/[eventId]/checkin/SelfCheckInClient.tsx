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

  if (success) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4 text-center">
        <div className="w-16 h-16 rounded-full bg-[#22C55E]/15 flex items-center justify-center">
          <CheckCircle className="w-8 h-8 text-[#22C55E]" />
        </div>
        <h1 className="text-2xl font-black text-shuttle-white font-display">You&apos;re Checked In!</h1>
        <p className="text-[#64748B] text-sm">{playerName}</p>
        <Link
          href={`/tournaments/${tournamentId}/events/${eventId}`}
          className="text-sm text-[#EF4444] hover:underline mt-4"
        >
          View Event Details
        </Link>
      </div>
    );
  }

  if (eventStatus !== 'checkin') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4 text-center">
        <div className="w-16 h-16 rounded-full bg-[#EF4444]/15 flex items-center justify-center">
          <XCircle className="w-8 h-8 text-[#EF4444]" />
        </div>
        <h1 className="text-xl font-bold text-shuttle-white">Check-in Not Available</h1>
        <p className="text-[#64748B] text-sm">Check-in is not currently open for this event.</p>
        <Link
          href={`/tournaments/${tournamentId}/events/${eventId}`}
          className="text-sm text-[#EF4444] hover:underline mt-4"
        >
          Back to Event
        </Link>
      </div>
    );
  }

  if (!registration) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4 text-center">
        <div className="w-16 h-16 rounded-full bg-[#F59E0B]/15 flex items-center justify-center">
          <AlertTriangle className="w-8 h-8 text-[#F59E0B]" />
        </div>
        <h1 className="text-xl font-bold text-shuttle-white">Not Registered</h1>
        <p className="text-[#64748B] text-sm">You are not registered for this event.</p>
        <Link
          href={`/tournaments/${tournamentId}/events/${eventId}`}
          className="text-sm text-[#EF4444] hover:underline mt-4"
        >
          Back to Event
        </Link>
      </div>
    );
  }

  if (registration.status === 'checked_in') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4 text-center">
        <div className="w-16 h-16 rounded-full bg-[#22C55E]/15 flex items-center justify-center">
          <CheckCircle className="w-8 h-8 text-[#22C55E]" />
        </div>
        <h1 className="text-2xl font-black text-shuttle-white font-display">Already Checked In</h1>
        <p className="text-[#64748B] text-sm">{playerName}</p>
        <Link
          href={`/tournaments/${tournamentId}/events/${eventId}`}
          className="text-sm text-[#EF4444] hover:underline mt-4"
        >
          View Event Details
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-6 text-center">
      <div className="w-20 h-20 rounded-full bg-[#EF4444]/15 flex items-center justify-center">
        <CheckCircle className="w-10 h-10 text-[#EF4444]" />
      </div>
      <div>
        <h1 className="text-2xl font-black text-shuttle-white font-display">Self Check-In</h1>
        <p className="text-[#64748B] text-sm mt-1">{playerName}</p>
      </div>
      <Button onClick={handleCheckIn} loading={loading} size="lg">
        Confirm Check-In
      </Button>
      <Link
        href={`/tournaments/${tournamentId}/events/${eventId}`}
        className="text-sm text-[#64748B] hover:text-[#94A3B8]"
      >
        Cancel
      </Link>
    </div>
  );
}
