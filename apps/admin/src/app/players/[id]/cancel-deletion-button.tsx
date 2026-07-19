'use client';

import { useTransition } from 'react';
import { Button } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { cancelAccountDeletion } from '@/lib/actions';

export function CancelDeletionButton({ playerId }: { playerId: string }) {
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  function handleCancel() {
    startTransition(async () => {
      try {
        await cancelAccountDeletion(playerId);
        toast('Deletion cancelled — account restored', 'success');
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to cancel deletion', 'error');
      }
    });
  }

  return (
    <Button variant="ghost" size="sm" onClick={handleCancel} loading={isPending}>
      Cancel deletion
    </Button>
  );
}
