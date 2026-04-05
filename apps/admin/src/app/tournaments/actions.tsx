'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog, Input, Select, Switch, Dropdown } from '@badminton/ui';
import { createTournament, updateTournament, archiveTournament, deleteTournament } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { MoreVertical } from 'lucide-react';

interface TournamentData {
  id: string;
  name: string;
  scope: string;
  type: string;
  format: string;
  start_date: string;
  end_date: string | null;
  bracket_size: number;
  event_multiplier: number;
  placement_bonus_enabled: boolean;
  status: string;
}

function TournamentFormDialog({
  open,
  onClose,
  tournament,
}: {
  open: boolean;
  onClose: () => void;
  tournament?: TournamentData;
}) {
  const isEdit = !!tournament;
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState(tournament?.name ?? '');
  const [scope, setScope] = useState(tournament?.scope ?? 'open');
  const [type, setType] = useState(tournament?.type ?? 'internal');
  const [format, setFormat] = useState(tournament?.format ?? 'singles');
  const [startDate, setStartDate] = useState(tournament?.start_date ?? '');
  const [endDate, setEndDate] = useState(tournament?.end_date ?? '');
  const [bracketSize, setBracketSize] = useState(tournament?.bracket_size ?? 8);
  const [eventMultiplier, setEventMultiplier] = useState(tournament?.event_multiplier ?? 1.15);
  const [placementBonus, setPlacementBonus] = useState(tournament?.placement_bonus_enabled ?? true);
  const { toast } = useToast();
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const data = {
        name,
        scope,
        type,
        format,
        start_date: startDate,
        end_date: endDate || undefined,
        bracket_size: bracketSize,
        event_multiplier: eventMultiplier,
        placement_bonus_enabled: placementBonus,
      };
      if (isEdit) {
        await updateTournament(tournament.id, data);
        toast('Tournament updated', 'success');
      } else {
        await createTournament(data);
        toast('Tournament created', 'success');
      }
      onClose();
      if (!isEdit) {
        setName(''); setStartDate(''); setEndDate('');
        setScope('open'); setType('internal'); setFormat('singles');
        setBracketSize(8); setEventMultiplier(1.15); setPlacementBonus(true);
      }
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  return (
    <Dialog open={open} onClose={onClose} title={isEdit ? 'Edit Tournament' : 'Create Tournament'}>
      <form onSubmit={handleSubmit} className="space-y-4">
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
          <Button type="submit" loading={loading} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">{isEdit ? 'Save Changes' : 'Create'}</Button>
          <Button variant="ghost" onClick={onClose} type="button" className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">Cancel</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function CreateTournamentForm() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">New Tournament</Button>
      <TournamentFormDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function TournamentMenu({ tournament }: { tournament: TournamentData }) {
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  async function handleArchive() {
    try {
      await archiveTournament(tournament.id);
      toast('Tournament archived', 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
  }

  async function handleDelete() {
    setLoading(true);
    try {
      await deleteTournament(tournament.id);
      toast('Tournament deleted', 'success');
      setConfirmDelete(false);
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  return (
    <div onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      <Dropdown
        trigger={
          <button
            aria-label="Tournament menu"
            className="p-1.5 rounded-lg hover:bg-[var(--border-hover)] transition-colors text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
          >
            <MoreVertical className="w-4 h-4" />
          </button>
        }
        items={[
          { label: 'Edit', onClick: () => setEditOpen(true) },
          ...(tournament.status !== 'archived' ? [{ label: 'Archive', onClick: handleArchive }] : []),
          { label: 'Delete', onClick: () => setConfirmDelete(true), danger: true },
        ]}
      />

      <TournamentFormDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        tournament={tournament}
      />

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete Tournament">
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            Are you sure you want to permanently delete <strong>{tournament.name}</strong>? This will also remove all participants and events. This action cannot be undone.
          </p>
          <div className="flex gap-2">
            <Button variant="danger" onClick={handleDelete} loading={loading} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">Delete</Button>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">Cancel</Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
