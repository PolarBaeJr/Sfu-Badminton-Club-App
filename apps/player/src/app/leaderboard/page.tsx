'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { Avatar, Badge } from '@badminton/ui';
import Link from 'next/link';
import { getPostHogClient } from '@/lib/posthog';
import { getSeasonTier } from '@badminton/shared';
import { Trophy, Medal, Crown, ChevronRight, Loader2, Search } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

type LeaderboardEntry = {
  id: string;
  full_name: string;
  avatar_url: string | null;
  status: string;
  ratings: {
    singles_elo: number;
    doubles_elo: number;
    singles_wins: number;
    singles_losses: number;
    doubles_wins: number;
    doubles_losses: number;
    singles_provisional: boolean;
    doubles_provisional: boolean;
  } | null;
};

const tabs = [
  { id: 'open_singles', label: 'Open Singles' },
  { id: 'open_doubles', label: 'Open Doubles' },
  { id: 'comp_singles', label: 'Comp Singles' },
  { id: 'comp_doubles', label: 'Comp Doubles' },
  { id: 'tournament_points', label: 'Tournament Pts' },
];

const rankIcons = [Crown, Medal, Trophy];
const rankColors = ['text-[var(--color-gold)]', 'text-[var(--text-secondary)]', 'text-[var(--color-gold-deep)]'];
const rankBg = ['bg-[var(--color-gold)]/10 border-[var(--color-gold)]/20', 'bg-[var(--text-secondary)]/10 border-[var(--text-secondary)]/20', 'bg-[var(--color-gold-deep)]/10 border-[var(--color-gold-deep)]/20'];

export default function LeaderboardPage() {
  const [activeTab, setActiveTab] = useState('open_singles');
  const [players, setPlayers] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    const ph = getPostHogClient();
    if (ph) ph.capture('leaderboard_viewed');
  }, []);

  useEffect(() => {
    const supabase = createClient();

    async function load() {
      setLoading(true);

      if (activeTab === 'tournament_points') {
        // Aggregate tournament points per player
        const { data: parts } = await supabase
          .from('tournament_participants')
          .select('player_id, points, player:players(id, full_name, avatar_url, status)')
          .not('status', 'in', '("withdrawn","disqualified")')
          .gt('points', 0);

        const pointsMap: Record<string, { player: any; total: number }> = {};
        for (const p of parts ?? []) {
          const player = p.player as any;
          if (!player) continue;
          if (!pointsMap[p.player_id]) {
            pointsMap[p.player_id] = { player, total: 0 };
          }
          pointsMap[p.player_id]!.total += p.points ?? 0;
        }

        const sorted = Object.values(pointsMap)
          .sort((a, b) => b.total - a.total)
          .map((entry) => ({
            id: entry.player.id,
            full_name: entry.player.full_name,
            avatar_url: entry.player.avatar_url,
            status: entry.player.status,
            ratings: null,
            _tournamentPoints: entry.total,
          }));

        setPlayers(sorted as any[]);
        setLoading(false);
        return;
      }

      let query = supabase
        .from('players')
        .select('id, full_name, avatar_url, status, ratings(*)')
        .eq('active_flag', true)
        .not('status', 'in', '("pending_approval","suspended")');

      if (activeTab.startsWith('comp_')) {
        query = query.eq('status', 'competitive');
      }

      const { data } = await query;

      const sorted = (data || [])
        .filter((p) => {
          const r = Array.isArray(p.ratings) ? p.ratings[0] : p.ratings;
          return r !== null;
        })
        .sort((a, b) => {
          const ra = Array.isArray(a.ratings) ? a.ratings[0] : a.ratings;
          const rb = Array.isArray(b.ratings) ? b.ratings[0] : b.ratings;
          const isDoubles = activeTab.includes('doubles');
          return isDoubles
            ? (rb?.doubles_elo ?? 0) - (ra?.doubles_elo ?? 0)
            : (rb?.singles_elo ?? 0) - (ra?.singles_elo ?? 0);
        })
        .map((p) => ({
          ...p,
          ratings: Array.isArray(p.ratings) ? p.ratings[0] : p.ratings,
        }));

      setPlayers(sorted as LeaderboardEntry[]);
      setLoading(false);
    }
    load();

    const channel = supabase
      .channel('ratings-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ratings' }, () => {
        load();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [activeTab]);

  const isDoubles = activeTab.includes('doubles');

  const filteredPlayers = searchQuery
    ? players.filter((p) =>
        p.full_name.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : players;

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
          className="w-full bg-[var(--bg-surface)] border border-white/[0.06] rounded-lg pl-9 pr-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-gold)]/40 focus:border-transparent transition-colors"
        />
      </div>

      {/* Table */}
      <div className="card-elevated overflow-hidden">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <Loader2 className="w-7 h-7 text-gold animate-spin" />
            <div className="skeleton h-4 w-32" />
          </div>
        ) : (
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              {/* Header */}
              <div className={`grid ${activeTab === 'tournament_points' ? 'grid-cols-[3rem_1fr_5rem]' : 'grid-cols-[3rem_1fr_5rem_4rem_3.5rem] md:grid-cols-[3rem_1fr_5rem_5rem_4rem]'} px-4 py-3 border-b border-white/[0.06] eyebrow`}>
                <span>#</span>
                <span>Player</span>
                {activeTab === 'tournament_points' ? (
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
                        className={`grid ${activeTab === 'tournament_points' ? 'grid-cols-[3rem_1fr_5rem]' : 'grid-cols-[3rem_1fr_5rem_4rem_3.5rem] md:grid-cols-[3rem_1fr_5rem_5rem_4rem]'} px-4 py-3 items-center hover:bg-white/[0.03] transition-colors group ${
                          i < 3 ? rankBg[i] + ' border-l-2' : ''
                        }`}
                      >
                        <span className="flex items-center">
                          {RankIcon ? (
                            <RankIcon className={`w-5 h-5 ${rankColors[i]}`} />
                          ) : (
                            <span className="text-sm font-mono text-[var(--text-dim)] font-bold nums">{i + 1}</span>
                          )}
                        </span>
                        <span className="flex items-center gap-2.5 min-w-0">
                          <Avatar name={p.full_name} src={p.avatar_url} size="sm" />
                          <span className="truncate text-sm text-shuttle-white font-medium group-hover:text-[var(--color-accent)] transition-colors">
                            {p.full_name}
                          </span>
                          {prov && activeTab !== 'tournament_points' && (
                            <span className="chip shrink-0" style={{ fontSize: '0.6rem', padding: '0.125rem 0.4rem' }}>P</span>
                          )}
                        </span>
                        {activeTab === 'tournament_points' ? (
                          <span className="text-right font-mono text-base font-bold gradient-text-gold nums">{(p as any)._tournamentPoints ?? 0}</span>
                        ) : (
                          <>
                            <span className="text-right font-mono text-base font-bold text-shuttle-white nums">
                              {elo ?? '-'}
                              {(() => {
                                if (!elo || activeTab === 'tournament_points') return null;
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
                            <span className="text-right text-sm text-[var(--text-secondary)] nums">
                              <span className="text-emerald-400">{wins ?? 0}</span>
                              <span className="text-[var(--text-dim)]">-</span>
                              <span className="text-[var(--color-accent)]">{losses ?? 0}</span>
                            </span>
                            <span className="text-right text-sm text-[var(--text-secondary)] font-medium nums">{winPct}%</span>
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
        )}
      </div>
    </div>
  );
}
