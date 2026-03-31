'use client';

import { useState } from 'react';
import { Button, Dialog, Select, Input, Badge, Avatar } from '@badminton/ui';
import {
  addParticipantToEvent,
  removeParticipantFromEvent,
  addPairToEvent,
  removePairFromEvent,
  autoSeedEventByElo,
  updateParticipantSeed,
} from '@/lib/tournament-actions';
import { nextPowerOf2 } from '@badminton/shared';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { Plus, Trash2, ArrowUpDown, Hash, AlertTriangle } from 'lucide-react';

interface Props {
  event: Record<string, unknown>;
  participants: unknown[];
  pairs: unknown[];
  allPlayers: Array<{ id: string; full_name: string }>;
  isDoubles: boolean;
}

const STATUS_COLORS: Record<string, string> = {
  registered: 'var(--text-muted)',
  checked_in: 'var(--color-success)',
  withdrawn: 'var(--color-danger)',
  disqualified: 'var(--color-danger)',
  no_show: 'var(--color-warning)',
};

export function ParticipantsTab({ event, participants, pairs, allPlayers, isDoubles }: Props) {
  const [addOpen, setAddOpen] = useState(false);
  const [playerId, setPlayerId] = useState('');
  const [player2Id, setPlayer2Id] = useState('');
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const { toast } = useToast();
  const router = useRouter();

  const entries = isDoubles ? pairs : participants;
  const activeEntries = (entries as any[]).filter((e: any) => !['withdrawn', 'disqualified'].includes(e.status));
  const bracketSize = nextPowerOf2(activeEntries.length);
  const byes = bracketSize - activeEntries.length;
  const canModify = event.status === 'registration';

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!playerId) return;
    setLoading(true);
    try {
      if (isDoubles) {
        if (!player2Id) { toast('Select both players', 'error'); setLoading(false); return; }
        await addPairToEvent(event.id as string, playerId, player2Id);
      } else {
        await addParticipantToEvent(event.id as string, playerId);
      }
      toast('Added successfully', 'success');
      setAddOpen(false);
      setPlayerId('');
      setPlayer2Id('');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  async function handleRemove(id: string) {
    setActionLoading(id);
    try {
      if (isDoubles) {
        await removePairFromEvent(id);
      } else {
        await removeParticipantFromEvent(id);
      }
      toast('Removed', 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setActionLoading(null);
  }

  async function handleAutoSeed() {
    setLoading(true);
    try {
      await autoSeedEventByElo(event.id as string);
      toast('Auto-seeded by Elo', 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  // Registered player IDs for filtering
  const registeredPlayerIds = new Set(
    isDoubles
      ? (pairs as any[]).flatMap((p: any) => [p.player1_id, p.player2_id])
      : (participants as any[]).map((p: any) => p.player_id)
  );

  const availablePlayers = allPlayers.filter(p => !registeredPlayerIds.has(p.id));
  const playerOptions = [{ value: '', label: 'Select player...' }, ...availablePlayers.map(p => ({ value: p.id, label: p.full_name }))];

  return (
    <div className="space-y-4">
      {/* Actions bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm text-[var(--text-muted)]">
            {activeEntries.length} {isDoubles ? 'pairs' : 'players'}
            {event.format !== 'round_robin' && ` → ${bracketSize}-slot bracket`}
            {byes > 0 && event.format !== 'round_robin' && (
              <span className="text-[var(--color-warning)]"> ({byes} byes)</span>
            )}
          </span>
        </div>
        <div className="flex gap-2">
          {canModify && (
            <>
              <Button size="sm" variant="ghost" onClick={handleAutoSeed} loading={loading}>
                <ArrowUpDown className="w-3.5 h-3.5 mr-1" /> Auto-Seed
              </Button>
              <Button size="sm" onClick={() => setAddOpen(true)}>
                <Plus className="w-3.5 h-3.5 mr-1" /> Add {isDoubles ? 'Pair' : 'Player'}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Bracket size warning */}
      {byes > 0 && event.format !== 'round_robin' && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--color-warning)]/10 border border-[var(--color-warning)]/20">
          <AlertTriangle className="w-4 h-4 text-[var(--color-warning)] flex-shrink-0" />
          <span className="text-sm text-[var(--color-warning)]">
            {activeEntries.length} {isDoubles ? 'pairs' : 'players'} will create a {bracketSize}-slot bracket with {byes} bye{byes > 1 ? 's' : ''}. Top seeds get free passes.
          </span>
        </div>
      )}

      {/* Participants table */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider px-4 py-3 w-16">Seed</th>
              <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider px-4 py-3">
                {isDoubles ? 'Pair' : 'Player'}
              </th>
              <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider px-4 py-3 w-24">Elo</th>
              <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider px-4 py-3 w-28">Status</th>
              {canModify && (
                <th className="text-right text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider px-4 py-3 w-24">Actions</th>
              )}
            </tr>
          </thead>
          <tbody>
            {isDoubles ? (
              (pairs as any[]).map((pair: any) => (
                <tr key={pair.id} className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--bg-elevated)] transition-colors">
                  <td className="px-4 py-3">
                    <span className="text-sm font-mono text-[var(--text-muted)]">
                      {pair.seed_number ? `#${pair.seed_number}` : '-'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-sm font-medium text-[var(--text-primary)]">
                      {pair.pair_name ?? `${pair.player1?.full_name} / ${pair.player2?.full_name}`}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-sm font-mono text-[var(--text-muted)]">{pair.combined_elo ?? '-'}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ color: STATUS_COLORS[pair.status], backgroundColor: `${STATUS_COLORS[pair.status]}15` }}>
                      {pair.status}
                    </span>
                  </td>
                  {canModify && (
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => handleRemove(pair.id)} loading={actionLoading === pair.id}>
                        <Trash2 className="w-3.5 h-3.5 text-[var(--color-danger)]" />
                      </Button>
                    </td>
                  )}
                </tr>
              ))
            ) : (
              (participants as any[]).map((p: any) => {
                const player = p.player;
                const ratings = Array.isArray(player?.ratings) ? player.ratings[0] : player?.ratings;
                const elo = ratings?.singles_elo ?? p.elo_before ?? '-';
                return (
                  <tr key={p.id} className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--bg-elevated)] transition-colors">
                    <td className="px-4 py-3">
                      <span className="text-sm font-mono text-[var(--text-muted)]">
                        {p.seed_number ? `#${p.seed_number}` : '-'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <Avatar name={player?.full_name ?? ''} src={player?.avatar_url} size="sm" />
                        <span className="text-sm font-medium text-[var(--text-primary)]">{player?.full_name ?? 'Unknown'}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm font-mono text-[var(--text-muted)]">{elo}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ color: STATUS_COLORS[p.status], backgroundColor: `${STATUS_COLORS[p.status]}15` }}>
                        {p.status}
                      </span>
                    </td>
                    {canModify && (
                      <td className="px-4 py-3 text-right">
                        <Button size="sm" variant="ghost" onClick={() => handleRemove(p.id)} loading={actionLoading === p.id}>
                          <Trash2 className="w-3.5 h-3.5 text-[var(--color-danger)]" />
                        </Button>
                      </td>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>

        {entries.length === 0 && (
          <div className="p-8 text-center text-sm text-[var(--text-muted)]">
            No {isDoubles ? 'pairs' : 'participants'} yet. Add some to get started.
          </div>
        )}
      </div>

      {/* Add Dialog */}
      <Dialog open={addOpen} onClose={() => setAddOpen(false)} title={isDoubles ? 'Add Pair' : 'Add Participant'}>
        <form onSubmit={handleAdd} className="space-y-4">
          <Select
            label={isDoubles ? 'Player 1' : 'Player'}
            value={playerId}
            onChange={(e) => setPlayerId(e.target.value)}
            options={playerOptions}
          />
          {isDoubles && (
            <Select
              label="Player 2"
              value={player2Id}
              onChange={(e) => setPlayer2Id(e.target.value)}
              options={playerOptions}
            />
          )}
          <div className="flex gap-2 pt-2">
            <Button type="submit" loading={loading} className="flex-1">Add</Button>
            <Button variant="ghost" onClick={() => setAddOpen(false)} type="button">Cancel</Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
