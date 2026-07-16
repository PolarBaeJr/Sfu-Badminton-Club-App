'use client';

import { useState, useEffect, useMemo } from 'react';
import { createClient } from '@/lib/supabase-browser';
import Link from 'next/link';
import { getPostHogClient } from '@/lib/posthog';
import { Search, Crosshair, ChevronRight } from 'lucide-react';
import { AvatarChip, PageHeader } from '@badminton/ui';

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

type LeaderboardEntry = {
  id: string;
  full_name: string;
  status: string;
  ratings: Ratings | null;
  hide_from_leaderboard?: boolean;
  _tournamentPoints?: number;
};

type CategoryId = 'open_singles' | 'open_doubles' | 'comp_singles' | 'comp_doubles' | 'tournament_points';

const tabs: { id: CategoryId; label: string; short: string }[] = [
  { id: 'open_singles',      label: 'Open Singles',     short: 'Open S.' },
  { id: 'open_doubles',      label: 'Open Doubles',     short: 'Open D.' },
  { id: 'comp_singles',      label: 'Comp Singles',     short: 'Comp S.' },
  { id: 'comp_doubles',      label: 'Comp Doubles',     short: 'Comp D.' },
  { id: 'tournament_points', label: 'Tournament Pts',   short: 'TPts' },
];

export default function LeaderboardPage() {
  const [activeTab, setActiveTab] = useState<CategoryId>('open_singles');
  const [players, setPlayers] = useState<LeaderboardEntry[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    const ph = getPostHogClient();
    if (ph) ph.capture('leaderboard_viewed');
  }, []);

  useEffect(() => {
    const supabase = createClient();

    async function loadMe() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: p } = await supabase.from('players').select('id').eq('user_id', user.id).maybeSingle();
      setMeId(p?.id ?? null);
    }
    loadMe();
  }, []);

  useEffect(() => {
    const supabase = createClient();

    async function load() {
      setLoading(true);

      if (activeTab === 'tournament_points') {
        const { data: parts, error: partsError } = await supabase
          .from('tournament_participants')
          .select('player_id, points, player:players!player_id(id, full_name, status, hide_from_leaderboard)')
          .not('status', 'in', '("withdrawn","disqualified")')
          .gt('points', 0);

        if (partsError) {
          setLoadError(partsError.message);
          setPlayers([]);
          setLoading(false);
          return;
        }
        setLoadError(null);

        const totals: Record<string, { player: LeaderboardEntry; total: number }> = {};
        for (const p of parts ?? []) {
          const player = (Array.isArray(p.player) ? p.player[0] : p.player) as LeaderboardEntry | null;
          if (!player || player.hide_from_leaderboard) continue;
          const entry = totals[p.player_id] ?? (totals[p.player_id] = { player, total: 0 });
          entry.total += (p.points as number) ?? 0;
        }
        const sorted = Object.values(totals)
          .sort((a, b) => b.total - a.total)
          .map((entry) => ({ ...entry.player, _tournamentPoints: entry.total, ratings: null }));
        setPlayers(sorted);
        setLoading(false);
        return;
      }

      let query = supabase
        .from('players')
        .select('id, full_name, status, hide_from_leaderboard, ratings(*)')
        .eq('active_flag', true)
        .eq('hide_from_leaderboard', false)
        .not('status', 'in', '("pending_approval","suspended")');

      if (activeTab.startsWith('comp_')) query = query.eq('status', 'competitive');

      const { data, error } = await query;

      if (error) {
        setLoadError(error.message);
        setPlayers([]);
        setLoading(false);
        return;
      }
      setLoadError(null);

      const sorted = (data || [])
        .map((p) => ({ ...p, ratings: (Array.isArray(p.ratings) ? p.ratings[0] : p.ratings) as Ratings | null }))
        .filter((p) => p.ratings)
        .sort((a, b) => {
          const isDoubles = activeTab.includes('doubles');
          return isDoubles
            ? (b.ratings?.doubles_elo ?? 0) - (a.ratings?.doubles_elo ?? 0)
            : (b.ratings?.singles_elo ?? 0) - (a.ratings?.singles_elo ?? 0);
        });

      setPlayers(sorted as LeaderboardEntry[]);
      setLoading(false);
    }
    load();

    const channel = supabase
      .channel('ratings-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ratings' }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [activeTab]);

  const isDoubles = activeTab.includes('doubles');
  const isTpts = activeTab === 'tournament_points';

  const filtered = useMemo(
    () => searchQuery ? players.filter((p) => p.full_name.toLowerCase().includes(searchQuery.toLowerCase())) : players,
    [players, searchQuery]
  );

  const meIndex = useMemo(
    () => filtered.findIndex((p) => p.id === meId),
    [filtered, meId]
  );
  const me = meIndex >= 0 ? filtered[meIndex] : null;
  const myElo = me?.ratings ? (isDoubles ? me.ratings.doubles_elo : me.ratings.singles_elo) : null;
  const aboveMe = meIndex > 0 ? filtered[meIndex - 1] : null;
  const aboveMeElo = aboveMe?.ratings ? (isDoubles ? aboveMe.ratings.doubles_elo : aboveMe.ratings.singles_elo) : null;
  const eloToNext = myElo !== null && aboveMeElo !== null ? aboveMeElo - myElo : null;

  const top3 = filtered.slice(0, 3);

  return (
    <div data-screen-label="Leaderboard">
      <PageHeader
        eyebrow="RANKINGS · LIVE"
        title="Leaderboard"
        sub={`ELO updates after every confirmed match. ${filtered.length} ranked players in ${tabs.find((t) => t.id === activeTab)?.label}.`}
        actions={
          <div
            className="row"
            style={{
              border: '1px solid var(--line)',
              borderRadius: 999,
              padding: '4px 6px 4px 14px',
              gap: 6,
              background: 'var(--surface)',
            }}
          >
            <Search size={14} className="text-[var(--mute)]" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search player..."
              aria-label="Search leaderboard"
              style={{
                border: 0,
                background: 'transparent',
                padding: '6px 0',
                width: 180,
                fontSize: 13,
                outline: 'none',
              }}
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
        <div style={{ gridColumn: 'span 4' }} className="feed-col">
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
              {top3.length === 0 && !loading && (
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
                    className="row press"
                    style={{
                      alignItems: 'stretch',
                      gap: 14,
                      padding: 14,
                      border: '1px solid var(--line)',
                      borderRadius: 12,
                      background: i === 0 ? 'var(--red-wash)' : 'transparent',
                    }}
                  >
                    <div style={{ width: 40, display: 'grid', placeItems: 'center' }}>
                      <div className="rank-big">
                        <span className="hash">#</span>
                        <span
                          className="num"
                          style={{ fontSize: 32, color: i === 0 ? 'var(--red)' : 'var(--ink)' }}
                        >
                          {i + 1}
                        </span>
                      </div>
                    </div>
                    <AvatarChip name={p.full_name} id={p.id} size="md" ring={i === 0} />
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                      <div style={{ fontWeight: 600, fontSize: 15 }}>{p.full_name}</div>
                      <div className="mono muted" style={{ fontSize: 11 }}>
                        {isTpts ? 'Tournament points' : isDoubles ? 'Doubles' : 'Singles'}
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', justifyContent: 'center' }}>
                      <div className="mono" style={{ fontWeight: 700, fontSize: 18 }}>{elo}</div>
                      {!isTpts && (
                        <div className="mono muted" style={{ fontSize: 11 }}>{wins}–{losses}</div>
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

        <div style={{ gridColumn: 'span 8' }}>
          <div className="card-base" style={{ padding: 0, overflow: 'hidden' }}>
            <div
              className="card-head row"
              style={{ padding: '20px 20px 14px', borderBottom: '1px solid var(--line)', marginBottom: 0, justifyContent: 'space-between' }}
            >
              <div>
                <h3 className="card-title">{tabs.find((t) => t.id === activeTab)?.label} · Full Ladder</h3>
                <div className="card-sub">
                  Sorted by {isTpts ? 'points' : 'ELO'} · {filtered.length} of {players.length}
                </div>
              </div>
            </div>
            {loading ? (
              <div className="empty">Loading rankings…</div>
            ) : loadError ? (
              <div className="empty">Couldn&apos;t load rankings: {loadError}</div>
            ) : filtered.length === 0 ? (
              <div className="empty">
                {searchQuery ? `No players match "${searchQuery}".` : 'No ranked players yet.'}
              </div>
            ) : (
              <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
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
                    {filtered.map((p, i) => {
                      const r = p.ratings;
                      const elo = r ? (isDoubles ? r.doubles_elo : r.singles_elo) : (p._tournamentPoints ?? 0);
                      const wins = r ? (isDoubles ? r.doubles_wins : r.singles_wins) : 0;
                      const losses = r ? (isDoubles ? r.doubles_losses : r.singles_losses) : 0;
                      const total = wins + losses;
                      const pct = total > 0 ? Math.round((wins / total) * 100) : 0;
                      const streak = r ? (isDoubles ? r.current_doubles_streak : r.current_singles_streak) : 0;
                      const prov = r ? (isDoubles ? r.doubles_provisional : r.singles_provisional) : false;
                      const isMeRow = p.id === meId;

                      return (
                        <tr
                          key={p.id}
                          className={'row-hover' + (isMeRow ? ' me' : '')}
                          onClick={() => { window.location.href = `/leaderboard/${p.id}`; }}
                        >
                          <td className="num" style={{ fontSize: 16, fontWeight: 600, color: i < 3 ? 'var(--red)' : 'var(--ink)' }}>
                            #{i + 1}
                          </td>
                          <td>
                            <div className="row" style={{ gap: 12 }}>
                              <AvatarChip name={p.full_name} id={p.id} size="sm" ring={isMeRow} />
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
                          {!isTpts && <td className="num" style={{ textAlign: 'right' }}>{pct}%</td>}
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
                                window.location.href = `/challenges/new?opponent=${p.id}`;
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
