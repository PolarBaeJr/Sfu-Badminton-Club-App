'use client';

import { useState } from 'react';
import { Button, Dialog, Input, PlayerPicker } from '@badminton/ui';
import { addTournamentParticipant, removeTournamentParticipant, updateTournamentStatus } from '@/lib/actions';
import { runBulk, summarizeBulk } from '@/lib/bulk-add';
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
  const isDoubles = format === 'doubles';
  const [open, setOpen] = useState(false);
  // Two shapes, two states. A doubles entry is a specific PAIR — one player and
  // one named partner — so only the singles path is a list.
  const [playerIds, setPlayerIds] = useState<string[]>([]);
  const [playerId, setPlayerId] = useState('');
  const [partnerId, setPartnerId] = useState('');
  const [seed, setSeed] = useState('');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  // A seed is a position in one bracket slot; the same number cannot be handed
  // to several people at once. Offered only when the batch is a batch of one.
  const seedApplies = isDoubles || playerIds.length <= 1;

  async function handleAddPair(e: React.FormEvent) {
    e.preventDefault();
    if (!playerId) { toast('Select a player', 'error'); return; }
    setLoading(true);
    try {
      await addTournamentParticipant(
        tournamentId,
        playerId,
        seed ? Number(seed) : null,
        partnerId || undefined
      );
      toast('Participant added', 'success');
      setOpen(false);
      setPlayerId(''); setPartnerId(''); setSeed('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  async function handleAddMany(e: React.FormEvent) {
    e.preventDefault();
    if (playerIds.length === 0) { toast('Select at least one player', 'error'); return; }
    setLoading(true);
    const seedValue = seedApplies && seed ? Number(seed) : null;
    const outcome = await runBulk(playerIds, (id) =>
      addTournamentParticipant(tournamentId, id, seedValue, undefined)
    );
    const { message, tone } = summarizeBulk(outcome, {
      done: 'Added', failed: 'Could not add', noun: 'participant',
    });
    toast(message, tone);
    // Whoever failed stays selected: "Added 9 of 12" is only actionable if the
    // three that did not go in are still on screen to look at or retry.
    setPlayerIds(outcome.failures.map((f) => f.id));
    if (outcome.failures.length === 0) {
      setOpen(false);
      setSeed('');
    }
    setLoading(false);
  }

  const playerOptions = players.map(p => ({ id: p.id, name: p.full_name, avatarUrl: p.avatar_url }));

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>Add Participant</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Add Participant">
        <form onSubmit={isDoubles ? handleAddPair : handleAddMany} className="space-y-4">
          {isDoubles ? (
            <>
              <PlayerPicker
                label="Player"
                value={playerId}
                onChange={setPlayerId}
                players={playerOptions}
              />
              <PlayerPicker
                label="Partner"
                value={partnerId}
                onChange={setPartnerId}
                placeholder="Search partners…"
                players={playerOptions.filter(p => p.id !== playerId)}
              />
            </>
          ) : (
            <PlayerPicker
              multiple
              label="Players"
              value={playerIds}
              onChange={setPlayerIds}
              placeholder="Search players…"
              players={playerOptions}
            />
          )}
          <div>
            <Input
              label="Seed (optional)"
              type="number"
              value={seedApplies ? seed : ''}
              disabled={!seedApplies}
              onChange={(e) => setSeed(e.target.value)}
            />
            {!seedApplies && (
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                Seeds are per player — add these {playerIds.length} first, then set seeds individually.
              </p>
            )}
          </div>
          <div className="flex items-center justify-between">
            <Button variant="ghost" onClick={() => setOpen(false)} type="button">Cancel</Button>
            <Button type="submit" loading={loading}>
              {!isDoubles && playerIds.length > 1 ? `Add ${playerIds.length}` : 'Add'}
            </Button>
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
