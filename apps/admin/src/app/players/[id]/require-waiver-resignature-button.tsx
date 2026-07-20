'use client';

import { useTransition } from 'react';
import { Button } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { requireWaiverResignature } from '@/lib/actions';

export function RequireWaiverResignatureButton({ playerId }: { playerId: string }) {
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  function handleRequire() {
    if (!confirm('Force this player to re-sign the liability waiver on their next visit? This affects only this player.')) return;
    startTransition(async () => {
      try {
        await requireWaiverResignature(playerId);
        toast('This player must re-sign the waiver on their next visit.', 'success');
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to require re-signature', 'error');
      }
    });
  }

  return (
    <Button variant="ghost" size="sm" onClick={handleRequire} loading={isPending}>
      Require waiver re-signature
    </Button>
  );
}
