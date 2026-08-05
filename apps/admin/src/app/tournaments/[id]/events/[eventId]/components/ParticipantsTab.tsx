'use client';

import { useState, useRef } from 'react';
import { Button, Dialog, Select, AvatarChip, useConfirm } from '@badminton/ui';
import {
  addParticipantToEvent,
  removeParticipantFromEvent,
  addPairToEvent,
  removePairFromEvent,
  autoSeedEventByElo,
  updateParticipantSeed,
  updatePairSeed,
  clearSeeds,
  withdrawParticipant,
  withdrawPair,
} from '@/lib/tournament-actions';
import { nextPowerOf2, pickOne, eventHasDraw, isOutOfEvent } from '@badminton/shared';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { Plus, Trash2, ArrowUpDown, AlertTriangle, XCircle, Pencil, UserMinus } from 'lucide-react';
import type { TournamentEventRow, ParticipantWithPlayer, PairWithPlayers } from '@/lib/tournament-types';

interface Props {
  event: TournamentEventRow;
  participants: ParticipantWithPlayer[];
  pairs: PairWithPlayers[];
  allPlayers: Array<{ id: string; full_name: string }>;
  isDoubles: boolean;
}

// Raw enum values ("checked_in") leaked straight into the table. Underscores
// and lowercase read as database internals rather than a status an exec is
// meant to act on.
const STATUS_LABELS: Record<string, string> = {
  registered: 'Registered',
  checked_in: 'Checked In',
  withdrawn: 'WITHDRAWN',
  disqualified: 'DISQUALIFIED',
  no_show: 'NO SHOW',
};

// The two that take someone OUT of the event are shouted, so they are
// unmissable when scanning a long list; the ordinary states are not.
function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.replace(/_/g, ' ');
}

const STATUS_COLORS: Record<string, string> = {
  registered: 'var(--text-muted)',
  checked_in: 'var(--color-success)',
  withdrawn: 'var(--color-danger)',
  disqualified: 'var(--color-danger)',
  no_show: 'var(--color-warning)',
};

function SeedCell({
  entryId,
  seedNumber,
  canEdit,
  maxSeed,
  usedSeeds,
  onSave,
}: {
  entryId: string;
  seedNumber: number | null;
  canEdit: boolean;
  maxSeed: number;
  usedSeeds: Set<number>;
  onSave: (id: string, seed: number | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(seedNumber != null ? String(seedNumber) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    if (!canEdit) return;
    setValue(seedNumber != null ? String(seedNumber) : '');
    setError('');
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }

  async function commit() {
    const parsed = value.trim() === '' ? null : parseInt(value, 10);
    if (parsed !== null && (isNaN(parsed) || parsed < 1)) {
      setError('Min 1');
      return;
    }
    if (parsed !== null && parsed > maxSeed) {
      setError(`Max ${maxSeed}`);
      return;
    }
    if (parsed !== null && parsed !== seedNumber && usedSeeds.has(parsed)) {
      setError('Taken');
      return;
    }
    if (parsed === seedNumber) { setEditing(false); return; }
    setSaving(true);
    await onSave(entryId, parsed);
    setSaving(false);
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          type="number"
          min={1}
          max={maxSeed}
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(''); }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          aria-label="Seed number"
          className={`w-12 text-center text-sm font-mono bg-[var(--bg-elevated)] border rounded px-1 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 ${error ? 'border-[var(--color-danger)]' : 'border-[var(--color-accent)]'}`}
          autoFocus
        />
        {error && <span className="text-[10px] text-[var(--color-danger)]">{error}</span>}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={startEdit}
      disabled={!canEdit || saving}
      aria-label={`Edit seed${seedNumber != null ? ` ${seedNumber}` : ''}`}
      className={`group flex items-center gap-1 text-sm font-mono text-[var(--text-muted)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none rounded ${canEdit ? 'hover:text-[var(--text-primary)] cursor-pointer' : ''}`}
    >
      {saving ? (
        <span className="opacity-50">…</span>
      ) : (
        <>
          <span>{seedNumber != null ? `#${seedNumber}` : '—'}</span>
          {canEdit && (
            <Pencil className="w-3 h-3 opacity-0 group-hover:opacity-50 transition-opacity" />
          )}
        </>
      )}
    </button>
  );
}

export function ParticipantsTab({ event, participants, pairs, allPlayers, isDoubles }: Props) {
  const [addOpen, setAddOpen] = useState(false);
  const [playerId, setPlayerId] = useState('');
  const [player2Id, setPlayer2Id] = useState('');
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const { toast } = useToast();
  const router = useRouter();
  const confirm = useConfirm();

  const entries: Array<ParticipantWithPlayer | PairWithPlayers> = isDoubles ? pairs : participants;
  const activeEntries = entries.filter((e) => !isOutOfEvent(e.status));
  const bracketSize = nextPowerOf2(activeEntries.length);
  const byes = bracketSize - activeEntries.length;
  const canModify = event.status === 'registration';
  const drawLocked = event.draw_locked as boolean;
  // Deleting an entry is only safe before a draw exists. After that the only
  // coherent exit is a withdrawal, which forfeits the matches they are already
  // seeded into — and it has to be reachable here, because this is the moment
  // the player themselves is no longer allowed to do it.
  const eventLive = event.status === 'live';
  const canWithdraw = eventHasDraw(event.status) && event.status !== 'completed';
  const showActions = (canModify && !drawLocked) || canWithdraw;

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!playerId) return;
    setLoading(true);
    try {
      if (isDoubles) {
        if (!player2Id) { toast('Select both players', 'error'); setLoading(false); return; }
        await addPairToEvent(event.id, playerId, player2Id);
      } else {
        await addParticipantToEvent(event.id, playerId);
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

  async function handleWithdraw(id: string, name: string) {
    const ok = await confirm({
      title: `Withdraw ${name}?`,
      message: eventLive
        ? 'Their unplayed matches are forfeited to their opponents, and the winners advance. Matches already played are left alone.'
        : 'The event has not started, so nothing is forfeited yet. Regenerate the bracket to drop them from the draw, or go live and their matches will be forfeited then.',
      confirmLabel: 'Withdraw',
      danger: true,
    });
    if (!ok) return;

    setActionLoading(id);
    const res = isDoubles ? await withdrawPair(id) : await withdrawParticipant(id);
    if (!res.ok) {
      toast(res.error, 'error');
      setActionLoading(null);
      return;
    }
    const { forfeited, unresolved, deferredToGoLive } = res.data;
    toast(
      forfeited > 0
        ? `Withdrawn — ${forfeited} match${forfeited === 1 ? '' : 'es'} forfeited`
        : 'Withdrawn',
      'success',
    );
    if (deferredToGoLive) {
      toast('They are still in the draw. Regenerate the bracket, or their matches will be forfeited when the event goes live.', 'info');
    }
    // Their opponent is not decided yet, so there is nothing to forfeit to
    // until the feeder match finishes. Say it rather than let it look like the
    // forfeit silently missed one.
    if (unresolved > 0) {
      toast(`${unresolved} match${unresolved === 1 ? '' : 'es'} will be forfeited once the opponent is known`, 'info');
    }
    router.refresh();
    setActionLoading(null);
  }

  async function handleAutoSeed() {
    setLoading(true);
    try {
      await autoSeedEventByElo(event.id);
      toast('Auto-seeded by Elo', 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  async function handleSeedSave(id: string, seed: number | null) {
    try {
      if (isDoubles) {
        await updatePairSeed(id, seed);
      } else {
        await updateParticipantSeed(id, seed);
      }
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to update seed', 'error');
    }
  }

  function renderActions(id: string, name: string, status: string) {
    // An entry that is already out of the event has no next step — offering
    // "withdraw" on someone who has withdrawn is how a bracket gets a second
    // forfeit applied to it.
    if (isOutOfEvent(status)) return <span className="text-xs text-[var(--text-muted)]">—</span>;

    if (canModify && !drawLocked) {
      return (
        <Button size="sm" variant="ghost" onClick={() => handleRemove(id)} loading={actionLoading === id} aria-label={`Remove ${name}`} className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none">
          <Trash2 className="w-3.5 h-3.5 text-[var(--color-danger)]" />
        </Button>
      );
    }

    if (canWithdraw) {
      return (
        <Button size="sm" variant="ghost" onClick={() => handleWithdraw(id, name)} loading={actionLoading === id} aria-label={`Withdraw ${name}`} className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none">
          <UserMinus className="w-3.5 h-3.5 mr-1 text-[var(--color-danger)]" />
          <span className="text-xs">Withdraw</span>
        </Button>
      );
    }

    return null;
  }

  const usedSeeds = new Set(
    entries.map((e) => e.seed_number).filter((s): s is number => s != null)
  );

  const registeredPlayerIds = new Set(
    isDoubles
      ? pairs.flatMap((p) => [p.player1_id, p.player2_id])
      : participants.map((p) => p.player_id)
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
          {drawLocked && (
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-[var(--color-warning)]/15 text-[var(--color-warning)]" role="status">
              Draw Locked
            </span>
          )}
        </div>
        <div className="flex gap-2">
          {canModify && !drawLocked && (
            <>
              <Button size="sm" variant="ghost" className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none" onClick={async () => {
                setLoading(true);
                try {
                  await clearSeeds(event.id);
                  toast('Seeds cleared', 'success');
                  router.refresh();
                } catch (err) {
                  toast(err instanceof Error ? err.message : 'Failed', 'error');
                }
                setLoading(false);
              }} loading={loading}>
                <XCircle className="w-3.5 h-3.5 mr-1" /> Clear Seeds
              </Button>
              <Button size="sm" variant="ghost" className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none" onClick={handleAutoSeed} loading={loading}>
                <ArrowUpDown className="w-3.5 h-3.5 mr-1" /> Auto-Seed
              </Button>
              <Button size="sm" className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none" onClick={() => setAddOpen(true)}>
                <Plus className="w-3.5 h-3.5 mr-1" /> Add {isDoubles ? 'Pair' : 'Player'}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Bye preview */}
      {byes > 0 && event.format !== 'round_robin' && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--color-warning)]/10 border border-[var(--color-warning)]/20">
          <AlertTriangle className="w-4 h-4 text-[var(--color-warning)] flex-shrink-0" />
          <span className="text-sm text-[var(--color-warning)]">
            {activeEntries.length} {isDoubles ? 'pairs' : 'players'} → {bracketSize}-slot bracket with {byes} bye{byes > 1 ? 's' : ''}. Seeds #1–{byes} get first-round byes.
          </span>
        </div>
      )}

      {/* Participants table */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider px-4 py-3 w-20">
                Seed
                {canModify && !drawLocked && (
                  <span className="ml-1 text-[10px] text-[var(--text-muted)] normal-case font-normal">(click to edit)</span>
                )}
              </th>
              <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider px-4 py-3">
                {isDoubles ? 'Pair' : 'Player'}
              </th>
              <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider px-4 py-3 w-24">Elo</th>
              <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider px-4 py-3 w-28">Status</th>
              {showActions && (
                <th className="text-right text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider px-4 py-3 w-32">Actions</th>
              )}
            </tr>
          </thead>
          <tbody>
            {isDoubles ? (
              pairs.map((pair) => (
                <tr key={pair.id} className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--bg-elevated)] transition-colors">
                  <td className="px-4 py-3">
                    <SeedCell
                      entryId={pair.id}
                      seedNumber={pair.seed_number}
                      canEdit={canModify && !drawLocked}
                      maxSeed={activeEntries.length}
                      usedSeeds={usedSeeds}
                      onSave={handleSeedSave}
                    />
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
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full" role="status" style={{ color: STATUS_COLORS[pair.status], backgroundColor: `${STATUS_COLORS[pair.status]}15` }}>
                      <span className="sr-only">Status: </span>{statusLabel(pair.status)}
                    </span>
                  </td>
                  {showActions && (
                    <td className="px-4 py-3 text-right">
                      {renderActions(pair.id, pair.pair_name ?? `${pair.player1?.full_name} / ${pair.player2?.full_name}`, pair.status)}
                    </td>
                  )}
                </tr>
              ))
            ) : (
              participants.map((p) => {
                const player = p.player;
                const ratings = pickOne(player?.ratings);
                const elo = ratings?.singles_elo ?? p.elo_before ?? '-';
                return (
                  <tr key={p.id} className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--bg-elevated)] transition-colors">
                    <td className="px-4 py-3">
                      <SeedCell
                        entryId={p.id}
                        seedNumber={p.seed_number}
                        canEdit={canModify && !drawLocked}
                        maxSeed={activeEntries.length}
                        usedSeeds={usedSeeds}
                        onSave={handleSeedSave}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <AvatarChip name={player?.full_name ?? ''} src={player?.avatar_url} size="sm" id={player?.id} />
                        <span className="text-sm font-medium text-[var(--text-primary)]">{player?.full_name ?? 'Unknown'}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm font-mono text-[var(--text-muted)]">{elo}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full" role="status" style={{ color: STATUS_COLORS[p.status], backgroundColor: `${STATUS_COLORS[p.status]}15` }}>
                        <span className="sr-only">Status: </span>{statusLabel(p.status)}
                      </span>
                    </td>
                    {showActions && (
                      <td className="px-4 py-3 text-right">
                        {renderActions(p.id, player?.full_name ?? 'participant', p.status)}
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
              options={playerOptions.filter(p => p.value !== playerId)}
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
