'use client';

import { useState, useTransition } from 'react';
import { Button, Dialog, Input, Switch, Textarea } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { adjustReliability } from '@/lib/actions';

interface ReliabilityEditorProps {
  playerId: string;
  noShows: number;
  lateCancellations: number;
  earlyWithdrawals: number;
  walkoverFlag: boolean;
}

export function ReliabilityEditor({ playerId, noShows, lateCancellations, earlyWithdrawals, walkoverFlag }: ReliabilityEditorProps) {
  const [open, setOpen] = useState(false);
  const [noShowsVal, setNoShowsVal] = useState(noShows);
  const [lateCancelsVal, setLateCancelsVal] = useState(lateCancellations);
  const [earlyWithdrawalsVal, setEarlyWithdrawalsVal] = useState(earlyWithdrawals);
  const [flag, setFlag] = useState(walkoverFlag);
  const [reason, setReason] = useState('');
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  function handleOpen() {
    setNoShowsVal(noShows);
    setLateCancelsVal(lateCancellations);
    setEarlyWithdrawalsVal(earlyWithdrawals);
    setFlag(walkoverFlag);
    setReason('');
    setOpen(true);
  }

  function handleSave() {
    startTransition(async () => {
      try {
        await adjustReliability({
          player_id: playerId,
          no_shows: noShowsVal,
          late_cancellations: lateCancelsVal,
          early_withdrawals: earlyWithdrawalsVal,
          walkover_flag: flag,
          reason: reason.trim(),
        });
        toast('Reliability record updated', 'success');
        setOpen(false);
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to update reliability record', 'error');
      }
    });
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={handleOpen}>Adjust</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Adjust Reliability Record">
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            Raising no-shows can trigger the automatic thresholds (flag at 3, suspend at 5).
            Lowering no-shows does not auto-unflag — clear the flag explicitly below.
          </p>
          <div className="grid grid-cols-3 gap-2">
            <Input label="No-shows" type="number" min="0" value={noShowsVal} onChange={(e) => setNoShowsVal(Number(e.target.value))} />
            <Input label="Late cancels" type="number" min="0" value={lateCancelsVal} onChange={(e) => setLateCancelsVal(Number(e.target.value))} />
            <Input label="Withdrawals" type="number" min="0" value={earlyWithdrawalsVal} onChange={(e) => setEarlyWithdrawalsVal(Number(e.target.value))} />
          </div>
          <Switch
            label="Flagged for no-shows"
            description="Shown to the player as a repeated no-show warning."
            checked={flag}
            onChange={setFlag}
          />
          <Textarea
            label="Reason (required for audit)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Explain the adjustment..."
            maxLength={500}
          />
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} loading={isPending} className="flex-1" disabled={reason.trim().length < 2}>
              Save
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
