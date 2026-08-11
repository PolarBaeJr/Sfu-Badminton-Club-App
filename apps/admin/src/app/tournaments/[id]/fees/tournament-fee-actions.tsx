'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, Dialog, Input, Select, Switch, Badge } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import type { TournamentFeeTier, MembershipType } from '@badminton/shared';
import { MEMBERSHIP_TYPES, formatMembershipType } from '@badminton/shared';
import { resolvePaymentMethod } from '@badminton/shared';
import {
  PaymentMethodFields,
  paymentMethodInvalid,
  EMPTY_PAYMENT_METHOD,
  type PaymentMethodState,
} from '@/app/fees/payment-method-fields';
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
  // Which memberships this tier prices. EMPTY MEANS "anyone", and it is stored
  // as null — the two are the same statement and the column CHECK refuses an
  // empty array precisely so they cannot drift apart. Deselecting everything
  // therefore restores the general price rather than pricing nobody.
  const [appliesTo, setAppliesTo] = useState<MembershipType[]>(tier?.applies_to ?? []);
  const { toast } = useToast();

  const toggleMembership = (value: MembershipType) =>
    setAppliesTo((current) =>
      current.includes(value) ? current.filter((m) => m !== value) : [...current, value],
    );

  const router = useRouter();

  function handleSave() {
    startTransition(async () => {
      try {
        const payload = {
          tournament_id: tournamentId,
          name: name.trim(),
          amount_cents: Math.round(parseFloat(amount || '0') * 100),
          is_default: isDefault,
          applies_to: appliesTo.length > 0 ? appliesTo : null,
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
        {/* WHO THIS PRICE IS FOR. Before 00094 an exec picked a tier by hand
            for every entrant — "manual assignment is crazy annoying", and the
            roster already records who is internal, alumni or external. Chosen
            here once, applied at every registration by selectFeeTier.

            Checkboxes rather than a Select: the groups are not ranked, and
            "alumni and external" is as real a combination as either alone. */}
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
            Applies to
          </legend>
          <p className="text-xs text-[var(--text-muted)]">
            {appliesTo.length === 0
              ? 'Everyone. This is the general price for the tournament.'
              : `Charged to ${appliesTo.map(formatMembershipType).join(' and ')} members.`}
          </p>
          <div className="flex flex-wrap gap-2">
            {MEMBERSHIP_TYPES.map((m) => {
              const on = appliesTo.includes(m.value);
              return (
                <button
                  key={m.value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleMembership(m.value)}
                  className={`px-3 min-h-[44px] text-xs font-bold uppercase tracking-[0.08em] border transition-colors ${
                    on
                      ? 'bg-[var(--color-accent)] text-white border-[var(--color-accent)]'
                      : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-hover)]'
                  }`}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
        </fieldset>
        {/* Still worth setting even with `applies_to` above: it is the price a
            member gets when no tier names their group at all, which is the one
            case that would otherwise record an entry with no fee. */}
        <Switch label="Default tier" description="Charged when no tier matches the entrant's membership" checked={isDefault} onChange={setIsDefault} />
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
  const [payment, setPayment] = useState<PaymentMethodState>(EMPTY_PAYMENT_METHOD);
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
          method: resolvePaymentMethod(payment.method, payment.customMethod),
          reference: payment.reference.trim() || undefined,
        });
        toast('Fee marked as paid', 'success');
        setMarkOpen(false);
        setPayment(EMPTY_PAYMENT_METHOD);
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
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-[var(--text-primary)]">{tier.name}</span>
                {tier.is_default && <Badge variant="info">Default</Badge>}
                {/* Who this price is for, on the row rather than only inside the
                    edit dialog: the whole point of applies_to is that nobody
                    chooses a tier by hand any more, so which tier catches whom
                    has to be readable without opening anything. "Everyone" is
                    said out loud because a blank space here would read as an
                    unfinished tier rather than the general price. */}
                <Badge variant="neutral">
                  {tier.applies_to?.length
                    ? tier.applies_to.map(formatMembershipType).join(' · ')
                    : 'Everyone'}
                </Badge>
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
          <Input label="Amount $ (optional)" type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 10.00" />
          <PaymentMethodFields value={payment} onChange={setPayment} disabled={isPending} />
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setMarkOpen(false)}>Cancel</Button>
            <Button onClick={handleMarkPaid} loading={isPending} disabled={paymentMethodInvalid(payment)} className="flex-1">
              Mark Paid
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
