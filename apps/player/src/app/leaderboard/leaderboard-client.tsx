'use client';

import { useState, useEffect, useMemo } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { getPostHogClient } from '@/lib/posthog';
import { Avatar, ScreenHeader, SectionLabel } from '@/components/v2/atoms';
import type { LeaderboardEntry } from './page';

type TabId = 'singles' | 'doubles';

interface LeaderboardClientProps {
  players: LeaderboardEntry[];
  currentPlayerId: string | null;
}

const leaderboardFetcher = (url: string) => fetch(url).then((r) => r.json());

export function LeaderboardClient({
  players: initialPlayers,
  currentPlayerId,
}: LeaderboardClientProps) {
  const { data } = useSWR<{ players: LeaderboardEntry[] }>('/api/leaderboard', leaderboardFetcher, {
    fallbackData: { players: initialPlayers },
  });
  const players = data?.players ?? initialPlayers;

  const [tab, setTab] = useState<TabId>('singles');

  useEffect(() => {
    const ph = getPostHogClient();
    if (ph) ph.capture('leaderboard_viewed');
  }, []);

  const sorted = useMemo(() => {
    const ranked = [...players]
      .filter((p) => p.ratings != null)
      .sort((a, b) => {
        const av = tab === 'singles' ? a.ratings?.singles_elo ?? 0 : a.ratings?.doubles_elo ?? 0;
        const bv = tab === 'singles' ? b.ratings?.singles_elo ?? 0 : b.ratings?.doubles_elo ?? 0;
        return bv - av;
      });
    return ranked.map((p, i) => ({
      id: p.id,
      full_name: p.full_name,
      avatar_url: p.avatar_url,
      elo: tab === 'singles' ? p.ratings?.singles_elo ?? null : p.ratings?.doubles_elo ?? null,
      wins: tab === 'singles' ? p.ratings?.singles_wins ?? 0 : p.ratings?.doubles_wins ?? 0,
      losses: tab === 'singles' ? p.ratings?.singles_losses ?? 0 : p.ratings?.doubles_losses ?? 0,
      rank: i + 1,
    }));
  }, [tab, players]);

  const podium = sorted.slice(0, 3);
  const rest = sorted.slice(3);

  return (
    <>
      <ScreenHeader eyebrow="Season 02 · Spring 2026" title="Leaderboard" />

      {/* Tabs */}
      <div style={{ padding: '0 24px', marginBottom: 16 }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 0,
            border: '1px solid #303030',
          }}
        >
          {([
            { id: 'singles', label: 'Singles' },
            { id: 'doubles', label: 'Doubles' },
          ] as { id: TabId; label: string }[]).map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                style={{
                  padding: '12px',
                  background: active ? '#da291c' : 'transparent',
                  color: active ? '#fff' : '#969696',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '1.4px',
                  textTransform: 'uppercase',
                  fontFamily: 'inherit',
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Podium */}
      {podium.length >= 3 && (
        <div style={{ padding: '0 24px 8px' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1.2fr 1fr',
              gap: 8,
              alignItems: 'end',
            }}
          >
            {([podium[1]!, podium[0]!, podium[2]!]).map((p, i) => {
              const place = ([2, 1, 3] as const)[i]!;
              const h = ([80, 110, 70] as const)[i]!;
              const isMe = p.id === currentPlayerId;
              return (
                <Link
                  key={p.id}
                  href={`/leaderboard/${p.id}`}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    color: '#fff',
                    textDecoration: 'none',
                    animation: `fadeUp 400ms ${i * 80}ms ease both`,
                  }}
                >
                  <Avatar
                    name={p.full_name}
                    src={p.avatar_url}
                    size={place === 1 ? 60 : 48}
                    ring
                  />
                  <div
                    style={{
                      fontSize: place === 1 ? 14 : 12,
                      fontWeight: 700,
                      marginTop: 8,
                      textAlign: 'center',
                      maxWidth: '100%',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: isMe ? '#da291c' : '#fff',
                    }}
                  >
                    {p.full_name.split(' ')[0]}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: '#969696',
                      fontFamily: 'JetBrains Mono, monospace',
                      fontWeight: 600,
                      textAlign: 'center',
                    }}
                  >
                    {p.elo ?? '—'}
                  </div>
                  <div
                    style={{
                      height: h,
                      width: '100%',
                      background: place === 1 ? '#da291c' : '#303030',
                      marginTop: 8,
                      display: 'flex',
                      alignItems: 'flex-start',
                      justifyContent: 'center',
                      paddingTop: 12,
                      color: place === 1 ? '#fff' : '#969696',
                      fontSize: 28,
                      fontWeight: 700,
                      fontFamily: 'JetBrains Mono, monospace',
                    }}
                  >
                    {place}
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* Rest */}
      <div style={{ padding: '20px 24px 0' }}>
        <SectionLabel>The rest</SectionLabel>
        {rest.length > 0 ? (
          <div style={{ background: '#222', border: '1px solid #303030' }}>
            {rest.map((p, i) => {
              const isMe = p.id === currentPlayerId;
              return (
                <Link
                  key={p.id}
                  href={`/leaderboard/${p.id}`}
                  style={{
                    padding: '14px 16px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    borderTop: i === 0 ? 'none' : '1px solid #303030',
                    color: '#fff',
                    textDecoration: 'none',
                    background: isMe ? 'rgba(218,41,28,0.08)' : 'transparent',
                  }}
                >
                  <span
                    style={{
                      width: 22,
                      fontSize: 13,
                      fontWeight: 700,
                      color: isMe ? '#da291c' : '#666',
                      fontFamily: 'JetBrains Mono, monospace',
                    }}
                  >
                    {p.rank}
                  </span>
                  <Avatar name={p.full_name} src={p.avatar_url} size={32} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: isMe ? '#da291c' : '#fff',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {p.full_name}
                    </div>
                    {p.elo != null && (
                      <div
                        style={{
                          fontSize: 10,
                          color: '#666',
                          letterSpacing: '0.65px',
                          textTransform: 'uppercase',
                          fontWeight: 600,
                          marginTop: 2,
                        }}
                      >
                        {p.wins}–{p.losses}
                      </div>
                    )}
                  </div>
                  <span
                    style={{
                      fontSize: 14,
                      fontWeight: 700,
                      fontFamily: 'JetBrains Mono, monospace',
                    }}
                  >
                    {p.elo ?? '—'}
                  </span>
                </Link>
              );
            })}
          </div>
        ) : (
          <div
            style={{
              padding: '32px 24px',
              textAlign: 'center',
              fontSize: 12,
              color: '#969696',
              background: '#222',
              border: '1px solid #303030',
            }}
          >
            No more players ranked yet.
          </div>
        )}
      </div>
    </>
  );
}
