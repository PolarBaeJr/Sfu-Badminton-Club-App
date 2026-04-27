'use client';

import { useState, useEffect, useMemo } from 'react';
import { Avatar } from '@badminton/ui';
import Link from 'next/link';
import { getPostHogClient } from '@/lib/posthog';
import { getSeasonTier } from '@badminton/shared';
import { Trophy, Medal, Crown, Search } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { LeaderboardEntry, TournamentPointsEntry } from './page';

const tabs = [
  { id: 'open_singles', label: 'Open Singles' },
  { id: 'open_doubles', label: 'Open Doubles' },
  { id: 'comp_singles', label: 'Comp Singles' },
  { id: 'comp_doubles', label: 'Comp Doubles' },
  { id: 'tournament_points', label: 'Tournament Pts' },
] as const;

const rankIcons = [Crown, Medal, Trophy];
const rankColors = ['text-[var(--color-gold)]', 'text-[var(--text-secondary)]', 'text-[var(--color-gold-deep)]'];
const rankBg = ['bg-[var(--color-gold)]/10 border-[var(--color-gold)]/20', 'bg-[var(--text-secondary)]/10 border-[var(--text-secondary)]/20', 'bg-[var(--color-gold-deep)]/10 border-[var(--color-gold-deep)]/20'];

interface LeaderboardClientProps {
  players: LeaderboardEntry[];
  tournamentPoints: TournamentPointsEntry[];
  currentPlayerId: string | null;
}

export function LeaderboardClient({ players, tournamentPoints, currentPlayerId }: LeaderboardClientProps) {
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
    <div className="space-y-6">
      <div className="flex items-center gap-3 reveal reveal-1">
        <div className="w-10 h-10 rounded-xl bg-[var(--color-gold)]/10 flex items-center justify-center glow-gold">
          <Trophy className="w-5 h-5 text-gold" />
        </div>
        <div>
          <p className="eyebrow">Rankings</p>
          <h1 className="display-lg text-shuttle-white">Leaderboard</h1>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-white/[0.03] rounded-xl p-1 border border-white/[0.04] overflow-x-auto scroll-fade-x">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`relative flex-1 py-2.5 px-3 text-sm font-semibold rounded-lg transition-all duration-300 whitespace-nowrap ${
              activeTab === tab.id
                ? 'text-white'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}
          >
            {activeTab === tab.id && (
              <motion.div
                layoutId="leaderboardTab"
                className="absolute inset-0 bg-gradient-to-r from-[var(--color-gold)]/20 to-[var(--color-gold-deep)]/20 border border-[var(--color-gold)]/20 rounded-lg"
                transition={{ type: 'spring', bounce: 0.2, duration: 0.5 }}
              />
            )}
            <span className="relative z-10">{tab.label}</span>
          </button>
        ))}
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
          className="w-full min-h-[40px] bg-[var(--bg-surface)] border border-[var(--border)] rounded-md pl-9 pr-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)] focus-visible:border-transparent transition-colors"
        />
      </div>

      {/* Table */}
      <div className="card-elevated overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {/* Header (sticky) */}
            <div className={`sticky top-0 z-10 bg-[var(--bg-card)]/95 backdrop-blur grid ${isTournamentPoints ? 'grid-cols-[3rem_1fr_5rem]' : 'grid-cols-[3rem_1fr_5rem_4rem_3.5rem] md:grid-cols-[3rem_1fr_5rem_5rem_4rem]'} px-4 py-3 border-b border-[var(--border)] eyebrow`}>
              <span>#</span>
              <span>Player</span>
              {isTournamentPoints ? (
                <span className="text-right">Points</span>
              ) : (
                <>
                  <span className="text-right">Elo</span>
                  <span className="text-right">W/L</span>
                  <span className="text-right">Win%</span>
                </>
              )}
            </div>

            {/* Rows */}
            <div className="divide-y divide-white/[0.04]">
              {filteredPlayers.map((p, i) => {
                const elo = isDoubles ? p.ratings?.doubles_elo : p.ratings?.singles_elo;
                const wins = isDoubles ? p.ratings?.doubles_wins : p.ratings?.singles_wins;
                const losses = isDoubles ? p.ratings?.doubles_losses : p.ratings?.singles_losses;
                const prov = isDoubles ? p.ratings?.doubles_provisional : p.ratings?.singles_provisional;
                const total = (wins ?? 0) + (losses ?? 0);
                const winPct = total > 0 ? Math.round(((wins ?? 0) / total) * 100) : 0;
                const RankIcon = i < 3 ? rankIcons[i] : null;

                return (
                  <motion.div
                    key={p.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: Math.min(i * 0.03, 0.5), duration: 0.3 }}
                  >
                    <Link
                      href={`/leaderboard/${p.id}`}
                      aria-current={p.id === currentPlayerId ? 'true' : undefined}
                      className={`grid ${isTournamentPoints ? 'grid-cols-[3rem_1fr_5rem]' : 'grid-cols-[3rem_1fr_5rem_4rem_3.5rem] md:grid-cols-[3rem_1fr_5rem_5rem_4rem]'} px-4 py-3 items-center transition-colors group border-l-2 ${
                        p.id === currentPlayerId
                          ? 'bg-[var(--ds-accent-dim)] border-[var(--ds-accent)] hover:brightness-110'
                          : i < 3
                            ? rankBg[i]
                            : 'border-transparent hover:bg-white/[0.03]'
                      }`}
                    >
                      <span className="flex items-center">
                        {RankIcon ? (
                          <RankIcon className={`w-5 h-5 ${rankColors[i]}`} />
                        ) : (
                          <span className="ds-mono text-sm text-[var(--text-dim)] font-semibold">{i + 1}</span>
                        )}
                      </span>
                      <span className="flex items-center gap-2.5 min-w-0">
                        <Avatar name={p.full_name} src={p.avatar_url} size="sm" />
                        <span
                          className={`truncate font-medium transition-colors group-hover:text-[var(--ds-accent)] ${
                            i < 3 ? 'ds-display text-base text-shuttle-white' : 'text-sm text-shuttle-white'
                          } ${p.id === currentPlayerId ? 'text-[var(--ds-accent)]' : ''}`}
                        >
                          {p.full_name}
                        </span>
                        {prov && !isTournamentPoints && (
                          <span className="chip shrink-0" style={{ fontSize: '0.6rem', padding: '0.125rem 0.4rem' }}>P</span>
                        )}
                      </span>
                      {isTournamentPoints ? (
                        <span className="text-right ds-mono text-base font-bold gradient-text-gold">{(p as any)._tournamentPoints ?? 0}</span>
                      ) : (
                        <>
                          <span className="text-right ds-mono text-base font-bold text-shuttle-white">
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
                          <span className="text-right ds-mono text-sm text-[var(--text-secondary)]">
                            <span className="text-[var(--color-success)]">{wins ?? 0}</span>
                            <span className="text-[var(--text-dim)]">-</span>
                            <span className="text-[var(--color-danger)]">{losses ?? 0}</span>
                          </span>
                          <span className="text-right ds-mono text-sm text-[var(--text-secondary)] font-medium">{winPct}%</span>
                        </>
                      )}
                    </Link>
                  </motion.div>
                );
              })}
            </div>

            {filteredPlayers.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16">
                {searchQuery ? (
                  <>
                    <Search className="w-10 h-10 text-[var(--text-dim)] mb-3" />
                    <p className="text-[var(--text-muted)]">No players found matching &ldquo;{searchQuery}&rdquo;</p>
                  </>
                ) : (
                  <>
                    <Trophy className="w-10 h-10 text-[var(--text-dim)] mb-3" />
                    <p className="text-[var(--text-muted)]">No players ranked yet</p>
                  </>
                )}
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
