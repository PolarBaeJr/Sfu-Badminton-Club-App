'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, Dialog, Input, Select, Switch, Badge } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import type { TournamentFeeTier } from '@badminton/shared';
import {
  createFeeTier,
  updateFeeTier,
  deleteFeeTier,
  markTournamentFeePaid,
  markTournamentFeeUnpaid,
} from '@/lib/actions';

interface TierDialogProps {
  tournamentId: string;
  tier?: TournamentFeeTier;
  open: boolean;
  onClose: () => void;
}

function TierDialog({ tournamentId, tier, open, onClose }: TierDialogProps) {
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState(tier?.name ?? '');
  const [amount, setAmount] = useState(tier ? (tier.amount_cents / 100).toFixed(2) : '');
  const [isDefault, setIsDefault] = useState(Boolean(tier?.is_default));
  const { toast } = useToast();
  const router = useRouter();

  function handleSave() {
    startTransition(async () => {
      try {
        const payload = {
          tournament_id: tournamentId,
          name: name.trim(),
          amount_cents: Math.round(parseFloat(amount || '0') * 100),
          is_default: isDefault,
        };
        if (tier) {
          await updateFeeTier(tier.id, payload);
          toast('Tier updated', 'success');
        } else {
          await createFeeTier(payload);
          toast('Tier created', 'success');
        }
        onClose();
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to save tier', 'error');
      }
    });
  }

  return (
    <Dialog open={open} onClose={onClose} title={tier ? 'Edit Tier' : 'New Tier'}>
      <div className="space-y-4">
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Member, Guest" />
        <Input label="Amount $" type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 10.00" />
        <Switch label="Default tier" description="Used as the default fee for this tournament" checked={isDefault} onChange={setIsDefault} />
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} loading={isPending} className="flex-1" disabled={!name.trim()}>
            {tier ? 'Save Changes' : 'Create Tier'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

interface Props {
  mode: 'tiers' | 'mark';
  tournamentId: string;
  tiers: TournamentFeeTier[];
  playerId?: string;
  playerName?: string;
  paid?: boolean;
}

export function TournamentFeeActions({ mode, tournamentId, tiers, playerId, playerName, paid }: Props) {
  const [createOpen, setCreateOpen] = useState(false);
  const [editTier, setEditTier] = useState<TournamentFeeTier | null>(null);
  const [markOpen, setMarkOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const defaultTier = tiers.find((t) => t.is_default) ?? tiers[0] ?? null;
  const [tierId, setTierId] = useState(defaultTier?.id ?? '');
  const [amount, setAmount] = useState(defaultTier ? (defaultTier.amount_cents / 100).toFixed(2) : '');
  const [method, setMethod] = useState('');
  const { toast } = useToast();
  const router = useRouter();

  function handleDeleteTier(id: string) {
    startTransition(async () => {
      try {
        await deleteFeeTier(id);
        toast('Tier deleted', 'success');
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to delete tier', 'error');
      }
    });
  }

  function handleTierChange(newTierId: string) {
    setTierId(newTierId);
    const tier = tiers.find((t) => t.id === newTierId);
    if (tier) setAmount((tier.amount_cents / 100).toFixed(2));
  }

  function handleMarkPaid() {
    startTransition(async () => {
      try {
        const dollars = amount ? parseFloat(amount) : undefined;
        await markTournamentFeePaid({
          tournament_id: tournamentId,
          player_id: playerId!,
          tier_id: tierId || undefined,
          amount_cents: dollars != null && !Number.isNaN(dollars) ? Math.round(dollars * 100) : undefined,
          method: method || undefined,
        });
        toast('Fee marked as paid', 'success');
        setMarkOpen(false);
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
        await markTournamentFeeUnpaid(tournamentId, playerId!);
        toast('Fee marked as unpaid', 'success');
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to mark fee unpaid', 'error');
      }
    });
  }

  if (mode === 'tiers') {
    return (
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Fee Tiers</h2>
          <Button variant="ghost" size="sm" onClick={() => setCreateOpen(true)}>New Tier</Button>
        </div>

        <div className="divide-y divide-[var(--border)]">
          {tiers.map((tier) => (
            <div key={tier.id} className="flex items-center justify-between py-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-[var(--text-primary)]">{tier.name}</span>
                {tier.is_default && <Badge variant="info">Default</Badge>}
                <span className="text-xs text-[var(--text-muted)] font-mono">
                  ${(tier.amount_cents / 100).toFixed(2)}
                </span>
              </div>
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" onClick={() => setEditTier(tier)}>Edit</Button>
                <Button variant="danger" size="sm" onClick={() => handleDeleteTier(tier.id)} loading={isPending}>Delete</Button>
              </div>
            </div>
          ))}
        </div>

        {tiers.length === 0 && (
          <p className="text-center text-[var(--text-muted)] py-4 text-sm">No tiers yet</p>
        )}

        <TierDialog tournamentId={tournamentId} open={createOpen} onClose={() => setCreateOpen(false)} />
        {editTier && (
          <TierDialog tournamentId={tournamentId} tier={editTier} open={Boolean(editTier)} onClose={() => setEditTier(null)} />
        )}
      </Card>
    );
  }

  // mode === 'mark'
  if (paid) {
    return (
      <Button variant="ghost" size="sm" onClick={handleMarkUnpaid} loading={isPending}>
        Mark Unpaid
      </Button>
    );
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => { setTierId(defaultTier?.id ?? ''); setAmount(defaultTier ? (defaultTier.amount_cents / 100).toFixed(2) : ''); setMarkOpen(true); }}>Mark Paid</Button>
      <Dialog open={markOpen} onClose={() => setMarkOpen(false)} title={`Mark Fee Paid — ${playerName}`}>
        <div className="space-y-4">
          {tiers.length > 0 && (
            <Select
              label="Tier"
              value={tierId}
              onChange={(e) => handleTierChange(e.target.value)}
              options={tiers.map((t) => ({ value: t.id, label: `${t.name} — $${(t.amount_cents / 100).toFixed(2)}` }))}
            />
          )}
          <div className="flex gap-2">
            <Input label="Amount $ (optional)" type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 10.00" />
            <Input label="Method (optional)" value={method} onChange={(e) => setMethod(e.target.value)} placeholder="e.g. e-transfer, cash" />
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setMarkOpen(false)}>Cancel</Button>
            <Button onClick={handleMarkPaid} loading={isPending} className="flex-1">
              Mark Paid
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
