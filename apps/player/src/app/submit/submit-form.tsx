'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { submitQrMatchResult } from '@/lib/actions';

type Props = {
  challengeId: string;
  matchType: 'singles' | 'doubles';
  format: string;
  nameA: string;
  nameB: string;
  myTeamSide: 'a' | 'b';
};

type GameScore = { game_number: number; side_a_score: number; side_b_score: number };

function decideWinner(games: GameScore[]): 'a' | 'b' | null {
  let aSets = 0;
  let bSets = 0;
  for (const g of games) {
    if (g.side_a_score === 0 && g.side_b_score === 0) continue;
    if (g.side_a_score > g.side_b_score) aSets++;
    else if (g.side_b_score > g.side_a_score) bSets++;
  }
  if (aSets === 0 && bSets === 0) return null;
  if (aSets > bSets) return 'a';
  if (bSets > aSets) return 'b';
  return null;
}

export function SubmitForm({
  challengeId,
  matchType,
  format,
  nameA,
  nameB,
  myTeamSide,
}: Props) {
  const isBO3Default = format === 'bo3_21';
  const [bestOf3, setBestOf3] = useState(isBO3Default);
  const [games, setGames] = useState<GameScore[]>(() => {
    const base: GameScore[] = [
      { game_number: 1, side_a_score: 0, side_b_score: 0 },
    ];
    if (isBO3Default) {
      base.push({ game_number: 2, side_a_score: 0, side_b_score: 0 });
      base.push({ game_number: 3, side_a_score: 0, side_b_score: 0 });
    }
    return base;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const router = useRouter();

  const winner = useMemo(() => decideWinner(games), [games]);

  function setGame(i: number, side: 'a' | 'b', raw: string) {
    const value = Math.max(0, Math.min(99, parseInt(raw, 10) || 0));
    setGames((prev) => {
      const next = [...prev];
      const current = next[i] ?? { game_number: i + 1, side_a_score: 0, side_b_score: 0 };
      next[i] = {
        game_number: current.game_number,
        side_a_score: side === 'a' ? value : current.side_a_score,
        side_b_score: side === 'b' ? value : current.side_b_score,
      };
      return next;
    });
  }

  function toggleBO3(enable: boolean) {
    setBestOf3(enable);
    setGames((prev) => {
      if (enable && prev.length < 3) {
        return [
          prev[0] ?? { game_number: 1, side_a_score: 0, side_b_score: 0 },
          { game_number: 2, side_a_score: 0, side_b_score: 0 },
          { game_number: 3, side_a_score: 0, side_b_score: 0 },
        ];
      }
      if (!enable) return [prev[0] ?? { game_number: 1, side_a_score: 0, side_b_score: 0 }];
      return prev;
    });
  }

  async function handleSubmit() {
    setError('');
    if (!winner) {
      setError('Enter at least one game with a clear winner.');
      return;
    }
    // Drop empty extra games for BO3 when set 3 wasn't played.
    const validGames = games.filter((g, i) => i === 0 || g.side_a_score > 0 || g.side_b_score > 0);
    setLoading(true);
    try {
      await submitQrMatchResult(challengeId, {
        winner_side: winner,
        games: validGames,
      });
      setSuccess(true);
      setTimeout(() => router.push('/challenges'), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit');
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div className="submit-shell">
        <div className="submit-card" style={{ textAlign: 'center' }}>
          <div className="submit-label" style={{ color: 'var(--color-accent)' }}>SUBMITTED</div>
          <h1 className="submit-heading">Result recorded</h1>
          <p className="submit-body">
            Your opponent will be asked to confirm the score. Redirecting…
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="submit-shell">
      <div className="submit-card">
        <div className="submit-label">MATCH RESULT</div>

        <div className="players-row">
          <div className={`player-name ${myTeamSide === 'a' ? 'is-me' : ''}`}>{nameA}</div>
          <div className="vs-divider">vs</div>
          <div className={`player-name ${myTeamSide === 'b' ? 'is-me' : ''}`}>{nameB}</div>
        </div>

        <div className="score-block">
          <div className="score-row-header">
            <span>Set 1</span>
            <div className="bo3-toggle">
              <label>
                <input
                  type="checkbox"
                  checked={bestOf3}
                  onChange={(e) => toggleBO3(e.target.checked)}
                />
                <span>Best of 3</span>
              </label>
            </div>
          </div>

          {games.map((g, i) => (
            <div key={i} className="score-row">
              <div className="score-row-label">Set {g.game_number}</div>
              <div className="score-inputs">
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={99}
                  value={g.side_a_score}
                  onChange={(e) => setGame(i, 'a', e.target.value)}
                  className="score-input"
                />
                <span className="score-sep">–</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={99}
                  value={g.side_b_score}
                  onChange={(e) => setGame(i, 'b', e.target.value)}
                  className="score-input"
                />
              </div>
            </div>
          ))}

          {winner && (
            <div className="winner-hint">
              Winner: <strong>{winner === 'a' ? nameA : nameB}</strong>
            </div>
          )}
        </div>

        {error && <div className="submit-error">{error}</div>}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={!winner || loading}
          className="submit-btn"
        >
          {loading ? 'Submitting…' : 'Submit Result'}
        </button>

        <div className="submit-meta">
          {matchType} &middot; {format.replace(/_/g, ' ')}
        </div>
      </div>
    </div>
  );
}
