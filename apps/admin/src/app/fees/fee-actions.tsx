'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog, Input } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { markFeePaid, markFeeUnpaid, addManualFee, removeManualFee } from '@/lib/actions';

interface FeeActionsProps {
  playerId: string;
  playerName: string;
  seasonId: string;
  seasonName: string;
  defaultFeeCents: number;
  paid: boolean;
}

export function FeeActions({ playerId, playerName, seasonId, seasonName, defaultFeeCents, paid }: FeeActionsProps) {
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
          season_id: seasonId,
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
        await markFeeUnpaid(playerId, seasonId);
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
            Season: <strong className="text-[var(--text-primary)]">{seasonName}</strong>
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

export function AddManualFee({ seasonId, seasonName }: { seasonId: string; seasonName: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('');
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  function handleAdd() {
    startTransition(async () => {
      try {
        const dollars = amount ? parseFloat(amount) : undefined;
        await addManualFee({
          season_id: seasonId,
          manual_name: name.trim(),
          amount_cents: dollars ? Math.round(dollars * 100) : undefined,
          method: method || undefined,
        });
        toast(`Added ${name.trim()}`, 'success');
        setOpen(false);
        setName(''); setAmount(''); setMethod('');
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to add name', 'error');
      }
    });
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>Add a name</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Add a name">
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            Record a payment for someone without an account for{' '}
            <strong className="text-[var(--text-primary)]">{seasonName}</strong>.
          </p>
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Jane Doe" />
          <div className="flex gap-2">
            <Input label="Amount $ (optional)" type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 15.00" />
            <Input label="Method (optional)" value={method} onChange={(e) => setMethod(e.target.value)} placeholder="e.g. e-transfer, cash" />
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleAdd} loading={isPending} className="flex-1" disabled={!name.trim()}>
              Add
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

export function RemoveManualFee({ id, name }: { id: string; name: string }) {
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  function handleRemove() {
    startTransition(async () => {
      try {
        await removeManualFee(id);
        toast(`Removed ${name}`, 'success');
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to remove', 'error');
      }
    });
  }

  return (
    <Button variant="danger" size="sm" onClick={handleRemove} loading={isPending}>
      Remove
    </Button>
  );
}
