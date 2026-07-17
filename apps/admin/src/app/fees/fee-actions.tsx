'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog, Input } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { markFeePaid, markFeeUnpaid } from '@/lib/actions';

export function PeriodSelector({ period }: { period: string }) {
  const [value, setValue] = useState(period);
  const router = useRouter();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (value.trim()) router.push(`/fees?period=${encodeURIComponent(value.trim())}`);
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-end gap-2">
      <Input label="Period" value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. 2026 Summer" />
      <Button type="submit" variant="ghost">Go</Button>
    </form>
  );
}

interface FeeActionsProps {
  playerId: string;
  playerName: string;
  period: string;
  paid: boolean;
}

export function FeeActions({ playerId, playerName, period, paid }: FeeActionsProps) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('');
  const { toast } = useToast();
  const router = useRouter();

  function handleMarkPaid() {
    startTransition(async () => {
      try {
        const dollars = amount ? parseFloat(amount) : undefined;
        await markFeePaid({
          player_id: playerId,
          period,
          amount_cents: dollars ? Math.round(dollars * 100) : undefined,
          method: method || undefined,
        });
        toast('Fee marked as paid', 'success');
        setOpen(false);
        setAmount('');
        setMethod('');
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to mark fee paid', 'error');
      }
    });
  }

  function handleMarkUnpaid() {
    startTransition(async () => {
      try {
        await markFeeUnpaid(playerId, period);
        toast('Fee marked as unpaid', 'success');
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to mark fee unpaid', 'error');
      }
    });
  }

  if (paid) {
    return (
      <Button variant="ghost" size="sm" onClick={handleMarkUnpaid} loading={isPending}>
        Mark Unpaid
      </Button>
    );
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>Mark Paid</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Mark Fee Paid — ${playerName}`}>
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            Period: <strong className="text-[var(--text-primary)]">{period}</strong>
          </p>
          <div className="flex gap-2">
            <Input label="Amount $ (optional)" type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 15.00" />
            <Input label="Method (optional)" value={method} onChange={(e) => setMethod(e.target.value)} placeholder="e.g. e-transfer, cash" />
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleMarkPaid} loading={isPending} className="flex-1">
              Mark Paid
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
