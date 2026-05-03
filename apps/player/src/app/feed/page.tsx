import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Card, SectionLabel } from '@/components/v2/atoms-layout';
import { ActionTile } from '@/components/v2/atoms-form';
import { Avatar, Eyebrow } from '@/components/v2/atoms-display';
import { formatRelative } from '@badminton/shared';
import { SESSION_SELECT_FIELDS } from '@/lib/queries/sessions';
import { FeedDesktopView } from './desktop-view';

type RatingRow = {
  singles_elo: number | null;
  doubles_elo: number | null;
  singles_wins: number | null;
  singles_losses: number | null;
  doubles_wins: number | null;
  doubles_losses: number | null;
  current_singles_streak: number | null;
};

export default async function FeedPage() {
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();
  const ratings = (Array.isArray(player.ratings) ? player.ratings[0] : player.ratings) as
    | RatingRow
    | null;

  const greetingHour = new Date().getHours();
  const greeting =
    greetingHour < 12 ? 'Good morning' : greetingHour < 18 ? 'Good afternoon' : 'Good evening';

  const [
    { data: nextSession },
    { data: topPlayersRaw },
    { data: recentMatchesRaw },
    { data: recentDelta },
    { count: unreadNotifs },
  ] = await Promise.all([
    supabase
      .from('sessions')
      .select(SESSION_SELECT_FIELDS)
      .eq('status', 'open')
      .gte('date', new Date().toISOString())
      .order('date', { ascending: true })
      .limit(1)
      .maybeSingle(),
    // TODO: Phase 10 — scope by organization_id once multi-club is supported.
    supabase
      .from('players')
      .select('id, full_name, avatar_url, ratings(singles_elo, singles_wins, singles_losses)')
      .eq('active_flag', true)
      .is('deleted_at', null)
      .not('status', 'in', '("pending_approval","suspended")'),
    supabase
      .from('match_participants')
      .select('id, win_flag, rating_delta, match:matches(id, score_summary, played_at, match_type, result_status, match_participants(player_id, players(full_name, avatar_url)))')
      .eq('player_id', player.id)
      .order('created_at', { ascending: false, referencedTable: 'matches' })
      .limit(1),
    supabase
      .from('match_participants')
      .select('rating_delta')
      .eq('player_id', player.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('player_id', player.id)
      .eq('read_flag', false),
  ]);

  // Build leaderboard top-5 (singles)
  type TopRow = { id: string; full_name: string; avatar_url: string | null; singles_elo: number | null; sw: number; sl: number };
  const topRanked: TopRow[] = (topPlayersRaw ?? [])
    .map((p) => {
      const r = (Array.isArray(p.ratings) ? p.ratings[0] : p.ratings) as
        | { singles_elo: number | null; singles_wins: number | null; singles_losses: number | null }
        | null;
      return {
        id: p.id,
        full_name: p.full_name,
        avatar_url: p.avatar_url,
        singles_elo: r?.singles_elo ?? null,
        sw: r?.singles_wins ?? 0,
        sl: r?.singles_losses ?? 0,
      };
    })
    .filter((p) => p.singles_elo != null)
    .sort((a, b) => (b.singles_elo ?? 0) - (a.singles_elo ?? 0))
    .slice(0, 5);

  const myRank =
    1 +
    (topPlayersRaw ?? []).filter((p) => {
      const r = (Array.isArray(p.ratings) ? p.ratings[0] : p.ratings) as
        | { singles_elo: number | null }
        | null;
      return (r?.singles_elo ?? 0) > (ratings?.singles_elo ?? 0);
    }).length;

  const totalMatches =
    (ratings?.singles_wins ?? 0) +
    (ratings?.singles_losses ?? 0) +
    (ratings?.doubles_wins ?? 0) +
    (ratings?.doubles_losses ?? 0);
  const totalWins = (ratings?.singles_wins ?? 0) + (ratings?.doubles_wins ?? 0);
  const winRate = totalMatches > 0 ? Math.round((totalWins / totalMatches) * 100) : 0;
  const streak = ratings?.current_singles_streak ?? 0;
  const delta = recentDelta?.rating_delta ?? null;

  const recentMatchRow = recentMatchesRaw?.[0];
  const rawMatch = recentMatchRow?.match as unknown;
  const recentMatch = (Array.isArray(rawMatch) ? rawMatch[0] : rawMatch) as
    | {
        id: string;
        score_summary: string;
        played_at: string;
        match_type: string;
        result_status: string;
        match_participants?: Array<{
          player_id: string;
          players: { full_name: string; avatar_url: string | null } | { full_name: string; avatar_url: string | null }[] | null;
        }>;
      }
    | null;
  const recentWin = recentMatchRow?.win_flag === true;

  // Pick the first participant that isn't the current player as the opponent
  const opponentParticipant = recentMatch?.match_participants?.find(
    (mp) => mp.player_id !== player.id
  );
  const opponentRaw = opponentParticipant?.players;
  const opponent = (Array.isArray(opponentRaw) ? opponentRaw[0] : opponentRaw) as
    | { full_name: string; avatar_url: string | null }
    | null;
  const opponentName = opponent?.full_name ?? 'Opponent';
  const opponentAvatar = opponent?.avatar_url ?? null;

  // ── Pull last 5 confirmed matches for the desktop "Recent Matches" panel
  const { data: recentFiveRaw } = await supabase
    .from('match_participants')
    .select('id, win_flag, rating_delta, match:matches(id, score_summary, played_at, match_type, result_status)')
    .eq('player_id', player.id)
    .order('created_at', { ascending: false, referencedTable: 'matches' })
    .limit(5);

  type FiveRow = {
    id: string;
    win_flag: boolean | null;
    rating_delta: number | null;
    match: { id: string; score_summary: string; played_at: string; match_type: string; result_status: string } | null;
  };
  const recentFive = (recentFiveRaw ?? []).map((r): FiveRow => {
    const m = r.match as unknown;
    return {
      id: r.id,
      win_flag: r.win_flag,
      rating_delta: r.rating_delta,
      match: (Array.isArray(m) ? m[0] : m) ?? null,
    };
  });

  // ── Pull a "Next Challenge" for the desktop next-card
  const { data: nextChallengeRaw } = await supabase
    .from('challenges')
    .select('id, format, scheduled_at, created_at, status, participants:challenge_participants(role, players(full_name, ratings(singles_elo, doubles_elo)))')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextChallenge = nextChallengeRaw as unknown as
    | {
        id: string;
        format: string | null;
        scheduled_at: string | null;
        participants: Array<{
          role: string;
          players: { full_name: string; ratings: { singles_elo: number | null; doubles_elo: number | null }[] | { singles_elo: number | null; doubles_elo: number | null } | null } | null;
        }>;
      }
    | null;

  const myElo = ratings?.singles_elo ?? 1200;
  const desktopGreetTitle = greeting === 'Good morning' ? 'Set the pace.' : greeting === 'Good afternoon' ? 'Stay on the climb.' : 'Close out strong.';

  return (
    <>
      {/* ════════════════════════════════════════════════════
          MOBILE VIEW (existing — phone-frame)
          ════════════════════════════════════════════════════ */}
      <div className="m-only">
      {/* Hero — greeting + ELO */}
      <section
        style={{
          position: 'relative',
          overflow: 'hidden',
          flexShrink: 0,
          background: 'var(--surface1)',
          padding: '20px 24px 24px',
          borderBottom: '1px solid var(--hairline)',
          animation: 'fadeUp 360ms ease both',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: -80,
            right: -80,
            width: 280,
            height: 280,
            background: 'radial-gradient(circle, rgba(var(--red-rgb), 0.16) 0%, transparent 65%)',
            pointerEvents: 'none',
          }}
        />

        <div
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Avatar name={player.full_name} src={player.avatar_url as string | null} size={36} />
            <div>
              <div
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: '1.4px',
                  textTransform: 'uppercase',
                  color: 'var(--text)',
                }}
              >
                {greeting}
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>
                {(player.full_name as string).split(' ')[0]}
              </div>
            </div>
          </div>
          <Link
            href="/notifications"
            style={{
              width: 36,
              height: 36,
              background: 'transparent',
              border: '1px solid var(--hairline)',
              color: '#F2F2F2',
              cursor: 'pointer',
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            aria-label="Notifications"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            {(unreadNotifs ?? 0) > 0 && (
              <span
                className="pulse-dot"
                style={{
                  position: 'absolute',
                  top: 6,
                  right: 6,
                  width: 6,
                  height: 6,
                  background: 'var(--red)',
                }}
              />
            )}
          </Link>
        </div>

        {/* ELO display */}
        <div style={{ position: 'relative', marginTop: 28 }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '1.6px',
              textTransform: 'uppercase',
              color: 'var(--red)',
            }}
          >
            Singles ELO {ratings?.singles_elo != null && `· Rank #${myRank}`}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 4 }}>
            <span
              style={{
                fontSize: 56,
                fontWeight: 700,
                letterSpacing: '-1.5px',
                lineHeight: 1,
                fontFamily: 'JetBrains Mono, monospace',
              }}
            >
              {ratings?.singles_elo ?? '—'}
            </span>
            {delta != null && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 13,
                  fontWeight: 700,
                  color: delta >= 0 ? 'var(--green)' : 'var(--red)',
                }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                  <path d={delta >= 0 ? 'M5 1l4 6H1z' : 'M5 9L1 3h8z'} />
                </svg>
                {delta >= 0 ? '+' : ''}
                {delta}
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text)', marginTop: 6, fontWeight: 500 }}>
            {totalWins} wins · {totalMatches} matches · Season 02
          </div>
        </div>

        {/* Stat row */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: 1,
            marginTop: 22,
            background: 'var(--hairline)',
            border: '1px solid var(--hairline)',
          }}
        >
          {[
            { label: 'Doubles ELO', value: ratings?.doubles_elo ?? '—' },
            { label: 'Win Rate', value: totalMatches > 0 ? `${winRate}%` : '—' },
            { label: 'Streak', value: streak > 0 ? `+${streak}` : streak < 0 ? `${streak}` : '0' },
          ].map((s) => (
            <div key={s.label} style={{ background: 'var(--surface1)', padding: '12px 12px' }}>
              <div
                style={{
                  fontSize: 9,
                  fontWeight: 600,
                  letterSpacing: '1.4px',
                  textTransform: 'uppercase',
                  color: 'var(--text)',
                }}
              >
                {s.label}
              </div>
              <div
                style={{
                  fontSize: 20,
                  fontWeight: 700,
                  lineHeight: 1.1,
                  letterSpacing: '-0.3px',
                  marginTop: 4,
                  fontFamily: 'JetBrains Mono, monospace',
                }}
              >
                {s.value}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Quick actions */}
      <section style={{ padding: '24px 24px 8px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <ActionTile
            label="Challenge"
            sub="Find an opponent"
            primary
            href="/challenges/new"
            icon={
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="13 17 18 12 13 7" />
                <polyline points="6 17 11 12 6 7" />
              </svg>
            }
          />
          <ActionTile
            label="Log Match"
            sub="Report a result"
            href="/submit"
            icon={
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            }
          />
        </div>
      </section>

      {/* Up next session */}
      {nextSession && (() => {
        type Attendee = { full_name: string | null; avatar_url: string | null };
        const sessionExt = nextSession as unknown as {
          session_attendance?: Array<{ players: Attendee | Attendee[] | null }>;
          capacity?: number | null;
          start_time?: string | null;
          end_time?: string | null;
        };
        const attendance = sessionExt.session_attendance ?? [];
        const attendees: Attendee[] = attendance
          .map((row) => (Array.isArray(row.players) ? row.players[0] : row.players))
          .filter((p): p is Attendee => !!p && !!p.full_name);
        const going = attendees.length;
        const capacity = sessionExt.capacity ?? 20;
        const pile = attendees.slice(0, 4);
        const startTime = sessionExt.start_time;
        const endTime = sessionExt.end_time;
        const fmtTime = (t: string) => {
          const [h, m] = t.split(':');
          const hh = parseInt(h ?? '0', 10);
          const mm = parseInt(m ?? '0', 10);
          const ampm = hh >= 12 ? 'pm' : 'am';
          const hr = hh % 12 === 0 ? 12 : hh % 12;
          return mm === 0 ? `${hr}${ampm}` : `${hr}:${mm.toString().padStart(2, '0')}${ampm}`;
        };
        const timeLabel = startTime
          ? endTime
            ? `${fmtTime(startTime)}–${fmtTime(endTime)}`
            : fmtTime(startTime)
          : null;
        return (
          <section style={{ padding: '12px 24px' }}>
            <SectionLabel action="See all →">Up Next</SectionLabel>
            <Link
              href="/sessions"
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                background: 'var(--surface1)',
                border: '1px solid var(--hairline)',
                borderLeft: '3px solid var(--red)',
                padding: 20,
                cursor: 'pointer',
                color: '#F2F2F2',
                textDecoration: 'none',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '1.6px',
                    textTransform: 'uppercase',
                    color: 'var(--red)',
                  }}
                >
                  {formatSessionDateOnly(nextSession.date as string)}
                  {timeLabel && (
                    <>
                      <span style={{ color: 'var(--dim)', margin: '0 6px' }}>·</span>
                      {timeLabel}
                    </>
                  )}
                </span>
              </div>
              <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.2px', lineHeight: 1.2 }}>
                {nextSession.name ?? 'Practice Session'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text)', marginTop: 4 }}>{nextSession.location}</div>
              <div
                style={{
                  marginTop: 14,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ display: 'flex' }}>
                    {pile.map((p, i) => (
                      <div
                        key={i}
                        style={{ marginLeft: i === 0 ? 0 : -10, border: '2px solid var(--surface1)' }}
                      >
                        <Avatar
                          name={p.full_name ?? ''}
                          src={p.avatar_url}
                          size={26}
                        />
                      </div>
                    ))}
                  </div>
                  <span
                    style={{
                      fontSize: 11,
                      color: 'var(--text)',
                      fontWeight: 600,
                      letterSpacing: '0.65px',
                      textTransform: 'uppercase',
                    }}
                  >
                    {going} of {capacity}
                  </span>
                </div>
                <span
                  style={{
                    background: 'var(--red)',
                    color: '#F2F2F2',
                    padding: '6px 14px',
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '1.4px',
                    textTransform: 'uppercase',
                  }}
                >
                  RSVP
                </span>
              </div>
            </Link>
          </section>
        );
      })()}

      {/* Mini leaderboard */}
      {topRanked.length > 0 && (
        <section style={{ padding: '12px 24px' }}>
          <SectionLabel action="Full board →">Top 5 · Singles</SectionLabel>
          <div style={{ background: 'var(--surface1)', border: '1px solid var(--hairline)' }}>
            {topRanked.map((p, i) => (
              <Link
                key={p.id}
                href={`/leaderboard/${p.id}`}
                style={{
                  padding: '12px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  borderTop: i === 0 ? 'none' : '1px solid var(--hairline)',
                  color: '#F2F2F2',
                  textDecoration: 'none',
                }}
              >
                <span
                  style={{
                    width: 22,
                    fontSize: 13,
                    fontWeight: 700,
                    color: i < 3 ? 'var(--red)' : 'var(--dim)',
                    fontFamily: 'JetBrains Mono, monospace',
                  }}
                >
                  {i + 1}
                </span>
                <Avatar name={p.full_name} src={p.avatar_url} size={32} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {p.full_name}
                  </div>
                  <div
                    style={{
                      fontSize: 10,
                      color: 'var(--dim)',
                      letterSpacing: '0.65px',
                      textTransform: 'uppercase',
                      fontWeight: 600,
                    }}
                  >
                    {p.sw}–{p.sl}
                  </div>
                </div>
                <span style={{ fontSize: 14, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}>
                  {p.singles_elo}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Latest result */}
      {recentMatch && (
        <section style={{ padding: '12px 24px 24px' }}>
          <SectionLabel>Latest Result</SectionLabel>
          <Card padding={20}>
            <Eyebrow color={recentMatch.result_status === 'confirmed' ? 'var(--green)' : 'var(--warning)'}>
              {recentMatch.result_status === 'confirmed' ? '✓ Confirmed' : '⏳ Pending'} ·{' '}
              {formatRelative(recentMatch.played_at)}
            </Eyebrow>
            <div
              style={{
                marginTop: 14,
                display: 'grid',
                gridTemplateColumns: '1fr auto 1fr',
                alignItems: 'center',
                gap: 16,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifySelf: 'center',
                }}
              >
                <Avatar name={player.full_name} src={player.avatar_url as string | null} size={48} />
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    marginTop: 8,
                    color: recentWin ? 'var(--green)' : '#F2F2F2',
                    textAlign: 'center',
                  }}
                >
                  {(player.full_name as string).split(' ')[0]}
                </div>
                <div
                  style={{
                    fontSize: 9,
                    color: 'var(--text)',
                    letterSpacing: '1.4px',
                    textTransform: 'uppercase',
                    fontWeight: 700,
                    marginTop: 2,
                    textAlign: 'center',
                  }}
                >
                  {recentWin ? 'Winner' : '—'}
                </div>
              </div>
              <div
                style={{
                  fontSize: 28,
                  fontWeight: 700,
                  color: 'var(--red)',
                  fontFamily: 'JetBrains Mono, monospace',
                  alignSelf: 'center',
                }}
              >
                vs
              </div>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifySelf: 'center',
                }}
              >
                <Avatar name={opponentName} src={opponentAvatar} size={48} />
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    marginTop: 8,
                    color: !recentWin ? 'var(--green)' : '#F2F2F2',
                    textAlign: 'center',
                  }}
                >
                  {opponentName.split(' ')[0]}
                </div>
                <div
                  style={{
                    fontSize: 9,
                    color: 'var(--text)',
                    letterSpacing: '1.4px',
                    textTransform: 'uppercase',
                    fontWeight: 700,
                    marginTop: 2,
                    textAlign: 'center',
                  }}
                >
                  {!recentWin ? 'Winner' : '—'}
                </div>
              </div>
            </div>
            <div
              style={{
                marginTop: 16,
                padding: '10px 14px',
                background: 'var(--surface1)',
                textAlign: 'center',
                fontSize: 14,
                fontWeight: 700,
                fontFamily: 'JetBrains Mono, monospace',
                letterSpacing: '0.5px',
              }}
            >
              {recentMatch.score_summary || '—'}
            </div>
            <div
              style={{
                marginTop: 12,
                fontSize: 10,
                color: 'var(--text)',
                textAlign: 'center',
                letterSpacing: '0.65px',
                textTransform: 'uppercase',
                fontWeight: 600,
              }}
            >
              {recentMatch.match_type}
              {recentMatchRow?.rating_delta != null && ` · ELO ${recentMatchRow.rating_delta > 0 ? '+' : ''}${recentMatchRow.rating_delta}`}
            </div>
          </Card>
          {/* Phase 8: discoverability for the full match history surface
              that mobile users couldn't otherwise reach without going
              through the desktop sidebar. */}
          <div style={{ marginTop: 12, textAlign: 'center' }}>
            <Link
              href="/my-matches"
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: 'var(--red)',
                textDecoration: 'none',
                padding: '8px 12px',
              }}
            >
              View match history →
            </Link>
          </div>
        </section>
      )}
      </div>{/* /.m-only */}

      {/* ════════════════════════════════════════════════════
          DESKTOP VIEW (≥1024px) — sidebar + main from player-app.html
          ════════════════════════════════════════════════════ */}
      <FeedDesktopView greeting={greeting} desktopGreetTitle={desktopGreetTitle} myRank={myRank} myElo={myElo} ratings={ratings} delta={delta} totalMatches={totalMatches} totalWins={totalWins} winRate={winRate} recentFive={recentFive} nextChallenge={nextChallenge} />
    </>
  );
}

function formatSessionDateOnly(iso: string): string {
  try {
    const d = new Date(iso);
    const day = d.toLocaleDateString('en-US', { weekday: 'short' });
    const month = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${day} · ${month}`;
  } catch {
    return iso;
  }
}

