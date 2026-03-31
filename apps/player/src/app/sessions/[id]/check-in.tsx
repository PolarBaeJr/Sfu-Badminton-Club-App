'use client';

import { useState } from 'react';
import { Button } from '@badminton/ui';
import { checkInToSession } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';

export function CheckInButton({ sessionId }: { sessionId: string }) {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  async function handleCheckIn() {
    setLoading(true);
    try {
      await checkInToSession(sessionId);
      toast('Checked in!', 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  return (
    <Button onClick={handleCheckIn} loading={loading} size="lg" className="w-full md:w-auto">
      Check In
    </Button>
  );
}
