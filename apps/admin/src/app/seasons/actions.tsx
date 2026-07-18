'use client';

import { useState } from 'react';
import { Button, Dialog, Input, Select } from '@badminton/ui';
import { createSeason, setActiveSeason, endSeason, updateSeasonFees, type SeasonEloPolicy } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';

export function CreateSeasonForm() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await createSeason({ name, start_date: startDate, end_date: endDate || undefined });
      toast('Season created', 'success');
      setOpen(false);
      setName(''); setStartDate(''); setEndDate('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>New Season</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Create Season">
        <form onSubmit={handleCreate} className="space-y-4">
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Fall 2026" />
          <Input label="Start Date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
          <Input label="End Date (optional)" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          <div className="flex gap-2">
            <Button type="submit" loading={loading}>Create</Button>
            <Button variant="ghost" onClick={() => setOpen(false)} type="button">Cancel</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

export function SeasonFeesEditor({
  seasonId,
  competitiveFeeCents,
  recreationalFeeCents,
}: {
  seasonId: string;
  competitiveFeeCents: number;
  recreationalFeeCents: number;
}) {
  const [open, setOpen] = useState(false);
  const [comp, setComp] = useState((competitiveFeeCents / 100).toFixed(2));
  const [rec, setRec] = useState((recreationalFeeCents / 100).toFixed(2));
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await updateSeasonFees(seasonId, {
        competitive_fee_cents: Math.round(parseFloat(comp || '0') * 100),
        recreational_fee_cents: Math.round(parseFloat(rec || '0') * 100),
      });
      toast('Fees updated', 'success');
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setComp((competitiveFeeCents / 100).toFixed(2));
          setRec((recreationalFeeCents / 100).toFixed(2));
          setOpen(true);
        }}
        className="font-mono text-sm text-[var(--text-secondary)] hover:text-[var(--color-accent)] transition-colors"
      >
        C ${(competitiveFeeCents / 100).toFixed(2)} · R ${(recreationalFeeCents / 100).toFixed(2)}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Edit Season Fees">
        <form onSubmit={handleSave} className="space-y-4">
          <Input label="Competitive Fee $" type="number" step="0.01" min="0" value={comp} onChange={(e) => setComp(e.target.value)} />
          <Input label="Recreational Fee $" type="number" step="0.01" min="0" value={rec} onChange={(e) => setRec(e.target.value)} />
          <div className="flex gap-2">
            <Button type="submit" loading={loading}>Save</Button>
            <Button variant="ghost" onClick={() => setOpen(false)} type="button">Cancel</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

const ELO_POLICY_OPTIONS: { value: SeasonEloPolicy; label: string }[] = [
  { value: 'carry', label: 'Carry over ELO (no reset)' },
  { value: 'soft', label: 'Soft reset (compress toward 400, keep tiers)' },
  { value: 'full', label: 'Full reset (everyone back to 400)' },
];

const POLICY_WARNING: Record<SeasonEloPolicy, string | null> = {
  carry: null,
  soft: 'Every player’s ELO will be compressed toward 400 (they keep at least their 200-point tier). Match history and win–loss records are preserved.',
  full: 'Every player’s ELO will be reset to 400 and made provisional again. Match history and win–loss records are preserved, but the current ladder standings are wiped.',
};

export function SeasonActions({ seasonId, seasonName, isActive }: { seasonId: string; seasonName: string; isActive: boolean }) {
  const [loading, setLoading] = useState(false);
  const [activateOpen, setActivateOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const [policy, setPolicy] = useState<SeasonEloPolicy>('carry');
  const { toast } = useToast();
  const router = useRouter();

  async function handleActivate() {
    setLoading(true);
    try {
      await setActiveSeason(seasonId, policy);
      toast('Season activated', 'success');
      setActivateOpen(false);
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  async function handleEnd() {
    setLoading(true);
    try {
      await endSeason(seasonId);
      toast('Season ended', 'success');
      setEndOpen(false);
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  if (isActive) {
    return (
      <>
        <Button size="sm" variant="danger" onClick={() => setEndOpen(true)} loading={loading}>
          End Season
        </Button>
        <Dialog open={endOpen} onClose={() => setEndOpen(false)} title={`End ${seasonName}?`}>
          <div className="space-y-4">
            <p className="text-sm text-[var(--text-secondary)]">
              This marks the season inactive and stamps its end date. Ratings are not changed.
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setEndOpen(false)}>Cancel</Button>
              <Button variant="danger" onClick={handleEnd} loading={loading} className="flex-1">
                End Season
              </Button>
            </div>
          </div>
        </Dialog>
      </>
    );
  }

  const warning = POLICY_WARNING[policy];

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => { setPolicy('carry'); setActivateOpen(true); }} loading={loading}>
        Set Active
      </Button>
      <Dialog open={activateOpen} onClose={() => setActivateOpen(false)} title={`Activate ${seasonName}?`}>
        <div className="space-y-4">
          <Select
            label="ELO on activation"
            options={ELO_POLICY_OPTIONS}
            value={policy}
            onChange={(e) => setPolicy(e.target.value as SeasonEloPolicy)}
          />
          {warning && (
            <div
              className="rounded-lg p-3 text-sm"
              style={{ background: 'var(--color-warning)/10', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
            >
              ⚠️ {warning}
            </div>
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setActivateOpen(false)}>Cancel</Button>
            <Button
              variant={policy === 'carry' ? 'primary' : 'danger'}
              onClick={handleActivate}
              loading={loading}
              className="flex-1"
            >
              {policy === 'carry' ? 'Activate' : 'Activate & Reset ELO'}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
