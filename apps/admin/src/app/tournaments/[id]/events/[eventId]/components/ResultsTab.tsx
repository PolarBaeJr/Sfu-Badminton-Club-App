'use client';

import { Badge, Avatar } from '@badminton/ui';
import { PLACEMENT_BONUSES, isDoublesEvent } from '@badminton/shared';
import type { TournamentEventType } from '@badminton/shared';
import { Crown, TrendingUp, TrendingDown, Medal } from 'lucide-react';

interface Props {
  event: Record<string, unknown>;
  participants: unknown[];
  pairs: unknown[];
  matches: unknown[];
  isDoubles: boolean;
}

const POSITION_LABELS: Record<number, string> = {
  1: 'Champion', 2: 'Finalist', 3: 'Semi-finalist', 4: 'Semi-finalist',
  5: 'Quarter-finalist', 6: 'Quarter-finalist', 7: 'Quarter-finalist', 8: 'Quarter-finalist',
};

const POSITION_COLORS: Record<number, string> = {
  1: '#FFD700', 2: '#C0C0C0', 3: '#CD7F32', 4: '#CD7F32',
};

export function ResultsTab({ event, participants, pairs, matches, isDoubles }: Props) {
  const entries = (isDoubles ? pairs : participants) as any[];
  const eventType = event.event_type as TournamentEventType;
  const bonuses = isDoubles ? PLACEMENT_BONUSES.doubles : PLACEMENT_BONUSES.singles;

  // Sort by final position
  const ranked = entries
    .filter((e: any) => e.final_position)
    .sort((a: any, b: any) => a.final_position - b.final_position);

  const unranked = entries.filter((e: any) => !e.final_position);

  const totalMatches = (matches as any[]).length;
  const completedMatches = (matches as any[]).filter((m: any) => m.status === 'completed' || m.status === 'walkover').length;

  return (
    <div className="space-y-6">
      {/* Champion card */}
      {ranked.length > 0 && ranked[0].final_position === 1 && (
        <div className="rounded-xl border-2 border-[#FFD700]/30 bg-gradient-to-r from-[#FFD700]/5 to-transparent p-6 text-center">
          <Crown className="w-8 h-8 mx-auto mb-2 text-[#FFD700]" />
          <h2 className="text-2xl font-bold text-[#FFD700] font-display">CHAMPION</h2>
          <p className="text-lg text-[var(--text-primary)] font-semibold mt-1">
            {getName(ranked[0], isDoubles)}
          </p>
          {!isDoubles && ranked[0].elo_change !== null && (
            <p className="text-sm text-[var(--color-success)] mt-1">
              Elo: {ranked[0].elo_before} → {ranked[0].elo_after} ({ranked[0].elo_change > 0 ? '+' : ''}{ranked[0].elo_change})
            </p>
          )}
        </div>
      )}

      {/* Results table */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <Medal className="w-4 h-4" /> Final Standings
          </h3>
          <span className="text-xs text-[var(--text-muted)]">{completedMatches}/{totalMatches} matches played</span>
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase px-4 py-2 w-14">Pos</th>
              <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase px-4 py-2">Player</th>
              {!isDoubles && (
                <>
                  <th className="text-center text-xs font-medium text-[var(--text-muted)] uppercase px-3 py-2 w-20">Elo Before</th>
                  <th className="text-center text-xs font-medium text-[var(--text-muted)] uppercase px-3 py-2 w-20">Elo After</th>
                  <th className="text-center text-xs font-medium text-[var(--text-muted)] uppercase px-3 py-2 w-16">Change</th>
                </>
              )}
              <th className="text-center text-xs font-medium text-[var(--text-muted)] uppercase px-3 py-2 w-16">Bonus</th>
              <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase px-3 py-2 w-28">Finish</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((e: any) => {
              const pos = e.final_position;
              const label = POSITION_LABELS[pos] ?? `#${pos}`;
              const color = POSITION_COLORS[pos] ?? 'var(--text-muted)';
              const bonus = pos === 1 ? bonuses.champion
                : pos === 2 ? bonuses.finalist
                : pos <= 4 ? bonuses.semifinalist
                : pos <= 8 ? bonuses.quarterfinalist : 0;

              return (
                <tr key={e.id} className="border-b border-[var(--border)] last:border-b-0">
                  <td className="px-4 py-2.5">
                    <span className="font-mono font-bold text-sm" style={{ color }}>{pos}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      {!isDoubles && <Avatar name={e.player?.full_name ?? ''} src={e.player?.avatar_url} size="sm" />}
                      <span className="text-sm font-medium text-[var(--text-primary)]">{getName(e, isDoubles)}</span>
                    </div>
                  </td>
                  {!isDoubles && (
                    <>
                      <td className="px-3 py-2.5 text-sm text-center font-mono text-[var(--text-muted)]">{e.elo_before ?? '-'}</td>
                      <td className="px-3 py-2.5 text-sm text-center font-mono text-[var(--text-primary)]">{e.elo_after ?? '-'}</td>
                      <td className="px-3 py-2.5 text-sm text-center font-mono">
                        {e.elo_change !== null && e.elo_change !== undefined ? (
                          <span className={e.elo_change > 0 ? 'text-[var(--color-success)]' : e.elo_change < 0 ? 'text-[var(--color-danger)]' : 'text-[var(--text-muted)]'}>
                            {e.elo_change > 0 ? '+' : ''}{e.elo_change}
                          </span>
                        ) : '-'}
                      </td>
                    </>
                  )}
                  <td className="px-3 py-2.5 text-sm text-center font-mono text-[var(--color-success)]">
                    {bonus > 0 ? `+${bonus}` : '-'}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ color, backgroundColor: `${color}15` }}>
                      {label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function getName(entry: any, isDoubles: boolean): string {
  if (isDoubles) {
    return entry.pair_name ?? `${entry.player1?.full_name ?? '?'} / ${entry.player2?.full_name ?? '?'}`;
  }
  return entry.player?.full_name ?? 'Unknown';
}
