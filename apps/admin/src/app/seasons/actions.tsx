'use client';

import { useState } from 'react';
import { Button, Dialog, Input } from '@badminton/ui';
import { createSeason, setActiveSeason, endSeason, updateSeasonFees } from '@/lib/actions';
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

export function SeasonActions({ seasonId, isActive }: { seasonId: string; isActive: boolean }) {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  async function handleActivate() {
    setLoading(true);
    try {
      await setActiveSeason(seasonId);
      toast('Season activated', 'success');
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
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  if (isActive) {
    return (
      <Button size="sm" variant="danger" onClick={handleEnd} loading={loading}>
        End Season
      </Button>
    );
  }

  return (
    <Button size="sm" variant="ghost" onClick={handleActivate} loading={loading}>
      Set Active
    </Button>
  );
}
