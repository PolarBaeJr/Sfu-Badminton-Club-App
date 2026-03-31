'use client';

import { useState } from 'react';
import { Button, Dialog, Input, Select, Switch } from '@badminton/ui';
import { createTournament } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';

export function CreateTournamentForm() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('');
  const [scope, setScope] = useState('open');
  const [type, setType] = useState('internal');
  const [format, setFormat] = useState('singles');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [bracketSize, setBracketSize] = useState(8);
  const [eventMultiplier, setEventMultiplier] = useState(1.15);
  const [placementBonus, setPlacementBonus] = useState(true);
  const { toast } = useToast();

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await createTournament({
        name,
        scope,
        type,
        format,
        start_date: startDate,
        end_date: endDate || undefined,
        bracket_size: bracketSize,
        event_multiplier: eventMultiplier,
        placement_bonus_enabled: placementBonus,
      });
      toast('Tournament created', 'success');
      setOpen(false);
      setName(''); setStartDate(''); setEndDate('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>New Tournament</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Create Tournament">
        <form onSubmit={handleCreate} className="space-y-4">
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Scope"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              options={[
                { value: 'open', label: 'Open' },
                { value: 'eligible_only', label: 'Eligible Only' },
              ]}
            />
            <Select
              label="Type"
              value={type}
              onChange={(e) => setType(e.target.value)}
              options={[
                { value: 'internal', label: 'Internal' },
                { value: 'open_official', label: 'Open Official' },
                { value: 'invitational', label: 'Invitational' },
              ]}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Format"
              value={format}
              onChange={(e) => setFormat(e.target.value)}
              options={[
                { value: 'singles', label: 'Singles' },
                { value: 'doubles', label: 'Doubles' },
                { value: 'mixed_event', label: 'Mixed Event' },
              ]}
            />
            <Select
              label="Bracket Size"
              value={String(bracketSize)}
              onChange={(e) => setBracketSize(Number(e.target.value))}
              options={[
                { value: '4', label: '4 players' },
                { value: '8', label: '8 players' },
                { value: '16', label: '16 players' },
                { value: '32', label: '32 players' },
              ]}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input label="Start Date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
            <Input label="End Date" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
          <Input
            label="Elo Multiplier"
            type="number"
            value={String(eventMultiplier)}
            onChange={(e) => setEventMultiplier(Number(e.target.value))}
          />
          <div className="flex items-center gap-3">
            <Switch checked={placementBonus} onChange={setPlacementBonus} />
            <span className="text-sm text-[var(--text-secondary)]">Enable placement bonuses</span>
          </div>
          <div className="flex gap-2">
            <Button type="submit" loading={loading}>Create</Button>
            <Button variant="ghost" onClick={() => setOpen(false)} type="button">Cancel</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
