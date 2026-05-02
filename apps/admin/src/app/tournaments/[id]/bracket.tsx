'use client';

import { useState } from 'react';
import { Card, Badge, Button, Dialog, Input, Select } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';

interface MatchData {
  id: string;
  winner_side: string | null;
  score_summary: string | null;
  result_status: string;
  match_participants: Array<{
    id: string;
    team_side: string;
    player: { full_name: string };
  }>;
  match_games: Array<{
    game_number: number;
    side_a_score: number;
    side_b_score: number;
  }>;
}

interface Participant {
  id: string;
  seed: number | null;
  placement: number | null;
  player: { full_name: string };
}

interface Props {
  tournamentId: string;
  bracketSize: number;
  matches: MatchData[];
  participants: Participant[];
  status: string;
  placementBonusEnabled: boolean;
}

export function TournamentBracket({ tournamentId, bracketSize, matches, participants, status, placementBonusEnabled }: Props) {
  const [scoreDialogOpen, setScoreDialogOpen] = useState(false);
  const [selectedMatch, setSelectedMatch] = useState<MatchData | null>(null);
  const [winnerSide, setWinnerSide] = useState('a');
  const [games, setGames] = useState([{ game_number: 1, side_a_score: '', side_b_score: '' }]);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  // Calculate rounds
  const totalRounds = Math.log2(bracketSize);
  const rounds: { name: string; matchCount: number }[] = [];
  for (let r = 0; r < totalRounds; r++) {
    const matchCount = bracketSize / Math.pow(2, r + 1);
    const name = r === totalRounds - 1 ? 'Final' : r === totalRounds - 2 ? 'Semi-Final' : `Round ${r + 1}`;
    rounds.push({ name, matchCount });
  }

  function openScoreDialog(match: MatchData) {
    setSelectedMatch(match);
    setWinnerSide('a');
    setGames([{ game_number: 1, side_a_score: '', side_b_score: '' }]);
    setScoreDialogOpen(true);
  }

  function addGame() {
    setGames([...games, { game_number: games.length + 1, side_a_score: '', side_b_score: '' }]);
  }

  async function submitScore() {
    if (!selectedMatch) return;
    setLoading(true);
    try {
      const res = await fetch('/api/tournament-match-score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          match_id: selectedMatch.id,
          winner_side: winnerSide,
          games: games.map(g => ({
            game_number: g.game_number,
            side_a_score: parseInt(g.side_a_score) || 0,
            side_b_score: parseInt(g.side_b_score) || 0,
          })),
        }),
      });
      if (!res.ok) throw new Error('Failed to submit score');
      toast('Score submitted', 'success');
      setScoreDialogOpen(false);
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  async function applyBonuses() {
    setLoading(true);
    try {
      const res = await fetch('/api/tournament-bonuses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tournament_id: tournamentId }),
      });
      if (!res.ok) throw new Error('Failed to apply bonuses');
      toast('Placement bonuses applied', 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  return (
    <>
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Bracket</h2>
          {status === 'completed' && placementBonusEnabled && (
            <Button size="sm" onClick={applyBonuses} loading={loading}>
              Apply Placement Bonuses
            </Button>
          )}
        </div>

        {matches.length > 0 ? (
          <div className="overflow-x-auto">
            <div className="flex gap-8 min-w-fit">
              {rounds.map((round, roundIdx) => (
                <div key={roundIdx} className="flex flex-col gap-4 min-w-[240px]">
                  <h3 className="text-sm font-medium text-[var(--text-muted)] text-center">{round.name}</h3>
                  {/* Show matches for this round */}
                  {matches
                    .filter((_, mi) => {
                      let cumulative = 0;
                      for (let r = 0; r <= roundIdx; r++) {
                        const roundData = rounds[r];
                        if (!roundData) return false;
                        if (r === roundIdx) return mi >= cumulative && mi < cumulative + roundData.matchCount;
                        cumulative += roundData.matchCount;
                      }
                      return false;
                    })
                    .map((m) => {
                      const sideA = m.match_participants?.filter(p => p.team_side === 'a') || [];
                      const sideB = m.match_participants?.filter(p => p.team_side === 'b') || [];
                      return (
                        <div key={m.id} className="border border-[var(--border)] overflow-hidden">
                          <div className={`p-2 flex items-center justify-between text-sm ${m.winner_side === 'a' ? 'bg-[var(--color-success)]/10' : 'bg-[var(--border-hover)]'}`}>
                            <span className={m.winner_side === 'a' ? 'text-[var(--color-success)] font-medium' : 'text-[var(--text-secondary)]'}>
                              {sideA.map(p => p.player?.full_name).join(' & ') || 'TBD'}
                            </span>
                            {m.match_games?.[0] && <span className="font-mono text-xs">{m.match_games.map(g => g.side_a_score).join('-')}</span>}
                          </div>
                          <div className="border-t border-[var(--border)]" />
                          <div className={`p-2 flex items-center justify-between text-sm ${m.winner_side === 'b' ? 'bg-[var(--color-success)]/10' : 'bg-[var(--border-hover)]'}`}>
                            <span className={m.winner_side === 'b' ? 'text-[var(--color-success)] font-medium' : 'text-[var(--text-secondary)]'}>
                              {sideB.map(p => p.player?.full_name).join(' & ') || 'TBD'}
                            </span>
                            {m.match_games?.[0] && <span className="font-mono text-xs">{m.match_games.map(g => g.side_b_score).join('-')}</span>}
                          </div>
                          {!m.winner_side && status === 'active' && sideA.length > 0 && sideB.length > 0 && (
                            <button
                              onClick={() => openScoreDialog(m)}
                              className="w-full text-center text-xs text-[var(--ds-accent)] py-1 bg-[var(--bg-card)] hover:bg-[var(--border-hover)] transition-colors border-t border-[var(--border)]"
                            >
                              Enter Score
                            </button>
                          )}
                          {m.result_status === 'confirmed' && (
                            <div className="text-center">
                              <Badge variant="success" className="text-[10px]">Confirmed</Badge>
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-[var(--text-muted)] text-center py-8">
            No bracket matches created yet. Create matches for this tournament to see the bracket.
          </p>
        )}
      </Card>

      {/* Standings */}
      {participants.some(p => p.placement) && (
        <Card>
          <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-3">Final Standings</h2>
          <div className="space-y-2">
            {participants
              .filter(p => p.placement)
              .sort((a, b) => (a.placement ?? 99) - (b.placement ?? 99))
              .map((p) => {
                const player = p.player as Record<string, unknown>;
                const placementLabel = p.placement === 1 ? 'Champion' : p.placement === 2 ? 'Finalist' : p.placement && p.placement <= 4 ? 'Semi-finalist' : `#${p.placement}`;
                return (
                  <div key={p.id} className="flex items-center justify-between p-2 bg-[var(--border-hover)]">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[var(--ds-accent)] font-bold w-6">#{p.placement}</span>
                      <span className="text-sm text-[var(--text-primary)]">{player?.full_name as string}</span>
                    </div>
                    <Badge variant={p.placement === 1 ? 'success' : 'neutral'}>{placementLabel}</Badge>
                  </div>
                );
              })}
          </div>
        </Card>
      )}

      {/* Score Entry Dialog */}
      <Dialog open={scoreDialogOpen} onClose={() => setScoreDialogOpen(false)} title="Enter Match Score">
        {selectedMatch && (
          <div className="space-y-4">
            <Select
              label="Winner"
              options={[
                { value: 'a', label: selectedMatch.match_participants?.filter(p => p.team_side === 'a').map(p => p.player?.full_name).join(' & ') || 'Side A' },
                { value: 'b', label: selectedMatch.match_participants?.filter(p => p.team_side === 'b').map(p => p.player?.full_name).join(' & ') || 'Side B' },
              ]}
              value={winnerSide}
              onChange={(e) => setWinnerSide(e.target.value)}
            />
            {games.map((g, i) => (
              <div key={i} className="flex gap-2 items-end">
                <Input
                  label={`Game ${g.game_number} - Side A`}
                  type="number"
                  value={g.side_a_score}
                  onChange={(e) => {
                    const updated = [...games];
                    updated[i] = { ...g, side_a_score: e.target.value };
                    setGames(updated);
                  }}
                />
                <span className="pb-3 text-[var(--text-muted)]">-</span>
                <Input
                  label="Side B"
                  type="number"
                  value={g.side_b_score}
                  onChange={(e) => {
                    const updated = [...games];
                    updated[i] = { ...g, side_b_score: e.target.value };
                    setGames(updated);
                  }}
                />
              </div>
            ))}
            {games.length < 3 && (
              <Button variant="ghost" size="sm" onClick={addGame}>+ Add Game</Button>
            )}
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setScoreDialogOpen(false)}>Cancel</Button>
              <Button onClick={submitScore} loading={loading} className="flex-1">Submit Score</Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
