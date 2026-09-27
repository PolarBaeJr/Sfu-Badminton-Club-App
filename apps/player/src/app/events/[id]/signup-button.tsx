'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@badminton/ui';
import type { ClubEventSignupState } from '@badminton/shared';
import { signUpForClubEvent, withdrawFromClubEvent } from '@/lib/club-event-actions';
import { useToast } from '@/components/toast-provider';

// Offers only what the server would accept in this state; the server decides
// again either way.
export function SignupButton({ eventId, state }: { eventId: string; state: ClubEventSignupState }) {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  async function act(going: boolean) {
    setLoading(true);
    try {
      const res = going ? await signUpForClubEvent(eventId) : await withdrawFromClubEvent(eventId);
      if (!res.ok) {
        toast(res.error, 'error');
        return;
      }
      toast(going ? 'You are signed up' : 'You are no longer signed up', 'success');
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  if (state === 'open') {
    return (
      <Button onClick={() => act(true)} loading={loading}>
        Sign up
      </Button>
    );
  }
  if (state === 'going') {
    return (
      <Button variant="secondary" onClick={() => act(false)} loading={loading}>
        Withdraw
      </Button>
    );
  }
  return null;
}
