'use client';

import { useState } from 'react';
import { Button, Dialog, Input } from '@badminton/ui';
import { createSeason, setActiveSeason, endSeason } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';

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
