'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getPostHogClient } from '@/lib/posthog';
import { createClient } from '@/lib/supabase-browser';
import { Search, Crosshair, Trophy } from 'lucide-react';
import { AvatarChip, PageHeader, normalizeSearchQuery } from '@badminton/ui';
import { getWinRate, getWinRateNumeric } from '@badminton/shared';
import { useStanding } from '@/components/standing-provider';
import { StandingNote } from '@/components/standing-notice';
import {
  topPercentile,
  gapToNext,
  rungProgress,
  winShare,
  formatStreak,
  ladderHistogram,
} from '@/lib/ladder';

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
  handle: string | null;
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
  handle: string | null;
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

// Rating bands in the distribution bar chart. Chosen against the 360px design
// width: 22 bands with a 2px gap gives ~12px bars in the narrow card, which is
// wide enough to draw without the fractional-pixel moiré that a mark-per-player
// strip produced, and fine enough that a ninety-member club still has a shape.
const SPREAD_BANDS = 22;

// The shortest bar a band with anybody in it may be drawn at, as a fraction of
// the tallest. Without a floor, one member in a band next to a peak of thirty
// rounds to nothing and the chart claims the band is empty.
const MIN_BAND_HEIGHT = 0.14;

/** The number this tab ranks by: ELO for a discipline, points for the tournament tab. */
function metricOf(p: LeaderboardEntry, isDoubles: boolean, isTpts: boolean): number {
  if (isTpts) return p._tournamentPoints ?? 0;
  if (!p.ratings) return 0;
  return isDoubles ? p.ratings.doubles_elo : p.ratings.singles_elo;
}

function recordOf(p: LeaderboardEntry, isDoubles: boolean): { wins: number; losses: number } {
  const r = p.ratings;
  return {
    wins: r ? (isDoubles ? r.doubles_wins : r.singles_wins) : 0,
    losses: r ? (isDoubles ? r.doubles_losses : r.singles_losses) : 0,
  };
}

/** "Kiera Watanabe" -> "Kiera". Used only where a full name would wrap a button. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

function LadderRow({
  player,
  index,
  isMe,
  isDoubles,
  isTpts,
  canChallenge,
  onChallenge,
}: {
  player: LeaderboardEntry;
  index: number;
  isMe: boolean;
  isDoubles: boolean;
  isTpts: boolean;
  canChallenge: boolean;
  onChallenge: (id: string) => void;
}) {
  const value = metricOf(player, isDoubles, isTpts);
  const { wins, losses } = recordOf(player, isDoubles);
  const share = winShare(wins, losses);
  const streak = formatStreak(
    player.ratings ? (isDoubles ? player.ratings.current_doubles_streak : player.ratings.current_singles_streak) : null,
  );
  const provisional = player.ratings
    ? (isDoubles ? player.ratings.doubles_provisional : player.ratings.singles_provisional)
    : false;

  // Real name first, handle beside it. A row reading only `@kiera` tells a
  // reader less than both together do, and handle is nullable.
  const subline = [player.handle ? `@${player.handle}` : null, provisional ? 'Provisional' : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className={'ladder-row' + (isMe ? ' me' : '')}>
      <Link href={`/leaderboard/${player.id}`} className="lr-main press">
        <span className="lr-rank" data-medal={index < 3 ? index + 1 : undefined}>
          {index + 1}
        </span>
        <AvatarChip name={player.full_name} id={player.id} src={player.avatar_url} size="sm" ring={isMe} />
        <span className="lr-id">
          <span className="lr-name">{player.full_name}</span>
          {/* A non-breaking space when there is nothing to say, so rows with and
              without a handle keep the same height and the ladder stays a grid. */}
          <span className="lr-sub">{subline || ' '}</span>
        </span>
        <span className="lr-metrics">
          <span className="lr-value">{value}</span>
          {!isTpts && (
            <span className="lr-record">
              {wins}–{losses}
              {share !== null && <> · {getWinRate(wins, losses)}</>}
              {streak && (
                <>
                  {' · '}
                  <span className={streak.tone === 'win' ? 'lr-streak-win' : 'lr-streak-loss'}>
                    {streak.label}
                  </span>
                </>
              )}
            </span>
          )}
          {!isTpts && share !== null && (
            <span className="lr-share" aria-hidden>
              <i style={{ width: `${share * 100}%` }} />
            </span>
          )}
        </span>
      </Link>
      {canChallenge && (
        <button
          className="lr-action"
          type="button"
          aria-label={`Challenge ${player.full_name}`}
          onClick={() => onChallenge(player.id)}
        >
          <Crosshair size={16} />
          <span>Challenge</span>
        </button>
      )}
    </div>
  );
}

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
  // The ladder itself stays for everyone — it is public. Only the CHALLENGE
  // control goes, because createChallenge -> requirePlayer() would refuse it.
  const standing = useStanding();

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

  // Name OR handle, and the `@` is optional — a member is searchable by the
  // thing the club calls them. NOT filterPlayerOptions, which re-ranks: this
  // list is ordered by rating and that ordering is the whole point of a ladder.
  // Only the matching is shared in spirit; the order stays the page's.
  const filtered = useMemo(() => {
    const q = normalizeSearchQuery(searchQuery);
    if (!q) return tabFiltered;
    return tabFiltered.filter(
      (p) => p.full_name.toLowerCase().includes(q) || (p.handle ?? '').toLowerCase().includes(q),
    );
  }, [tabFiltered, searchQuery]);

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
  const eloToNext = gapToNext(myElo, aboveMeElo);

  // The rung is measured against the player immediately BELOW as well, so the
  // bar spans the slot you can actually cross rather than the whole rating axis.
  const belowMe = meIndex >= 0 && meIndex < ranked.length - 1 ? ranked[meIndex + 1] : null;
  const belowMeElo = belowMe?.ratings ? (isDoubles ? belowMe.ratings.doubles_elo : belowMe.ratings.singles_elo) : null;
  const rung = myElo !== null ? rungProgress(belowMeElo, myElo, aboveMeElo) : 0;

  const percentile = topPercentile(meIndex, ranked.length);

  // The shape of the field, recomputed with the ladder because it is a picture
  // OF the ladder — filter the list and the picture is of what is left, which
  // is what a member asking "where am I among the competitive players" wants.
  const spread = useMemo(
    () => ladderHistogram(ranked.map((p) => metricOf(p, isDoubles, isTpts)), meIndex, SPREAD_BANDS),
    [ranked, isDoubles, isTpts, meIndex],
  );

  const top3 = ranked.slice(0, 3);
  const activeLabel = tabs.find((t) => t.id === activeTab)?.label ?? '';

  const goChallenge = (id: string) => router.push(`/challenges/new?opponent=${id}`);

  return (
    <div data-screen-label="Leaderboard">
      <PageHeader eyebrow="LADDER" title="Ranks" sub="Where you sit against everyone." />

      {/* Controls stack above the content on a phone rather than crowding the
          header: the format rail first, then search and sort on one line. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
        {/* aria-pressed rather than role="tab": these chips re-filter the page
            in place, there is no tabpanel for a tab to control, and claiming
            the tab pattern without one is worse for a screen reader than not. */}
        <div className="ranks-rail" role="group" aria-label="Leaderboard format">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={'filter-chip' + (activeTab === t.id ? ' active' : '')}
              onClick={() => setActiveTab(t.id)}
              type="button"
              aria-pressed={activeTab === t.id}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <div className="search-pill ranks-search">
            <Search size={14} className="text-[var(--mute)]" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Name or @handle"
              aria-label="Search leaderboard"
            />
          </div>
          {!isTpts && (
            <div className="ranks-rail" role="group" aria-label="Sort ladder by">
              {sortOptions.map((s) => (
                <button
                  key={s.id}
                  className={'filter-chip' + (sortBy === s.id ? ' active' : '')}
                  onClick={() => setSortBy(s.id)}
                  type="button"
                  aria-pressed={sortBy === s.id}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Phone: one column, in this source order — you, then who to beat, then
          the ladder. Desktop: the same three, with the ladder alongside. */}
      <div className="grid grid-12">
        <div style={{ gridColumn: 'span 4' }} className="feed-col reveal reveal-1">
          {me && !isTpts && (
            <div className="card-base">
              <div className="card-head">
                <h3 className="card-title">Your position</h3>
                <span className="tag tag-red">YOU</span>
              </div>
              <div className="row" style={{ gap: 20, alignItems: 'flex-end' }}>
                <div className="rank-big">
                  <span className="hash">#</span>
                  <span className="num">{meIndex + 1}</span>
                </div>
                <div style={{ flex: 1, textAlign: 'right' }}>
                  <div className="mono" style={{ fontSize: 26, fontWeight: 700, lineHeight: 1 }}>
                    {myElo ?? '—'}
                  </div>
                  <div className="mono muted" style={{ fontSize: 11, marginTop: 4 }}>
                    {isDoubles ? 'DOUBLES ELO' : 'SINGLES ELO'}
                  </div>
                </div>
              </div>
              {percentile !== null && (
                <div className="mono muted" style={{ fontSize: 11, marginTop: 10, letterSpacing: '.08em' }}>
                  TOP {percentile}% · {ranked.length} RANKED
                </div>
              )}

              {/* The field itself: how many members sit in each slice of the
                  rating range, yours in red. It is the only picture this screen
                  can honestly draw — get_leaderboard() returns a current rating
                  and no history, so there is no rating-over-time line to plot.
                  Hidden when everyone is on the same rating, because a chart of
                  one band is a rectangle that says nothing. */}
              {spread.meBucket !== null && spread.max > spread.min && (
                <div style={{ marginTop: 16 }}>
                  <div className="spread" aria-hidden>
                    {spread.buckets.map((count, i) => (
                      <i
                        key={i}
                        className={
                          count === 0 ? 'none' : i === spread.meBucket ? 'me' : undefined
                        }
                        style={{
                          height:
                            count === 0
                              ? 1
                              : `${Math.max(MIN_BAND_HEIGHT, count / spread.peak) * 100}%`,
                        }}
                      />
                    ))}
                  </div>
                  <div className="spread-axis">
                    <span>{spread.min}</span>
                    <span>THE FIELD</span>
                    <span>{spread.max}</span>
                  </div>
                </div>
              )}

              {eloToNext !== null && eloToNext > 0 && aboveMe && (
                <div style={{ marginTop: 16 }}>
                  <div className="rung">
                    <i style={{ width: `${rung * 100}%` }} />
                  </div>
                  <div className="row" style={{ justifyContent: 'space-between', marginTop: 6, gap: 10 }}>
                    <span className="mono muted" style={{ fontSize: 11, letterSpacing: '.08em' }}>
                      {eloToNext} ELO TO #{meIndex}
                    </span>
                    <span
                      className="mono"
                      style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {aboveMe.full_name}
                    </span>
                  </div>
                </div>
              )}

              {/* The one primary action on the screen, at the bottom of the card
                  where a thumb reaches it. Same gate as the per-row control. */}
              {standing.ok && aboveMe && (
                <button
                  className="btn btn-primary"
                  type="button"
                  style={{ width: '100%', justifyContent: 'center', marginTop: 16, padding: '13px 14px' }}
                  onClick={() => goChallenge(aboveMe.id)}
                >
                  <Crosshair size={14} /> Challenge {firstName(aboveMe.full_name)}
                </button>
              )}
            </div>
          )}

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
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {top3.length === 0 && (
                <div className="empty" style={{ padding: 16 }}>No ranked players yet.</div>
              )}
              {top3.map((p, i) => {
                const value = metricOf(p, isDoubles, isTpts);
                const { wins, losses } = recordOf(p, isDoubles);
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
                    <div style={{ width: 36, display: 'grid', placeItems: 'center' }}>
                      <div className="rank-big">
                        <span
                          className="num"
                          style={{
                            fontSize: 30,
                            color: i === 0 ? 'var(--gold)' : i === 1 ? 'var(--silver)' : 'var(--bronze)',
                          }}
                        >
                          {i + 1}
                        </span>
                      </div>
                    </div>
                    <AvatarChip name={p.full_name} id={p.id} src={p.avatar_url} size="md" ring={i === 0} />
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                      <div className="lr-name" style={{ fontSize: 15 }}>{p.full_name}</div>
                      <div className="lr-sub">
                        {p.handle ? `@${p.handle}` : isTpts ? 'Tournament points' : isDoubles ? 'Doubles' : 'Singles'}
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', justifyContent: 'center' }}>
                      <div className="mono" style={{ fontWeight: 700, fontSize: 18 }}>{value}</div>
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
        </div>

        <div style={{ gridColumn: 'span 8' }} className="reveal reveal-2">
          <div className="card-base" style={{ padding: 0, overflow: 'hidden' }}>
            <div
              className="card-head"
              style={{ padding: '20px 20px 14px', borderBottom: '1px solid var(--line)', marginBottom: 0 }}
            >
              <div style={{ width: '100%' }}>
                <h3 className="card-title">{activeLabel} · Full ladder</h3>
                <div className="card-sub">
                  Sorted by {isTpts ? 'points' : sortBy === 'win_rate' ? 'win rate' : 'ELO'} · {ranked.length} of {players.length}
                </div>
                {/* One line, so a ladder with no Challenge control reads as an
                    account state rather than a broken page. */}
                <StandingNote standing={standing} activity="Challenges" style={{ marginTop: 6 }} />
                {/* A row list has no <th> to say what "18–6 · 75% · W3" is. */}
                <div className="ladder-key" style={{ marginTop: 10 }}>
                  <span>#</span>
                  <span>Player</span>
                  <span className="right">{isTpts ? 'Points' : 'ELO · W–L · Win % · Streak'}</span>
                </div>
              </div>
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
              <div className="ladder-list">
                {ranked.map((p, i) => (
                  <LadderRow
                    key={p.id}
                    player={p}
                    index={i}
                    isMe={p.id === meId}
                    isDoubles={isDoubles}
                    isTpts={isTpts}
                    // Same gate as before. Your own row is excluded because
                    // there is no such thing as challenging yourself.
                    canChallenge={standing.ok && p.id !== meId}
                    onChallenge={goChallenge}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
