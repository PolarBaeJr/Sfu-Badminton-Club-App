'use client';

import { useState, useMemo } from 'react';
import { Badge } from '@badminton/ui';
import { ScoreEntryDialog } from './ScoreEntryDialog';
import { Trophy } from 'lucide-react';

interface Props {
  event: Record<string, unknown>;
  matches: unknown[];
  participants: unknown[];
  pairs: unknown[];
  isDoubles: boolean;
}

export function RoundRobinTab({ event, matches, participants, pairs, isDoubles }: Props) {
  const [scoreMatch, setScoreMatch] = useState<any>(null);
  const allMatches = matches as any[];
  const isLive = event.status === 'live' || event.status === 'bracket_generated';

  const entries = (isDoubles ? pairs : participants) as any[];

  // Build name/seed maps
  const nameMap: Record<string, string> = {};
  const seedMap: Record<string, number> = {};
  for (const e of entries) {
    const name = isDoubles
      ? e.pair_name ?? `${e.player1?.full_name ?? '?'} / ${e.player2?.full_name ?? '?'}`
      : e.player?.full_name ?? 'Unknown';
    nameMap[e.id] = name;
    if (e.seed_number) seedMap[e.id] = e.seed_number;
  }

  // Compute standings
  const standings = useMemo(() => {
    const stats: Record<string, { id: string; name: string; wins: number; losses: number; pf: number; pa: number }> = {};
    for (const e of entries) {
      stats[e.id] = { id: e.id, name: nameMap[e.id] ?? 'Unknown', wins: 0, losses: 0, pf: 0, pa: 0 };
    }
    for (const m of allMatches) {
      if (m.status !== 'completed' && m.status !== 'walkover') continue;
      const aId = isDoubles ? m.pair_a_id : m.participant_a_id;
      const bId = isDoubles ? m.pair_b_id : m.participant_b_id;
      const winnerId = isDoubles ? m.winner_pair_id : m.winner_participant_id;
      if (!aId || !bId || !stats[aId] || !stats[bId]) continue;
      if (winnerId === aId) { stats[aId].wins++; stats[bId].losses++; }
      else if (winnerId === bId) { stats[bId].wins++; stats[aId].losses++; }
      for (const g of (m.scores ?? []) as any[]) {
        stats[aId].pf += g.a; stats[aId].pa += g.b;
        stats[bId].pf += g.b; stats[bId].pa += g.a;
      }
    }
    return Object.values(stats).sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      return (b.pf - b.pa) - (a.pf - a.pa);
    });
  }, [allMatches, entries, isDoubles, nameMap]);

  // Group matches by round
  const rounds: Record<number, any[]> = {};
  for (const m of allMatches) {
    if (!rounds[m.round_number]) rounds[m.round_number] = [];
    rounds[m.round_number]!.push(m);
  }
  const roundNumbers = Object.keys(rounds).map(Number).sort((a, b) => a - b);

  if (allMatches.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-8 text-center">
        <Trophy className="w-8 h-8 mx-auto mb-3 text-[var(--text-muted)] opacity-50" />
        <p className="text-sm text-[var(--text-muted)]">Round robin matches not generated yet.</p>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-6">
        {/* Standings Table */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden" role="region" aria-label="Round robin standings">
          <div className="px-4 py-3 border-b border-[var(--border)]">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Standings</h3>
          </div>
          <table className="w-full" aria-label="Standings table">
            <thead>
              <tr className="border-b border-[var(--border)]">
                <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase px-4 py-2 w-10">#</th>
                <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase px-4 py-2">Player</th>
                <th className="text-center text-xs font-medium text-[var(--text-muted)] uppercase px-3 py-2 w-12">W</th>
                <th className="text-center text-xs font-medium text-[var(--text-muted)] uppercase px-3 py-2 w-12">L</th>
                <th className="text-center text-xs font-medium text-[var(--text-muted)] uppercase px-3 py-2 w-14">PF</th>
                <th className="text-center text-xs font-medium text-[var(--text-muted)] uppercase px-3 py-2 w-14">PA</th>
                <th className="text-center text-xs font-medium text-[var(--text-muted)] uppercase px-3 py-2 w-14">+/-</th>
              </tr>
            </thead>
            <tbody>
              {standings.map((s, i) => (
                <tr key={s.id} className="border-b border-[var(--border)] last:border-b-0">
                  <td className="px-4 py-2 text-sm font-mono text-[var(--text-muted)]">{i + 1}</td>
                  <td className="px-4 py-2 text-sm font-medium text-[var(--text-primary)]">{s.name}</td>
                  <td className="px-3 py-2 text-sm text-center font-mono text-[var(--color-success)]">{s.wins}</td>
                  <td className="px-3 py-2 text-sm text-center font-mono text-[var(--color-danger)]">{s.losses}</td>
                  <td className="px-3 py-2 text-sm text-center font-mono text-[var(--text-muted)]">{s.pf}</td>
                  <td className="px-3 py-2 text-sm text-center font-mono text-[var(--text-muted)]">{s.pa}</td>
                  <td className={`px-3 py-2 text-sm text-center font-mono ${s.pf - s.pa > 0 ? 'text-[var(--color-success)]' : s.pf - s.pa < 0 ? 'text-[var(--color-danger)]' : 'text-[var(--text-muted)]'}`}>
                    {s.pf - s.pa > 0 ? '+' : ''}{s.pf - s.pa}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Matches by Round */}
        {roundNumbers.map((roundNum) => (
          <div key={roundNum} className="space-y-2">
            <h3 className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider">
              {rounds[roundNum]?.[0]?.round_name ?? `Round ${roundNum}`}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {(rounds[roundNum] ?? []).map((m: any) => {
                const aId = isDoubles ? m.pair_a_id : m.participant_a_id;
                const bId = isDoubles ? m.pair_b_id : m.participant_b_id;
                const winnerId = isDoubles ? m.winner_pair_id : m.winner_participant_id;
                const isCompleted = m.status === 'completed' || m.status === 'walkover';
                const canScore = isLive && aId && bId && !isCompleted;

                return (
                  <div key={m.id} className="flex items-center justify-between p-3 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <span className="text-[10px] font-mono text-[var(--text-muted)]">M{m.match_number}</span>
                      <span className={`text-sm truncate ${isCompleted && winnerId === aId ? 'text-[var(--color-success)] font-semibold' : 'text-[var(--text-primary)]'}`}>
                        {nameMap[aId] ?? 'TBD'}{isCompleted && winnerId === aId && <span className="sr-only"> (Winner)</span>}
                      </span>
                      <span className="text-xs text-[var(--text-muted)]">vs</span>
                      <span className={`text-sm truncate ${isCompleted && winnerId === bId ? 'text-[var(--color-success)] font-semibold' : 'text-[var(--text-primary)]'}`}>
                        {nameMap[bId] ?? 'TBD'}{isCompleted && winnerId === bId && <span className="sr-only"> (Winner)</span>}
                      </span>
                    </div>
                    {isCompleted && m.scores && (
                      <span className="text-xs font-mono text-[var(--text-muted)] ml-2">
                        {(m.scores as any[]).map((g: any) => `${g.a}-${g.b}`).join(', ')}
                      </span>
                    )}
                    {canScore && (
                      <button
                        onClick={() => setScoreMatch(m)}
                        aria-label={`Enter score for match ${m.match_number ?? ''}`}
                        className="text-xs text-[var(--ds-accent)] font-medium ml-2 hover:underline focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)] focus-visible:outline-none rounded"
                      >
                        Score
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {scoreMatch && (
        <ScoreEntryDialog
          match={scoreMatch}
          event={event}
          nameMap={nameMap}
          seedMap={seedMap}
          isDoubles={isDoubles}
          onClose={() => setScoreMatch(null)}
        />
      )}
    </>
  );
}
