'use client';

import { useTransition } from 'react';
import { Button } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { approvePlayer } from '@/lib/actions/player-actions';

export function ApproveButtons({ playerId, playerName }: { playerId: string; playerName: string }) {
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  function handleApprove(type: 'competitive' | 'recreational') {
    startTransition(async () => {
      try {
        await approvePlayer(playerId, type, `Approved as ${type} from dashboard`);
        toast(`${playerName} approved as ${type}`, 'success');
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to approve', 'error');
      }
    });
  }

  return (
    <div className="flex gap-2">
      <Button size="sm" onClick={() => handleApprove('competitive')} loading={isPending}>
        Competitive
      </Button>
      <Button size="sm" variant="ghost" onClick={() => handleApprove('recreational')} loading={isPending}>
        Recreational
      </Button>
    </div>
  );
}
