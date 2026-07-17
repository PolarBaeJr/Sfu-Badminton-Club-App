'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog, Input, Select } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { markFeePaid, markFeeUnpaid } from '@/lib/actions';

interface TermOption {
  id: string;
  label: string;
  default_fee_cents: number;
}

export function TermSelector({ terms, selectedId }: { terms: TermOption[]; selectedId: string }) {
  const router = useRouter();

  return (
    <Select
      label="Term"
      value={selectedId}
      onChange={(e) => router.push(`/fees?term=${encodeURIComponent(e.target.value)}`)}
      options={terms.map((t) => ({
        value: t.id,
        label: `${t.label} — $${(t.default_fee_cents / 100).toFixed(2)}`,
      }))}
    />
  );
}

interface FeeActionsProps {
  playerId: string;
  playerName: string;
  termId: string;
  termLabel: string;
  defaultFeeCents: number;
  paid: boolean;
}

export function FeeActions({ playerId, playerName, termId, termLabel, defaultFeeCents, paid }: FeeActionsProps) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [amount, setAmount] = useState((defaultFeeCents / 100).toFixed(2));
  const [method, setMethod] = useState('');
  const { toast } = useToast();
  const router = useRouter();

  function handleMarkPaid() {
    startTransition(async () => {
      try {
        const dollars = amount ? parseFloat(amount) : undefined;
        await markFeePaid({
          player_id: playerId,
          term_id: termId,
          amount_cents: dollars ? Math.round(dollars * 100) : undefined,
          method: method || undefined,
        });
        toast('Fee marked as paid', 'success');
        setOpen(false);
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
        await markFeeUnpaid(playerId, termId);
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
      <Button variant="ghost" size="sm" onClick={() => { setAmount((defaultFeeCents / 100).toFixed(2)); setOpen(true); }}>Mark Paid</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Mark Fee Paid — ${playerName}`}>
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            Term: <strong className="text-[var(--text-primary)]">{termLabel}</strong>
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
