'use client';

import { useState, useEffect, useMemo } from 'react';
import useSWR from 'swr';
import { Avatar, PageHero } from '@badminton/ui';
import Link from 'next/link';
import { getPostHogClient } from '@/lib/posthog';
import { getSeasonTier } from '@badminton/shared';
import { Trophy, Search } from 'lucide-react';
import type { LeaderboardEntry, TournamentPointsEntry } from './page';

const tabs = [
  { id: 'open_singles', label: 'Open Singles' },
  { id: 'open_doubles', label: 'Open Doubles' },
  { id: 'comp_singles', label: 'Comp Singles' },
  { id: 'comp_doubles', label: 'Comp Doubles' },
  { id: 'tournament_points', label: 'Tournament Pts' },
] as const;

interface LeaderboardClientProps {
  players: LeaderboardEntry[];
  tournamentPoints: TournamentPointsEntry[];
  currentPlayerId: string | null;
}

const leaderboardFetcher = (url: string) => fetch(url).then((r) => r.json());

export function LeaderboardClient({
  players: initialPlayers,
  tournamentPoints: initialTournamentPoints,
  currentPlayerId,
}: LeaderboardClientProps) {
  const { data } = useSWR<{ players: LeaderboardEntry[]; tournamentPoints: TournamentPointsEntry[] }>(
    '/api/leaderboard',
    leaderboardFetcher,
    { fallbackData: { players: initialPlayers, tournamentPoints: initialTournamentPoints } }
  );
  const players = data?.players ?? initialPlayers;
  const tournamentPoints = data?.tournamentPoints ?? initialTournamentPoints;

  const [activeTab, setActiveTab] = useState<typeof tabs[number]['id']>('open_singles');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    const ph = getPostHogClient();
    if (ph) ph.capture('leaderboard_viewed');
  }, []);

  const isDoubles = activeTab.includes('doubles');
  const isTournamentPoints = activeTab === 'tournament_points';

  // Sort + filter the appropriate dataset for the active tab. Server passes
  // unsorted player rows so we don't duplicate one dataset five ways across
  // the wire — sorting per-tab is cheap and avoids that bloat.
  const rows = useMemo(() => {
    if (isTournamentPoints) {
      return tournamentPoints.map((p) => ({
        id: p.id,
        full_name: p.full_name,
        avatar_url: p.avatar_url,
        status: p.status,
        ratings: null,
        _tournamentPoints: p.total,
      }));
    }

    const filtered = activeTab.startsWith('comp_')
      ? players.filter((p) => p.status === 'competitive')
      : players;

    return [...filtered].sort((a, b) => {
      return isDoubles
        ? (b.ratings?.doubles_elo ?? 0) - (a.ratings?.doubles_elo ?? 0)
        : (b.ratings?.singles_elo ?? 0) - (a.ratings?.singles_elo ?? 0);
    });
  }, [activeTab, isDoubles, isTournamentPoints, players, tournamentPoints]);

  const filteredPlayers = searchQuery
    ? rows.filter((p) => p.full_name.toLowerCase().includes(searchQuery.toLowerCase()))
    : rows;

  return (
    <div>
      <PageHero
        eyebrow={`${players.length} ranked players`}
        title="Leaderboard."
        subtitle="Live ladder for Season 02. ELO updates as matches confirm."
        watermark="L"
      />
      <div className="space-y-6 px-2 md:px-6 py-8">

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto scroll-fade-x border-b-[0.5px] border-[var(--border)]">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-3 py-2.5 text-[13px] font-medium whitespace-nowrap transition-colors duration-150 border-b-2 ${
                isActive
                  ? 'bg-[var(--bg-accent)] text-[var(--accent)] border-[var(--accent)]'
                  : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)] pointer-events-none" />
        <input
          type="text"
          placeholder="Search players..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label="Search leaderboard"
          className="w-full min-h-[40px] bg-[var(--bg-inset)] border-[0.5px] border-[var(--border)] pl-9 pr-3 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] transition-colors"
        />
      </div>

      {/* Table */}
      <div className="bg-[var(--bg-card)] border-[0.5px] border-[var(--border)] overflow-hidden">
        <div key={activeTab}>
            {/* Header (sticky) */}
            <div className={`sticky top-14 z-10 bg-[var(--bg-card)] grid ${isTournamentPoints ? 'grid-cols-[2.5rem_1fr_5rem]' : 'grid-cols-[2.5rem_1fr_5rem_3.5rem] md:grid-cols-[2.5rem_1fr_5rem_5rem_3.5rem]'} px-5 py-2.5 border-b-[0.5px] border-[var(--border)] text-[10px] tracking-[0.04em] uppercase text-[var(--text-muted)]`}>
              <span>#</span>
              <span>Player</span>
              {isTournamentPoints ? (
                <span className="text-right">Points</span>
              ) : (
                <>
                  <span className="text-right">Elo</span>
                  <span className="text-right hidden md:block">W/L</span>
                  <span className="text-right">Win%</span>
                </>
              )}
            </div>

            {/* Rows */}
            <div className="divide-y divide-[var(--border)]">
              {filteredPlayers.map((p, i) => {
                const elo = isDoubles ? p.ratings?.doubles_elo : p.ratings?.singles_elo;
                const wins = isDoubles ? p.ratings?.doubles_wins : p.ratings?.singles_wins;
                const losses = isDoubles ? p.ratings?.doubles_losses : p.ratings?.singles_losses;
                const prov = isDoubles ? p.ratings?.doubles_provisional : p.ratings?.singles_provisional;
                const total = (wins ?? 0) + (losses ?? 0);
                const winPct = total > 0 ? Math.round(((wins ?? 0) / total) * 100) : 0;
                const isTop3 = i < 3;
                const isYou = p.id === currentPlayerId;

                return (
                  <div
                    key={p.id}
                    className="reveal"
                    style={{
                      ['--i' as string]: i,
                      animationDelay: 'min(calc(var(--i) * 30ms), 500ms)',
                    } as React.CSSProperties}
                  >
                    <Link
                      href={`/leaderboard/${p.id}`}
                      aria-current={isYou ? 'true' : undefined}
                      className={`grid ${isTournamentPoints ? 'grid-cols-[2.5rem_1fr_5rem]' : 'grid-cols-[2.5rem_1fr_5rem_3.5rem] md:grid-cols-[2.5rem_1fr_5rem_5rem_3.5rem]'} px-5 py-2.5 items-center transition-colors group border-l-2 ${
                        isYou
                          ? 'bg-[var(--bg-accent)]'
                          : 'border-transparent hover:bg-[var(--bg-card-hover)]'
                      }`}
                      style={isYou ? { borderLeftColor: 'var(--accent)' } : undefined}
                    >
                      <span className="flex items-center gap-1">
                        {isTop3 && (
                          <Trophy
                            className="w-3.5 h-3.5 shrink-0"
                            aria-hidden="true"
                            style={{
                              color:
                                i === 0
                                  ? 'var(--color-gold)'
                                  : i === 1
                                    ? 'var(--color-silver)'
                                    : 'var(--color-bronze)',
                            }}
                          />
                        )}
                        <span className={`nums text-[13px] font-medium ${isTop3 ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}>
                          {i + 1}
                        </span>
                      </span>
                      <span className="flex items-center gap-2.5 min-w-0">
                        <Avatar name={p.full_name} src={p.avatar_url} size="sm" />
                        <span
                          className={`truncate text-[16px] font-medium transition-colors ${
                            isYou ? 'text-[var(--accent)]' : 'text-[var(--text-primary)] group-hover:text-[var(--accent)]'
                          }`}
                        >
                          {p.full_name}
                        </span>
                        {prov && !isTournamentPoints && (
                          <span className="shrink-0 text-[10px] text-[var(--text-faint)] font-medium" title="Provisional">P</span>
                        )}
                      </span>
                      {isTournamentPoints ? (
                        <span className={`text-right nums text-[13px] font-medium ${isYou ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}>
                          {(p as any)._tournamentPoints ?? 0}
                        </span>
                      ) : (
                        <>
                          <span className={`text-right nums text-[13px] font-medium ${isYou ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}>
                            {elo ?? '-'}
                            {(() => {
                              if (!elo) return null;
                              const t = getSeasonTier(elo);
                              return (
                                <span
                                  className="inline-block w-2 h-2 rounded-full ml-1"
                                  style={{ backgroundColor: t.color }}
                                  title={t.tier}
                                />
                              );
                            })()}
                          </span>
                          <span className="text-right nums text-[12px] hidden md:block text-[var(--text-secondary)]">
                            <span>{wins ?? 0}</span>
                            <span className="text-[var(--text-faint)]">-</span>
                            <span>{losses ?? 0}</span>
                          </span>
                          <span className="text-right nums text-[12px] text-[var(--text-secondary)]">{winPct}%</span>
                        </>
                      )}
                    </Link>
                  </div>
                );
              })}
            </div>

            {filteredPlayers.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16">
                {searchQuery ? (
                  <>
                    <Search className="w-10 h-10 text-[var(--text-faint)] mb-3" />
                    <p className="text-[var(--text-muted)]">No players found matching &ldquo;{searchQuery}&rdquo;</p>
                  </>
                ) : (
                  <>
                    <Trophy className="w-10 h-10 text-[var(--text-faint)] mb-3" />
                    <p className="text-[var(--text-muted)]">No players ranked yet</p>
                  </>
                )}
              </div>
            )}
        </div>
      </div>
    </div>
    </div>
  );
}
