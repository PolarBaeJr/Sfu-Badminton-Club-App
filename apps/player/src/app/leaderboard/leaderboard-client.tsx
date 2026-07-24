'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getPostHogClient } from '@/lib/posthog';
import { createClient } from '@/lib/supabase-browser';
import { Search, Crosshair, Trophy } from 'lucide-react';
import { AvatarChip, PageHeader } from '@badminton/ui';
import { getWinRate, getWinRateNumeric } from '@badminton/shared';

type Ratings = {
  singles_elo: number;
  doubles_elo: number;
  singles_wins: number;
  singles_losses: number;
  doubles_wins: number;
  doubles_losses: number;
  singles_provisional: boolean;
  doubles_provisional: boolean;
  current_singles_streak?: number;
  current_doubles_streak?: number;
};

export type LeaderboardEntry = {
  id: string;
  full_name: string;
  avatar_url?: string | null;
  status: string;
  ratings: Ratings | null;
  hide_from_leaderboard?: boolean;
  _tournamentPoints?: number;
};

// One row as returned by the get_leaderboard() RPC.
export type LeaderboardRow = Ratings & {
  id: string;
  name: string;
  avatar_url: string | null;
  status: string;
  tournament_points: number;
};

type CategoryId = 'open_singles' | 'open_doubles' | 'comp_singles' | 'comp_doubles' | 'tournament_points';

type SortId = 'elo' | 'win_rate';

const tabs: { id: CategoryId; label: string; short: string }[] = [
  { id: 'open_singles',      label: 'Open Singles',     short: 'Open S.' },
  { id: 'open_doubles',      label: 'Open Doubles',     short: 'Open D.' },
  { id: 'comp_singles',      label: 'Comp Singles',     short: 'Comp S.' },
  { id: 'comp_doubles',      label: 'Comp Doubles',     short: 'Comp D.' },
  { id: 'tournament_points', label: 'Tournament Pts',   short: 'TPts' },
];

const sortOptions: { id: SortId; label: string }[] = [
  { id: 'elo',      label: 'ELO' },
  { id: 'win_rate', label: 'Win %' },
];

// Records with fewer than this many games sort below established ones when
// ranking by win rate (a 1-0 record shouldn't outrank a 20-5 one).
const MIN_GAMES_FOR_WIN_RATE_RANK = 5;

export default function LeaderboardClient({
  initialPlayers,
  meId,
}: {
  initialPlayers: LeaderboardEntry[];
  meId: string | null;
}) {
  const [activeTab, setActiveTab] = useState<CategoryId>('open_singles');
  const [sortBy, setSortBy] = useState<SortId>('elo');
  const [searchQuery, setSearchQuery] = useState('');
  const router = useRouter();

  const players = initialPlayers;

  useEffect(() => {
    const ph = getPostHogClient();
    if (ph) ph.capture('leaderboard_viewed');
  }, []);

  // Live-refresh: when any rating changes (a match confirms), re-run the server
  // component to pull fresh standings. Debounced so a burst of updates triggers
  // one refresh. Data still comes from the server (RSC) — this only nudges it.
  useEffect(() => {
    const supabase = createClient();
    let t: ReturnType<typeof setTimeout> | undefined;
    const channel = supabase
      .channel('leaderboard-ratings')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ratings' }, () => {
        clearTimeout(t);
        t = setTimeout(() => router.refresh(), 2500);
      })
      .subscribe();
    return () => {
      clearTimeout(t);
      supabase.removeChannel(channel);
    };
  }, [router]);

  const isDoubles = activeTab.includes('doubles');
  const isTpts = activeTab === 'tournament_points';

  // Which players belong to the active tab: competitive-only tabs filter by
  // status; the tournament tab keeps players with points; open tabs keep all.
  const tabFiltered = useMemo(() => {
    if (isTpts) return players.filter((p) => (p._tournamentPoints ?? 0) > 0);
    if (activeTab.startsWith('comp_')) return players.filter((p) => p.status === 'competitive');
    return players;
  }, [players, activeTab, isTpts]);

  const filtered = useMemo(
    () => searchQuery ? tabFiltered.filter((p) => p.full_name.toLowerCase().includes(searchQuery.toLowerCase())) : tabFiltered,
    [tabFiltered, searchQuery]
  );

  const ranked = useMemo(() => {
    if (isTpts) {
      return [...filtered].sort((a, b) => (b._tournamentPoints ?? 0) - (a._tournamentPoints ?? 0));
    }
    if (sortBy === 'win_rate') {
      const record = (p: LeaderboardEntry) => {
        const r = p.ratings;
        const wins = r ? (isDoubles ? r.doubles_wins : r.singles_wins) : 0;
        const losses = r ? (isDoubles ? r.doubles_losses : r.singles_losses) : 0;
        const rate = getWinRateNumeric(wins, losses);
        // Tiers: established (≥5 games) first, small samples next, unplayed (null rate) last.
        const tier = rate === null ? 2 : wins + losses < MIN_GAMES_FOR_WIN_RATE_RANK ? 1 : 0;
        return { rate, tier };
      };
      return [...filtered].sort((a, b) => {
        const ra = record(a);
        const rb = record(b);
        if (ra.tier !== rb.tier) return ra.tier - rb.tier;
        return (rb.rate ?? 0) - (ra.rate ?? 0);
      });
    }
    // Default: sort by ELO for the active discipline.
    return [...filtered].sort((a, b) =>
      isDoubles
        ? (b.ratings?.doubles_elo ?? 0) - (a.ratings?.doubles_elo ?? 0)
        : (b.ratings?.singles_elo ?? 0) - (a.ratings?.singles_elo ?? 0)
    );
  }, [filtered, sortBy, isDoubles, isTpts]);

  const meIndex = useMemo(
    () => ranked.findIndex((p) => p.id === meId),
    [ranked, meId]
  );
  const me = meIndex >= 0 ? ranked[meIndex] : null;
  const myElo = me?.ratings ? (isDoubles ? me.ratings.doubles_elo : me.ratings.singles_elo) : null;
  const aboveMe = meIndex > 0 ? ranked[meIndex - 1] : null;
  const aboveMeElo = aboveMe?.ratings ? (isDoubles ? aboveMe.ratings.doubles_elo : aboveMe.ratings.singles_elo) : null;
  const eloToNext = myElo !== null && aboveMeElo !== null ? aboveMeElo - myElo : null;

  const top3 = ranked.slice(0, 3);

  return (
    <div data-screen-label="Leaderboard">
      <PageHeader
        title="Leaderboard"
        actions={
          <div className="search-pill">
            <Search size={14} className="text-[var(--mute)]" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search player..."
              aria-label="Search leaderboard"
              style={{ width: 180 }}
            />
          </div>
        }
      />

      <div className="chips" style={{ marginBottom: 20 }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            className={'filter-chip' + (activeTab === t.id ? ' active' : '')}
            onClick={() => setActiveTab(t.id)}
            type="button"
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="grid grid-12">
        <div style={{ gridColumn: 'span 4' }} className="feed-col reveal reveal-1">
          <div className="card-base" style={{ padding: 0, overflow: 'hidden' }}>
            <div
              className="card-head"
              style={{ padding: '20px 20px 14px', borderBottom: '1px solid var(--line)', marginBottom: 0 }}
            >
              <div>
                <h3 className="card-title">Top 3</h3>
                <div className="card-sub">The players to beat</div>
              </div>
              <span className="tag tag-gold">PODIUM</span>
            </div>
            <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {top3.length === 0 && (
                <div className="empty" style={{ padding: 16 }}>No ranked players yet.</div>
              )}
              {top3.map((p, i) => {
                const elo = p.ratings ? (isDoubles ? p.ratings.doubles_elo : p.ratings.singles_elo) : (p._tournamentPoints ?? 0);
                const wins = p.ratings ? (isDoubles ? p.ratings.doubles_wins : p.ratings.singles_wins) : 0;
                const losses = p.ratings ? (isDoubles ? p.ratings.doubles_losses : p.ratings.singles_losses) : 0;
                return (
                  <Link
                    key={p.id}
                    href={`/leaderboard/${p.id}`}
                    className="row press list-row"
                    style={{
                      alignItems: 'stretch',
                      ...(i === 0 ? { background: 'var(--red-wash)' } : {}),
                    }}
                  >
                    <div style={{ width: 40, display: 'grid', placeItems: 'center' }}>
                      <div className="rank-big">
                        <span className="hash">#</span>
                        <span
                          className="num"
                          style={{
                            fontSize: 32,
                            color: i === 0 ? 'var(--gold)' : i === 1 ? 'var(--silver)' : 'var(--bronze)',
                          }}
                        >
                          {i + 1}
                        </span>
                      </div>
                    </div>
                    <AvatarChip name={p.full_name} id={p.id} src={p.avatar_url} size="md" ring={i === 0} />
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                      <div style={{ fontWeight: 600, fontSize: 15 }}>{p.full_name}</div>
                      <div className="mono muted" style={{ fontSize: 11 }}>
                        {isTpts ? 'Tournament points' : isDoubles ? 'Doubles' : 'Singles'}
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', justifyContent: 'center' }}>
                      <div className="mono" style={{ fontWeight: 700, fontSize: 18 }}>{elo}</div>
                      {!isTpts && (
                        <div className="mono muted" style={{ fontSize: 11 }}>
                          {wins}–{losses}{wins + losses > 0 ? ` · ${getWinRate(wins, losses)}` : ''}
                        </div>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>

          {me && !isTpts && (
            <div className="card-base">
              <div className="card-head">
                <h3 className="card-title">Your position</h3>
                <span className="tag tag-red">YOU</span>
              </div>
              <div className="row" style={{ gap: 20, alignItems: 'flex-end', marginBottom: 10 }}>
                <div className="rank-big">
                  <span className="hash">#</span>
                  <span className="num">{meIndex + 1}</span>
                </div>
                <div style={{ flex: 1, textAlign: 'right' }}>
                  <div className="mono" style={{ fontSize: 22, fontWeight: 700 }}>{myElo ?? '—'}</div>
                  <div className="mono muted" style={{ fontSize: 11 }}>
                    {isDoubles ? 'Doubles ELO' : 'Singles ELO'}
                  </div>
                </div>
              </div>
              {eloToNext !== null && eloToNext > 0 && aboveMe && (
                <>
                  <div
                    className="capacity-bar"
                    style={{ height: 8 }}
                  >
                    <div
                      className="fill"
                      style={{
                        width: `${Math.min(100, ((myElo ?? 0) / (aboveMeElo ?? 1)) * 100)}%`,
                        background: 'var(--red)',
                      }}
                    />
                  </div>
                  <div className="row" style={{ justifyContent: 'space-between', fontSize: 11, marginTop: 6 }}>
                    <span className="mono muted">TO #{meIndex} · {eloToNext} ELO</span>
                    <span className="mono">TARGET {aboveMeElo}</span>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div style={{ gridColumn: 'span 8' }} className="reveal reveal-2">
          <div className="card-base" style={{ padding: 0, overflow: 'hidden' }}>
            <div
              className="card-head row"
              style={{ padding: '20px 20px 14px', borderBottom: '1px solid var(--line)', marginBottom: 0, justifyContent: 'space-between' }}
            >
              <div>
                <h3 className="card-title">{tabs.find((t) => t.id === activeTab)?.label} · Full Ladder</h3>
                <div className="card-sub">
                  Sorted by {isTpts ? 'points' : sortBy === 'win_rate' ? 'win rate' : 'ELO'} · {ranked.length} of {players.length}
                </div>
              </div>
              {!isTpts && (
                <div className="chips">
                  {sortOptions.map((s) => (
                    <button
                      key={s.id}
                      className={'filter-chip' + (sortBy === s.id ? ' active' : '')}
                      onClick={() => setSortBy(s.id)}
                      type="button"
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {ranked.length === 0 ? (
              <div className="empty">
                <div className="empty-icon"><Trophy size={20} /></div>
                <div className="empty-title">
                  {searchQuery ? `No players match "${searchQuery}"` : 'No ranked players yet'}
                </div>
                <div className="empty-hint">
                  {searchQuery ? 'Try a different name.' : 'Play a ranked match to appear here'}
                </div>
              </div>
            ) : (
              <div className="scroll-fade-x" style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                <table className="data-table" style={{ minWidth: 680 }}>
                  <thead>
                    <tr>
                      <th style={{ width: 56 }}>Rank</th>
                      <th>Player</th>
                      <th className="num" style={{ width: 80, textAlign: 'right' }}>{isTpts ? 'Pts' : 'ELO'}</th>
                      {!isTpts && <th className="num" style={{ width: 110, textAlign: 'right' }}>W–L</th>}
                      {!isTpts && <th className="num" style={{ width: 90, textAlign: 'right' }}>Win %</th>}
                      {!isTpts && <th className="num" style={{ width: 90, textAlign: 'right' }}>Streak</th>}
                      <th style={{ width: 110 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {ranked.map((p, i) => {
                      const r = p.ratings;
                      const elo = r ? (isDoubles ? r.doubles_elo : r.singles_elo) : (p._tournamentPoints ?? 0);
                      const wins = r ? (isDoubles ? r.doubles_wins : r.singles_wins) : 0;
                      const losses = r ? (isDoubles ? r.doubles_losses : r.singles_losses) : 0;
                      const total = wins + losses;
                      const streak = r ? (isDoubles ? r.current_doubles_streak : r.current_singles_streak) : 0;
                      const prov = r ? (isDoubles ? r.doubles_provisional : r.singles_provisional) : false;
                      const isMeRow = p.id === meId;

                      return (
                        <tr
                          key={p.id}
                          className={'row-hover' + (isMeRow ? ' me' : '')}
                          onClick={() => { router.push(`/leaderboard/${p.id}`); }}
                        >
                          <td
                            className="num"
                            style={{
                              fontSize: 16,
                              fontWeight: 600,
                              color:
                                i === 0 ? 'var(--gold)'
                                : i === 1 ? 'var(--silver)'
                                : i === 2 ? 'var(--bronze)'
                                : 'var(--ink)',
                            }}
                          >
                            #{i + 1}
                          </td>
                          <td>
                            <div className="row" style={{ gap: 12 }}>
                              <AvatarChip name={p.full_name} id={p.id} src={p.avatar_url} size="sm" ring={isMeRow} />
                              <div>
                                <div style={{ fontWeight: 600, fontSize: 14 }}>{p.full_name}</div>
                                {prov && (
                                  <div className="mono muted" style={{ fontSize: 11 }}>Provisional</div>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="num" style={{ fontWeight: 600, fontSize: 14, textAlign: 'right' }}>{elo}</td>
                          {!isTpts && <td className="num muted" style={{ textAlign: 'right' }}>{wins}–{losses}</td>}
                          {!isTpts && (
                            <td className="num" style={{ textAlign: 'right' }}>
                              {total > 0 ? getWinRate(wins, losses) : <span className="muted">—</span>}
                            </td>
                          )}
                          {!isTpts && (
                            <td className="num" style={{ textAlign: 'right' }}>
                              {typeof streak === 'number' && streak !== 0 ? (
                                <span style={{ color: streak > 0 ? 'var(--win)' : 'var(--loss)' }}>
                                  {streak > 0 ? 'W' : 'L'}{Math.abs(streak)}
                                </span>
                              ) : (
                                <span className="muted">—</span>
                              )}
                            </td>
                          )}
                          <td>
                            <button
                              className="btn btn-sm btn-ghost"
                              onClick={(e) => {
                                e.stopPropagation();
                                router.push(`/challenges/new?opponent=${p.id}`);
                              }}
                              type="button"
                            >
                              <Crosshair size={12} /> Challenge
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
