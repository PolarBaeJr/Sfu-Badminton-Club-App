'use client';

import { useState } from 'react';
import { Button, Dialog, Input, PlayerPicker } from '@badminton/ui';
import { addTournamentParticipant, removeTournamentParticipant, updateTournamentStatus } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';

type Player = { id: string; full_name: string; avatar_url?: string | null };

export function AddParticipantForm({
  tournamentId,
  format,
  players,
}: {
  tournamentId: string;
  format: string;
  players: Player[];
}) {
  const [open, setOpen] = useState(false);
  const [playerId, setPlayerId] = useState('');
  const [partnerId, setPartnerId] = useState('');
  const [seed, setSeed] = useState('');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!playerId) { toast('Select a player', 'error'); return; }
    setLoading(true);
    try {
      await addTournamentParticipant(
        tournamentId,
        playerId,
        seed ? Number(seed) : null,
        format === 'doubles' ? partnerId || undefined : undefined
      );
      toast('Participant added', 'success');
      setOpen(false);
      setPlayerId(''); setPartnerId(''); setSeed('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  const playerOptions = players.map(p => ({ id: p.id, name: p.full_name, avatarUrl: p.avatar_url }));

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>Add Participant</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Add Participant">
        <form onSubmit={handleAdd} className="space-y-4">
          <PlayerPicker
            label="Player"
            value={playerId}
            onChange={setPlayerId}
            players={playerOptions}
          />
          {format === 'doubles' && (
            <PlayerPicker
              label="Partner"
              value={partnerId}
              onChange={setPartnerId}
              placeholder="Search partners…"
              players={playerOptions.filter(p => p.id !== playerId)}
            />
          )}
          <Input label="Seed (optional)" type="number" value={seed} onChange={(e) => setSeed(e.target.value)} />
          <div className="flex items-center justify-between">
            <Button variant="ghost" onClick={() => setOpen(false)} type="button">Cancel</Button>
            <Button type="submit" loading={loading}>Add</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

export function RemoveParticipantButton({ participantId, tournamentId }: { participantId: string; tournamentId: string }) {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  async function handleRemove() {
    setLoading(true);
    try {
      await removeTournamentParticipant(participantId, tournamentId);
      toast('Participant removed', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  return (
    <Button size="sm" variant="ghost" onClick={handleRemove} loading={loading}>
      Remove
    </Button>
  );
}

export function TournamentStatusActions({ tournamentId, currentStatus }: { tournamentId: string; currentStatus: string }) {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  async function handleStatusChange(newStatus: string) {
    setLoading(true);
    try {
      await updateTournamentStatus(tournamentId, newStatus);
      toast(`Tournament ${newStatus}`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  return (
    <div className="flex gap-2">
      {currentStatus === 'draft' && (
        <Button size="sm" onClick={() => handleStatusChange('active')} loading={loading}>
          Activate Tournament
        </Button>
      )}
      {currentStatus === 'active' && (
        <Button size="sm" variant="ghost" onClick={() => handleStatusChange('completed')} loading={loading}>
          Mark Completed
        </Button>
      )}
    </div>
  );
}
