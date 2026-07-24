'use client';

import { useTransition } from 'react';
import { Button, useConfirm } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { requireWaiverResignature } from '@/lib/actions';

export function RequireWaiverResignatureButton({ playerId }: { playerId: string }) {
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();
  const confirm = useConfirm();

  async function handleRequire() {
    if (!(await confirm({ title: 'Require re-signature?', message: 'Force this player to re-sign the liability waiver on their next visit? This affects only this player.', confirmLabel: 'Require re-signature' }))) return;
    startTransition(async () => {
      try {
        const res = await requireWaiverResignature(playerId);
        if (!res.ok) { toast(res.error, 'error'); return; }
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
