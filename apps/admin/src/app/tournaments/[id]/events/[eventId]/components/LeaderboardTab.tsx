'use client';

import { useState } from 'react';
import { Button, Avatar } from '@badminton/ui';
import { Download, ArrowUpDown } from 'lucide-react';
import type { TournamentTabProps, TournamentEntry } from '@/app/tournaments/types';

type SortField = 'rank' | 'name' | 'seed' | 'position' | 'points' | 'elo_change';
type SortDir = 'asc' | 'desc';

export function LeaderboardTab({ event, participants, pairs, isDoubles }: TournamentTabProps) {
  const [sortField, setSortField] = useState<SortField>('position');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const entries: TournamentEntry[] = isDoubles ? pairs : participants;

  const ranked = entries
    .filter((e) => e.final_position != null)
    .map((e) => ({
      id: e.id,
      rank: e.final_position as number,
      name: getName(e, isDoubles),
      seed: e.seed_number as number | null,
      position: e.final_position as number,
      points: (e.points as number | undefined) ?? 0,
      elo_change: isDoubles ? null : (e.elo_change as number | null | undefined) ?? null,
      elo_before: isDoubles ? null : (e.elo_before as number | null | undefined) ?? null,
      elo_after: isDoubles ? null : (e.elo_after as number | null | undefined) ?? null,
    }));

  // Sort
  ranked.sort((a, b) => {
    let cmp = 0;
    switch (sortField) {
      case 'rank':
      case 'position':
        cmp = a.position - b.position;
        break;
      case 'name':
        cmp = a.name.localeCompare(b.name);
        break;
      case 'seed':
        cmp = (a.seed ?? 999) - (b.seed ?? 999);
        break;
      case 'points':
        cmp = (b.points ?? 0) - (a.points ?? 0);
        break;
      case 'elo_change':
        cmp = (b.elo_change ?? 0) - (a.elo_change ?? 0);
        break;
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir(field === 'points' || field === 'elo_change' ? 'desc' : 'asc');
    }
  }

  function exportCSV() {
    const headers = ['Rank', 'Name', 'Seed', 'Position', 'Points', ...(isDoubles ? [] : ['Elo Before', 'Elo After', 'Elo Change'])];
    const rows = ranked.map(r => [
      r.rank, r.name, r.seed ?? '', r.position, r.points,
      ...(isDoubles ? [] : [r.elo_before ?? '', r.elo_after ?? '', r.elo_change ?? '']),
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const eventName = (event.event_type as string || 'event').replace(/[^a-z0-9]/gi, '-');
    a.download = `leaderboard-${eventName}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const SortHeader = ({ field, label, className }: { field: SortField; label: string; className?: string }) => (
    <th
      className={`text-xs font-medium text-[var(--text-muted)] uppercase px-3 py-2 cursor-pointer select-none hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)] focus-visible:outline-none ${className ?? ''}`}
      onClick={() => toggleSort(field)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSort(field); } }}
      tabIndex={0}
      role="button"
      aria-label={`Sort by ${label}${sortField === field ? (sortDir === 'asc' ? ', ascending' : ', descending') : ''}`}
    >
      <span className="flex items-center gap-1">
        {label}
        {sortField === field && <ArrowUpDown className="w-3 h-3" />}
      </span>
    </th>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
          Leaderboard ({ranked.length} entries)
        </h3>
        <Button size="sm" variant="ghost" onClick={exportCSV} aria-label="Export leaderboard as CSV" className="focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)] focus-visible:outline-none">
          <Download className="w-3.5 h-3.5 mr-1" /> Export CSV
        </Button>
      </div>

      <div className=" border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <SortHeader field="rank" label="#" className="w-12 text-center" />
              <SortHeader field="name" label="Player" className="text-left" />
              <SortHeader field="seed" label="Seed" className="w-16 text-center" />
              <SortHeader field="position" label="Finish" className="w-16 text-center" />
              <SortHeader field="points" label="Points" className="w-20 text-center" />
              {!isDoubles && <SortHeader field="elo_change" label="Elo +/-" className="w-20 text-center" />}
            </tr>
          </thead>
          <tbody>
            {ranked.map((r) => (
              <tr key={r.id} className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--bg-elevated)]">
                <td className="px-3 py-2.5 text-center text-sm font-mono font-bold text-[var(--text-muted)]">{r.rank}</td>
                <td className="px-3 py-2.5 text-sm font-medium text-[var(--text-primary)]">{r.name}</td>
                <td className="px-3 py-2.5 text-center text-sm font-mono text-[var(--text-muted)]">{r.seed ?? '-'}</td>
                <td className="px-3 py-2.5 text-center text-sm font-mono text-[var(--text-primary)]">{r.position}</td>
                <td className="px-3 py-2.5 text-center text-sm font-mono font-bold text-[var(--ds-accent)]">{r.points}</td>
                {!isDoubles && (
                  <td className="px-3 py-2.5 text-center text-sm font-mono">
                    {r.elo_change != null ? (
                      <span className={r.elo_change > 0 ? 'text-[var(--color-success)]' : r.elo_change < 0 ? 'text-[var(--color-danger)]' : 'text-[var(--text-muted)]'}>
                        <span className="sr-only">{r.elo_change > 0 ? 'Gained' : r.elo_change < 0 ? 'Lost' : 'No change'}: </span>{r.elo_change > 0 ? '+' : ''}{r.elo_change}
                      </span>
                    ) : '-'}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {ranked.length === 0 && (
          <div className="p-8 text-center text-sm text-[var(--text-muted)]">No results yet.</div>
        )}
      </div>
    </div>
  );
}

function getName(entry: TournamentEntry, isDoubles: boolean): string {
  if (isDoubles) {
    const pair = entry as import('@/app/tournaments/types').TournamentPair;
    return pair.pair_name ?? `${pair.player1?.full_name ?? '?'} / ${pair.player2?.full_name ?? '?'}`;
  }
  const part = entry as import('@/app/tournaments/types').TournamentParticipant;
  return part.player?.full_name ?? 'Unknown';
}
