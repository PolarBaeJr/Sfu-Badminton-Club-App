'use client';

import { useState } from 'react';
import { Button, Dialog, Input, Select } from '@badminton/ui';
import { getMaxGamesForFormat, previewEloChange } from '@badminton/shared';
import type { TournamentMatchFormat, MatchFormat } from '@badminton/shared';
import { enterMatchResult, enterWalkover, voidMatch } from '@/lib/tournament-actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import type { TournamentEventRow, TournamentMatchRow } from '@/lib/tournament-types';

interface Props {
  match: TournamentMatchRow;
  event: TournamentEventRow;
  nameMap: Record<string, string>;
  seedMap: Record<string, number>;
  isDoubles: boolean;
  onClose: () => void;
}

function toEloFormat(mf: TournamentMatchFormat): MatchFormat {
  switch (mf) {
    case 'best_of_3_to_21': return 'bo3_21';
    case 'one_game_21': return 'single_21';
    case 'one_game_15': return 'single_15';
    case 'one_game_11': return 'single_11';
  }
}

export function ScoreEntryDialog({ match, event, nameMap, seedMap, isDoubles, onClose }: Props) {
  const matchFormat = event.match_format as TournamentMatchFormat;
  const maxGames = getMaxGamesForFormat(matchFormat);

  const aId = isDoubles ? match.pair_a_id : match.participant_a_id;
  const bId = isDoubles ? match.pair_b_id : match.participant_b_id;
  const nameA = nameMap[aId ?? ''] ?? 'Side A';
  const nameB = nameMap[bId ?? ''] ?? 'Side B';
  const seedA = seedMap[aId ?? ''];
  const seedB = seedMap[bId ?? ''];

  const [games, setGames] = useState<Array<{ a: string; b: string }>>(
    Array.from({ length: maxGames === 1 ? 1 : 2 }, () => ({ a: '', b: '' }))
  );
  const [loading, setLoading] = useState(false);
  const [walkoverLoading, setWalkoverLoading] = useState(false);
  const [walkoverReason, setWalkoverReason] = useState('');
  const [showWalkover, setShowWalkover] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  // Auto-detect winner
  let aGamesWon = 0;
  let bGamesWon = 0;
  for (const g of games) {
    const a = parseInt(g.a) || 0;
    const b = parseInt(g.b) || 0;
    if (a > b) aGamesWon++;
    else if (b > a) bGamesWon++;
  }
  const autoWinner: 'a' | 'b' | null = aGamesWon > bGamesWon ? 'a' : bGamesWon > aGamesWon ? 'b' : null;

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
      await enterMatchResult(match.id, scores, autoWinner);
      toast('Score submitted', 'success');
      onClose();
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  async function handleWalkover(winner: 'a' | 'b') {
    if (!walkoverReason.trim()) { toast('Enter a reason', 'error'); return; }
    setWalkoverLoading(true);
    try {
      await enterWalkover(match.id, winner, walkoverReason);
      toast('Walkover recorded', 'success');
      onClose();
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setWalkoverLoading(false);
  }

  async function handleVoid() {
    setWalkoverLoading(true);
    try {
      await voidMatch(match.id, walkoverReason || 'Voided by admin');
      toast('Match voided', 'success');
      onClose();
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setWalkoverLoading(false);
  }

  return (
    <Dialog open={true} onClose={onClose} title="Enter Match Score">
      <div className="space-y-5">
        {/* Players header */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-[var(--bg-elevated)]">
          <div className="text-center flex-1">
            {seedA && <span className="text-[10px] text-[var(--text-muted)] font-mono block">[{seedA}]</span>}
            <span className={`text-sm font-semibold ${autoWinner === 'a' ? 'text-[var(--color-success)]' : 'text-[var(--text-primary)]'}`}>
              {nameA}
            </span>
          </div>
          <span className="text-xs text-[var(--text-muted)] px-3 font-bold">VS</span>
          <div className="text-center flex-1">
            {seedB && <span className="text-[10px] text-[var(--text-muted)] font-mono block">[{seedB}]</span>}
            <span className={`text-sm font-semibold ${autoWinner === 'b' ? 'text-[var(--color-success)]' : 'text-[var(--text-primary)]'}`}>
              {nameB}
            </span>
          </div>
        </div>

        {/* Game scores */}
        {!showWalkover && (
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
              <Button variant="ghost" onClick={() => setShowWalkover(true)} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
                Walkover / Void
              </Button>
              <Button onClick={handleSubmit} loading={loading} disabled={!autoWinner} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
                Submit Score
              </Button>
            </div>
          </>
        )}

        {/* Walkover/Void section */}
        {showWalkover && (
          <>
            <Input
              label="Reason"
              value={walkoverReason}
              onChange={(e) => setWalkoverReason(e.target.value)}
              placeholder="Reason for walkover or void..."
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={() => handleWalkover('a')} loading={walkoverLoading} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
                Walkover → {nameA}
              </Button>
              <Button size="sm" onClick={() => handleWalkover('b')} loading={walkoverLoading} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
                Walkover → {nameB}
              </Button>
            </div>
            <Button size="sm" variant="ghost" onClick={handleVoid} loading={walkoverLoading} className="w-full text-[var(--color-danger)] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
              Void Match
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowWalkover(false)} className="w-full focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">
              Back to Score Entry
            </Button>
          </>
        )}
      </div>
    </Dialog>
  );
}
