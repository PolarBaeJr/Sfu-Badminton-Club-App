'use client';

import { useState } from 'react';
import { Button, Dialog, Input, Select } from '@badminton/ui';
import { getMaxGamesForFormat } from '@badminton/shared';
import type { TournamentMatchFormat } from '@badminton/shared';
import { enterMatchResult, enterWalkover, voidMatch, unvoidMatch, setMatchEntry } from '@/lib/tournament-actions';
import { tallyGames } from '@badminton/shared';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import type { TournamentEventRow, TournamentMatchRow } from '@/lib/tournament-types';

interface Props {
  match: TournamentMatchRow;
  event: TournamentEventRow;
  nameMap: Record<string, string>;
  seedMap: Record<string, number>;
  isDoubles: boolean;
  // Every entry still eligible to be placed in the draw, for the slot editor.
  entries: Array<{ id: string; name: string }>;
  onClose: () => void;
}

// Which panel the dialog opens on. A voided match can only be restored, and a
// match missing a side cannot be scored — so the dialog leads with the action
// that is actually available instead of an unusable score form.
type View = 'score' | 'walkover' | 'slots' | 'restore';

export function ScoreEntryDialog({ match, event, nameMap, seedMap, isDoubles, entries, onClose }: Props) {
  const matchFormat = event.match_format as TournamentMatchFormat;
  const maxGames = getMaxGamesForFormat(matchFormat);

  const aId = isDoubles ? match.pair_a_id : match.participant_a_id;
  const bId = isDoubles ? match.pair_b_id : match.participant_b_id;
  const nameA = nameMap[aId ?? ''] ?? 'Side A';
  const nameB = nameMap[bId ?? ''] ?? 'Side B';
  const seedA = seedMap[aId ?? ''];
  const seedB = seedMap[bId ?? ''];

  const isVoided = match.status === 'voided';
  const hasBothSides = Boolean(aId && bId);

  const [view, setView] = useState<View>(isVoided ? 'restore' : hasBothSides ? 'score' : 'slots');
  const [games, setGames] = useState<Array<{ a: string; b: string }>>(
    Array.from({ length: maxGames === 1 ? 1 : 2 }, () => ({ a: '', b: '' }))
  );
  const [loading, setLoading] = useState(false);
  const [walkoverLoading, setWalkoverLoading] = useState(false);
  const [walkoverReason, setWalkoverReason] = useState('');
  const [slotPick, setSlotPick] = useState<{ a: string; b: string }>({ a: '', b: '' });
  const { toast } = useToast();
  const router = useRouter();

  // Shared with the challenge result form so the two cannot disagree about who
  // won the same scoreline.
  const { winner: autoWinner } = tallyGames(
    games.map((g) => ({ side_a_score: g.a, side_b_score: g.b })),
  );

  // The dialog holds a snapshot of the match row, so any mutation invalidates
  // what it is displaying — close and let the refreshed bracket re-open it.
  function done(message: string) {
    toast(message, 'success');
    onClose();
    router.refresh();
  }

  function addGame() {
    if (games.length < maxGames) {
      setGames([...games, { a: '', b: '' }]);
    }
  }

  async function handleSubmit() {
    if (!autoWinner) { toast('Cannot determine winner from scores', 'error'); return; }
    setLoading(true);
    try {
      const scores = games
        .filter(g => g.a || g.b)
        .map(g => ({ a: parseInt(g.a) || 0, b: parseInt(g.b) || 0 }));
      const res = await enterMatchResult(match.id, scores, autoWinner);
      if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
      done('Score submitted');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  async function handleWalkover(winner: 'a' | 'b') {
    if (!walkoverReason.trim()) { toast('Enter a reason', 'error'); return; }
    setWalkoverLoading(true);
    try {
      const res = await enterWalkover(match.id, winner, walkoverReason);
      if (!res.ok) { toast(res.error, 'error'); setWalkoverLoading(false); return; }
      done('Walkover recorded');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setWalkoverLoading(false);
  }

  async function handleVoid() {
    setWalkoverLoading(true);
    try {
      const res = await voidMatch(match.id, walkoverReason || 'Voided by admin');
      if (!res.ok) { toast(res.error, 'error'); setWalkoverLoading(false); return; }
      done('Match voided');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setWalkoverLoading(false);
  }

  async function handleRestore() {
    setWalkoverLoading(true);
    try {
      const res = await unvoidMatch(match.id, walkoverReason || 'Restored by admin');
      if (!res.ok) { toast(res.error, 'error'); setWalkoverLoading(false); return; }
      done('Match restored — enter the result when it has been played');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setWalkoverLoading(false);
  }

  async function handleSetSlot(side: 'a' | 'b', entryId: string | null) {
    setWalkoverLoading(true);
    try {
      const res = await setMatchEntry(match.id, side, entryId, walkoverReason || 'Draw corrected by admin');
      if (!res.ok) { toast(res.error, 'error'); setWalkoverLoading(false); return; }
      done(entryId ? 'Entry placed' : 'Slot cleared');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setWalkoverLoading(false);
  }

  // Anyone already in this match is not a candidate for its other slot.
  const slotOptions = (occupiedByOther: string | null) => [
    { value: '', label: 'Select entry…' },
    ...entries
      .filter((e) => e.id !== aId && e.id !== bId && e.id !== occupiedByOther)
      .map((e) => ({ value: e.id, label: e.name })),
  ];

  function renderSlotRow(side: 'a' | 'b') {
    const id = side === 'a' ? aId : bId;
    const otherId = side === 'a' ? bId : aId;
    const pick = slotPick[side];

    return (
      <div className="space-y-2 rounded-lg border border-[var(--border)] p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">
            Side {side.toUpperCase()}
          </span>
          <span className="text-sm text-[var(--text-primary)]">
            {id ? (nameMap[id] ?? 'Unknown') : <em className="text-[var(--text-muted)]">Empty</em>}
          </span>
        </div>
        {id ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => handleSetSlot(side, null)}
            loading={walkoverLoading}
            className="w-full text-[var(--color-danger)] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none"
          >
            Clear this slot
          </Button>
        ) : (
          <div className="flex gap-2">
            <Select
              aria-label={`Entry for side ${side.toUpperCase()}`}
              value={pick}
              onChange={(e) => setSlotPick({ ...slotPick, [side]: e.target.value })}
              options={slotOptions(otherId)}
              className="flex-1"
            />
            <Button
              size="sm"
              onClick={() => handleSetSlot(side, pick)}
              disabled={!pick}
              loading={walkoverLoading}
              className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none"
            >
              Place
            </Button>
          </div>
        )}
      </div>
    );
  }

  const title = isVoided
    ? 'Restore Voided Match'
    : view === 'slots'
    ? 'Fix Match Slots'
    : 'Enter Match Score';

  return (
    <Dialog open={true} onClose={onClose} title={title}>
      <div className="space-y-5">
        {/* Players header */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-[var(--bg-elevated)]">
          <div className="text-center flex-1">
            {seedA && <span className="text-[10px] text-[var(--text-muted)] font-mono block">[{seedA}]</span>}
            <span className={`text-sm font-semibold ${autoWinner === 'a' ? 'text-[var(--color-success)]' : 'text-[var(--text-primary)]'}`}>
              {aId ? nameA : 'TBD'}
            </span>
          </div>
          <span className="text-xs text-[var(--text-muted)] px-3 font-bold">VS</span>
          <div className="text-center flex-1">
            {seedB && <span className="text-[10px] text-[var(--text-muted)] font-mono block">[{seedB}]</span>}
            <span className={`text-sm font-semibold ${autoWinner === 'b' ? 'text-[var(--color-success)]' : 'text-[var(--text-primary)]'}`}>
              {bId ? nameB : 'TBD'}
            </span>
          </div>
        </div>

        {/* Restore — the only thing a voided match can do */}
        {view === 'restore' && (
          <>
            <p className="text-sm text-[var(--text-muted)]">
              This match was voided{match.notes ? `: “${match.notes}”` : ''}. Restoring puts it back in
              play with no result. Any Elo the voided result applied is reversed, so replaying it counts once.
            </p>
            <Input
              label="Reason"
              value={walkoverReason}
              onChange={(e) => setWalkoverReason(e.target.value)}
              placeholder="Why is this match being restored?"
            />
            <Button onClick={handleRestore} loading={walkoverLoading} className="w-full focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
              Restore Match
            </Button>
          </>
        )}

        {/* Slot editor — the escape hatch for a next-round slot nothing will fill */}
        {view === 'slots' && (
          <>
            {!hasBothSides && (
              <p className="text-sm text-[var(--text-muted)]">
                One side of this match is empty, usually because the match feeding it was voided or was
                a branch of byes. Place an entry here, or send the side that is present through unopposed.
              </p>
            )}
            <Input
              label="Reason"
              value={walkoverReason}
              onChange={(e) => setWalkoverReason(e.target.value)}
              placeholder="Why is the draw being changed?"
            />
            {renderSlotRow('a')}
            {renderSlotRow('b')}

            {/* Exactly one side present: push them forward unopposed. Recorded as
                a walkover, which is unrated when there is no opponent. */}
            {(Boolean(aId) !== Boolean(bId)) && (
              <Button
                size="sm"
                onClick={() => handleWalkover(aId ? 'a' : 'b')}
                loading={walkoverLoading}
                className="w-full focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none"
              >
                Advance {aId ? nameA : nameB} unopposed
              </Button>
            )}

            {hasBothSides && (
              <Button variant="ghost" size="sm" onClick={() => setView('score')} className="w-full focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
                Back to Score Entry
              </Button>
            )}
          </>
        )}

        {/* Game scores */}
        {view === 'score' && (
          <>
            {games.map((g, i) => (
              <div key={i} className="flex items-center gap-3">
                <span className="text-xs text-[var(--text-muted)] w-16">Game {i + 1}</span>
                <Input
                  type="number"
                  value={g.a}
                  onChange={(e) => {
                    const updated = [...games];
                    updated[i] = { ...g, a: e.target.value };
                    setGames(updated);
                  }}
                  placeholder="0"
                  className="text-center"
                />
                <span className="text-[var(--text-muted)]">-</span>
                <Input
                  type="number"
                  value={g.b}
                  onChange={(e) => {
                    const updated = [...games];
                    updated[i] = { ...g, b: e.target.value };
                    setGames(updated);
                  }}
                  placeholder="0"
                  className="text-center"
                />
              </div>
            ))}

            {games.length < maxGames && (
              <Button variant="ghost" size="sm" onClick={addGame} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">+ Add Game</Button>
            )}

            {/* Winner indicator */}
            {autoWinner && (
              <div className="text-center text-sm" role="status" aria-live="polite">
                <span className="text-[var(--color-success)] font-medium">
                  Winner: {autoWinner === 'a' ? nameA : nameB}
                </span>
              </div>
            )}

            <div className="flex items-center justify-between pt-2">
              <Button variant="ghost" onClick={() => setView('walkover')} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
                Walkover / Void
              </Button>
              <Button onClick={handleSubmit} loading={loading} disabled={!autoWinner} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
                Submit Score
              </Button>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setView('slots')} className="w-full focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
              Fix match slots
            </Button>
          </>
        )}

        {/* Walkover/Void section */}
        {view === 'walkover' && (
          <>
            <Input
              label="Reason"
              value={walkoverReason}
              onChange={(e) => setWalkoverReason(e.target.value)}
              placeholder="Reason for walkover or void..."
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={() => handleWalkover('a')} loading={walkoverLoading} disabled={!aId} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
                Walkover → {nameA}
              </Button>
              <Button size="sm" onClick={() => handleWalkover('b')} loading={walkoverLoading} disabled={!bId} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
                Walkover → {nameB}
              </Button>
            </div>
            <p className="text-xs text-[var(--text-muted)]">
              Voiding erases the match: any Elo it applied is reversed and its winner is taken back out
              of the next round. It can be restored later.
            </p>
            <Button size="sm" variant="ghost" onClick={handleVoid} loading={walkoverLoading} className="w-full text-[var(--color-danger)] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
              Void Match
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setView(hasBothSides ? 'score' : 'slots')} className="w-full focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
              Back
            </Button>
          </>
        )}
      </div>
    </Dialog>
  );
}
