import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { SectionLabel } from '@/components/v2/atoms-layout';
import { Avatar, Eyebrow, StatusPill } from '@/components/v2/atoms-display';
import { DPageHead } from '@/components/desktop/page-shell';

export default async function MyStatsPage() {
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();
  const r = (Array.isArray(player.ratings) ? player.ratings[0] : player.ratings) as
    | {
        singles_elo: number | null;
        doubles_elo: number | null;
        singles_wins: number | null;
        singles_losses: number | null;
        doubles_wins: number | null;
        doubles_losses: number | null;
        current_singles_streak: number | null;
        best_singles_streak: number | null;
      }
    | null;

  // Compute rank + unread notifications in parallel
  const [{ data: allRanked }, { count: unreadNotifs }] = await Promise.all([
    supabase
      .from('players')
      .select('id, ratings(singles_elo)')
      .eq('active_flag', true)
      .not('status', 'in', '("pending_approval","suspended")'),
    supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('player_id', player.id)
      .eq('read_flag', false),
  ]);
  const myRank =
    1 +
    (allRanked ?? []).filter((p) => {
      const rr = (Array.isArray(p.ratings) ? p.ratings[0] : p.ratings) as
        | { singles_elo: number | null }
        | null;
      return (rr?.singles_elo ?? 0) > (r?.singles_elo ?? 0);
    }).length;

  // Last 6 ELO trend (singles only)
  const { data: lastSingles } = await supabase
    .from('match_participants')
    .select('rating_delta, match:matches(played_at, match_type)')
    .eq('player_id', player.id)
    .order('created_at', { ascending: false })
    .limit(20);

  const trend = buildTrend((r?.singles_elo as number | null) ?? 1500, lastSingles ?? []);
  const points = trend.length >= 2 ? buildPolyline(trend) : '';

  const sw = r?.singles_wins ?? 0;
  const sl = r?.singles_losses ?? 0;
  const dw = r?.doubles_wins ?? 0;
  const dl = r?.doubles_losses ?? 0;
  const totalMatches = sw + sl + dw + dl;
  const totalWins = sw + dw;
  const winrate = totalMatches > 0 ? Math.round((totalWins / totalMatches) * 100) : 0;
  const streak = r?.current_singles_streak ?? 0;

  const trendDelta =
    trend.length >= 2 ? Math.round((trend[trend.length - 1] ?? 0) - (trend[0] ?? 0)) : 0;

  // ── Build SVG sparkline path for desktop ELO history chart
  const sparkPoints = (() => {
    if (trend.length < 2) return '';
    const max = Math.max(...trend);
    const min = Math.min(...trend);
    const range = max - min || 1;
    return trend
      .map((v, i) => `${(i / (trend.length - 1)) * 800},${80 - ((v - min) / range) * 70 - 5}`)
      .join(' ');
  })();
  const sparkEnd = trend.length >= 2
    ? {
        x: 800,
        y: 80 - ((trend[trend.length - 1]! - Math.min(...trend)) / (Math.max(...trend) - Math.min(...trend) || 1)) * 70 - 5,
      }
    : null;
  const seasonHigh = trend.length > 0 ? Math.max(...trend) : null;
  const seasonLow = trend.length > 0 ? Math.min(...trend) : null;

  // Achievement chips derived from real stats
  const achievements: string[] = [];
  if (totalMatches >= 10) achievements.push('10 Matches');
  if (totalWins >= 1) achievements.push('First Win');
  if ((r?.best_singles_streak ?? 0) >= 5) achievements.push('Win Streak ×5');
  if (myRank <= 10) achievements.push('Top 10');
  if (totalMatches >= 1) achievements.push('Season Debut');

  return (
    <>
      <div className="m-only">
      {/* Hero */}
      <section
        style={{
          position: 'relative',
          overflow: 'hidden',
          flexShrink: 0,
          background: 'linear-gradient(160deg, var(--surface2) 0%, #2a1410 50%, var(--surface1) 100%)',
          padding: '24px 24px 28px',
          borderBottom: '1px solid var(--hairline)',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: -40,
            right: -40,
            width: 240,
            height: 240,
            background: 'radial-gradient(circle, rgba(204,0,0,0.20) 0%, transparent 70%)',
          }}
        />
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 16 }}>
          <Avatar
            name={player.full_name as string}
            src={player.avatar_url as string | null}
            size={72}
            ring
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <Eyebrow>Member · #{myRank}</Eyebrow>
            <h1
              style={{
                fontSize: 24,
                fontWeight: 500,
                letterSpacing: '-0.4px',
                marginTop: 4,
              }}
            >
              {player.full_name}
            </h1>
            {player.status && (
              <div style={{ marginTop: 6 }}>
                <StatusPill status={player.status as string} />
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ELO Trend */}
      <section style={{ padding: '20px 24px 8px' }}>
        <SectionLabel>Singles ELO · Last {Math.min(trend.length, 6)} matches</SectionLabel>
        <div style={{ background: 'var(--surface1)', border: '1px solid var(--hairline)', padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            <span
              style={{
                fontSize: 36,
                fontWeight: 700,
                letterSpacing: '-0.7px',
                fontFamily: 'JetBrains Mono, monospace',
              }}
            >
              {r?.singles_elo ?? '—'}
            </span>
            {trendDelta !== 0 && (
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: trendDelta >= 0 ? 'var(--green)' : 'var(--red)',
                }}
              >
                {trendDelta >= 0 ? '+' : ''}
                {trendDelta}
              </span>
            )}
            <span
              style={{
                fontSize: 10,
                color: 'var(--dim)',
                letterSpacing: '0.65px',
                textTransform: 'uppercase',
                fontWeight: 600,
                marginLeft: 'auto',
              }}
            >
              30 days
            </span>
          </div>
          {trend.length >= 2 ? (
            <>
              <div style={{ position: 'relative', marginTop: 16 }}>
                <svg width="100%" height="84" viewBox="0 0 100 100" preserveAspectRatio="none">
                  <line
                    x1="0"
                    y1="25"
                    x2="100"
                    y2="25"
                    stroke="var(--hairline)"
                    strokeWidth="0.5"
                    strokeDasharray="1,2"
                    vectorEffect="non-scaling-stroke"
                  />
                  <line
                    x1="0"
                    y1="75"
                    x2="100"
                    y2="75"
                    stroke="var(--hairline)"
                    strokeWidth="0.5"
                    strokeDasharray="1,2"
                    vectorEffect="non-scaling-stroke"
                  />
                  <polyline points={`0,100 ${points} 100,100`} fill="rgba(204,0,0,0.12)" />
                  <polyline
                    points={points}
                    fill="none"
                    stroke="var(--red)"
                    strokeWidth="2"
                    vectorEffect="non-scaling-stroke"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <div
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: 0,
                    width: 8,
                    height: 8,
                    background: 'var(--red)',
                    boxShadow: '0 0 0 3px rgba(204,0,0,0.25)',
                    transform: 'translate(50%, -50%)',
                  }}
                />
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginTop: 10,
                  fontSize: 9,
                  color: 'var(--dim)',
                  fontWeight: 600,
                  letterSpacing: '1px',
                  textTransform: 'uppercase',
                  fontFamily: 'JetBrains Mono, monospace',
                }}
              >
                {trend.map((_, i) => (
                  <span key={i}>M{i + 1}</span>
                ))}
              </div>
            </>
          ) : (
            <div style={{ marginTop: 16, fontSize: 12, color: 'var(--text)', textAlign: 'center', padding: '20px 0' }}>
              Play a few matches to see your trend.
            </div>
          )}
        </div>
      </section>

      {/* Stat grid */}
      <section style={{ padding: '12px 24px' }}>
        <SectionLabel>Season stats</SectionLabel>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 1,
            background: 'var(--hairline)',
            border: '1px solid var(--hairline)',
          }}
        >
          {[
            { label: 'Singles ELO', value: r?.singles_elo ?? '—' },
            { label: 'Doubles ELO', value: r?.doubles_elo ?? '—' },
            { label: 'Singles W/L', value: `${sw}–${sl}` },
            { label: 'Doubles W/L', value: `${dw}–${dl}` },
            { label: 'Win Rate', value: totalMatches > 0 ? `${winrate}%` : '—' },
            {
              label: 'Streak',
              value: streak > 0 ? `+${streak}` : streak < 0 ? `${streak}` : '0',
            },
          ].map((s) => (
            <div key={s.label} style={{ background: 'var(--surface1)', padding: '16px 18px' }}>
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
                  fontSize: 22,
                  fontWeight: 700,
                  lineHeight: 1.1,
                  letterSpacing: '-0.3px',
                  marginTop: 6,
                  fontFamily: 'JetBrains Mono, monospace',
                }}
              >
                {s.value}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Account list */}
      <section style={{ padding: '12px 24px 24px' }}>
        <SectionLabel>Account</SectionLabel>
        <div style={{ background: 'var(--surface1)', border: '1px solid var(--hairline)' }}>
          {(
            [
              { label: 'Edit Profile', view: 'profile' },
              {
                label: 'Notifications',
                view: 'notifications',
                badge: unreadNotifs && unreadNotifs > 0 ? String(unreadNotifs) : undefined,
              },
              { label: 'Match Preferences', view: 'matches' },
              { label: 'Privacy & Visibility', view: 'privacy' },
              { label: 'Help & Feedback', view: 'help' },
              { label: 'Sign Out', view: 'signout', danger: true as const },
            ] as Array<{ label: string; view: string; badge?: string; danger?: true }>
          ).map((item, i) => (
            <Link
              key={item.label}
              href={`/settings?view=${item.view}`}
              style={{
                width: '100%',
                padding: '16px 18px',
                textAlign: 'left',
                background: 'transparent',
                border: 'none',
                borderTop: i === 0 ? 'none' : '1px solid var(--hairline)',
                color: item.danger ? 'var(--red)' : 'var(--ink)',
                fontFamily: 'inherit',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                textDecoration: 'none',
              }}
            >
              <span>{item.label}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {item.badge && (
                  <span
                    style={{
                      background: 'var(--red)',
                      color: 'var(--ink)',
                      fontSize: 9,
                      fontWeight: 700,
                      padding: '2px 6px',
                      letterSpacing: '0.5px',
                    }}
                  >
                    {item.badge}
                  </span>
                )}
                <span style={{ color: 'var(--dim)', fontSize: 18 }}>›</span>
              </span>
            </Link>
          ))}
        </div>
      </section>
      </div>{/* /.m-only */}

      {/* DESKTOP VIEW */}
      <div className="d-only">
        <DPageHead
          eyebrow="Player Card"
          title="My Profile."
          meta="Your public-facing card. ELO history, achievements, and member since."
        />
        <div className="d-profile-card">
          <div className="d-profile-avatar">
            {(player.full_name as string)
              .split(' ')
              .map((p) => p[0])
              .filter(Boolean)
              .slice(0, 2)
              .join('')
              .toUpperCase()}
          </div>
          <div>
            <div className="d-profile-name">{player.full_name as string}</div>
            <div className="d-profile-meta">
              Rank #{myRank} · ELO {r?.singles_elo ?? '—'} · {totalMatches} matches · Season 02
            </div>
          </div>
        </div>

        <div className="d-sparkline-wrap">
          <div className="d-sparkline-label">Singles ELO History — Season 02</div>
          {sparkPoints ? (
            <svg className="d-sparkline" viewBox="0 0 800 80" preserveAspectRatio="none">
              {/* Dashed grid lines */}
              <line x1="0" y1="20" x2="800" y2="20" stroke="rgba(255,255,255,0.04)" strokeDasharray="2 4" />
              <line x1="0" y1="40" x2="800" y2="40" stroke="rgba(255,255,255,0.04)" strokeDasharray="2 4" />
              <line x1="0" y1="60" x2="800" y2="60" stroke="rgba(255,255,255,0.04)" strokeDasharray="2 4" />
              <polyline
                points={sparkPoints}
                fill="none"
                stroke="var(--red)"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
              {sparkEnd && <circle cx={sparkEnd.x} cy={sparkEnd.y} r="4" fill="var(--red)" />}
            </svg>
          ) : (
            <div style={{ color: 'var(--text-faint)', fontSize: 12, padding: '20px 0' }}>
              Play a few matches to see your ELO trend.
            </div>
          )}
          <div className="d-spark-stats">
            <div className="d-spark-stat">
              <span className="d-lbl">Season High</span>
              <span className="d-val">{seasonHigh ?? '—'}</span>
            </div>
            <div className="d-spark-stat">
              <span className="d-lbl">Season Low</span>
              <span className="d-val">{seasonLow ?? '—'}</span>
            </div>
            <div className="d-spark-stat">
              <span className="d-lbl">Net Gain</span>
              <span className={`d-val ${trendDelta > 0 ? 'd-val-green' : trendDelta < 0 ? 'd-val-red' : ''}`}>
                {trendDelta > 0 ? '+' : ''}{trendDelta}
              </span>
            </div>
          </div>
        </div>

        <div className="d-achievements">
          <div className="d-ach-label">Achievements</div>
          <div className="d-ach-row">
            {achievements.length === 0 ? (
              <div className="d-ach" style={{ color: 'var(--text-faint)' }}>
                Play a match to earn your first
              </div>
            ) : (
              achievements.map((a) => (
                <div key={a} className="d-ach">
                  {a}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function buildTrend(currentElo: number, history: Array<{ rating_delta: number | null }>): number[] {
  // history is most-recent-first. Walk back applying deltas to reconstruct the
  // ELO at each point, then reverse so the oldest is first.
  const recent = history.slice(0, 6);
  if (recent.length === 0) return [];
  const out: number[] = [currentElo];
  let elo = currentElo;
  for (const m of recent) {
    elo -= m.rating_delta ?? 0;
    out.push(elo);
  }
  return out.reverse();
}

function buildPolyline(trend: number[]): string {
  const max = Math.max(...trend);
  const min = Math.min(...trend);
  const range = max - min || 1;
  return trend
    .map((v, i) => `${(i / (trend.length - 1)) * 100},${100 - ((v - min) / range) * 100}`)
    .join(' ');
}
