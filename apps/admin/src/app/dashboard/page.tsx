export const dynamic = 'force-dynamic';
import { createAdminClient } from '@/lib/supabase-server';
import { formatDate } from '@badminton/shared';
import { Badge, PageHero, StatCard } from '@badminton/ui';
import Link from 'next/link';

const SEASON_LABEL = 'Season 02 · Spring 2026';

export default async function DashboardPage() {
  const supabase = createAdminClient();

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startOfWeekAgo = new Date();
  startOfWeekAgo.setDate(startOfWeekAgo.getDate() - 7);

  const [
    { count: totalPlayers },
    { count: pendingPlayers },
    { count: openDisputes },
    { count: activeChalls },
    { count: activeSessions },
    { count: matchesToday },
    { count: playersAddedThisWeek },
    { data: recentPlayers },
    { data: recentMatches },
  ] = await Promise.all([
    supabase
      .from('players')
      .select('id', { count: 'exact', head: true })
      .neq('status', 'pending_approval'),
    supabase
      .from('players')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending_approval'),
    supabase.from('disputes').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    supabase
      .from('challenges')
      .select('id', { count: 'exact', head: true })
      .in('status', ['proposed', 'partially_confirmed', 'accepted']),
    supabase.from('sessions').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    supabase
      .from('matches')
      .select('id', { count: 'exact', head: true })
      .gte('played_at', startOfDay.toISOString()),
    supabase
      .from('players')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', startOfWeekAgo.toISOString()),
    supabase
      .from('players')
      .select('id, full_name, status, created_at, ratings(singles_elo)')
      .order('created_at', { ascending: false })
      .limit(5),
    supabase
      .from('matches')
      .select(
        'id, score_summary, played_at, match_type, result_status, created_at, match_participants(player_id, team_side, win_flag, player:players(full_name))'
      )
      .order('created_at', { ascending: false })
      .limit(5),
  ]);

  const hasAlerts = (pendingPlayers ?? 0) > 0 || (openDisputes ?? 0) > 0;

  return (
    <div>
      <PageHero
        eyebrow={SEASON_LABEL}
        title="Run your club like a team."
        subtitle="Approve players, resolve disputes, keep the season moving. Everything that needs your attention, in one place."
        watermark="S02"
      />

      {hasAlerts && (
        <div
          style={{
            background: 'var(--red-tint)',
            borderLeft: '3px solid var(--red)',
            borderBottom: '1px solid var(--hairline)',
            padding: '14px 48px',
            display: 'flex',
            alignItems: 'center',
            gap: 16,
          }}
        >
          <div style={{ flex: 1, fontSize: 12, color: 'var(--ink)', letterSpacing: '0.02em' }}>
            <span
              aria-hidden
              style={{
                display: 'inline-block',
                width: 6,
                height: 6,
                background: 'var(--red)',
                marginRight: 8,
                verticalAlign: 'middle',
                animation: 'pulse 1.6s ease-in-out infinite',
              }}
            />
            <strong style={{ color: 'var(--ink)', fontWeight: 600 }}>
              Items need your attention
            </strong>
            {(pendingPlayers ?? 0) > 0 && (
              <>
                <span style={{ color: 'var(--faint)', margin: '0 10px' }}>—</span>
                {pendingPlayers} pending approval{pendingPlayers === 1 ? '' : 's'}
              </>
            )}
            {(openDisputes ?? 0) > 0 && (
              <>
                <span style={{ color: 'var(--faint)', margin: '0 10px' }}>·</span>
                {openDisputes} open dispute{openDisputes === 1 ? '' : 's'}
              </>
            )}
          </div>
          <Link
            href="/disputes"
            style={{
              background: 'var(--red)',
              color: '#fff',
              padding: '10px 16px',
              fontFamily: 'var(--font-body)',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 10,
              lineHeight: 1,
            }}
          >
            Review →
          </Link>
        </div>
      )}

      <div
        className="stats-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(6, 1fr)',
          background: 'var(--hairline)',
          gap: 1,
          borderBottom: '1px solid var(--hairline)',
        }}
      >
        <StatCard
          label="Total Players"
          value={totalPlayers ?? 0}
          delta={
            (playersAddedThisWeek ?? 0) > 0 ? `+${playersAddedThisWeek} this week` : '—'
          }
        />
        <StatCard label="Active Sessions" value={activeSessions ?? 0} />
        <StatCard label="Matches Today" value={matchesToday ?? 0} />
        <StatCard
          label="Pending Approvals"
          value={pendingPlayers ?? 0}
          delta={(pendingPlayers ?? 0) > 0 ? 'Requires action' : '—'}
          deltaVariant={(pendingPlayers ?? 0) > 0 ? 'action' : 'default'}
        />
        <StatCard
          label="Open Disputes"
          value={openDisputes ?? 0}
          highlight={(openDisputes ?? 0) > 0}
          delta={(openDisputes ?? 0) > 0 ? 'Requires action' : '—'}
          deltaVariant={(openDisputes ?? 0) > 0 ? 'action' : 'default'}
        />
        <StatCard label="Active Challenges" value={activeChalls ?? 0} />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          background: 'var(--hairline)',
          gap: 1,
        }}
      >
        <div style={{ background: 'var(--surface1)' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '20px 24px',
              borderBottom: '1px solid var(--hairline)',
            }}
          >
            <div
              style={{
                fontSize: 10,
                letterSpacing: '0.2em',
                textTransform: 'uppercase',
                color: 'var(--ink)',
                fontWeight: 700,
              }}
            >
              Players <span style={{ color: 'var(--faint)', marginLeft: 8, fontWeight: 500 }}>/ Recent</span>
            </div>
            <Link
              href="/players"
              style={{
                fontSize: 10,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: 'var(--muted)',
                fontWeight: 600,
              }}
            >
              View All →
            </Link>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['#', 'Full Name', 'Singles ELO', 'Status', 'Joined'].map((h, i) => (
                  <th
                    key={h}
                    style={{
                      textAlign: 'left',
                      fontSize: 9,
                      letterSpacing: '0.18em',
                      textTransform: 'uppercase',
                      fontWeight: 600,
                      color: 'var(--faint)',
                      padding: '12px 24px',
                      borderBottom: '1px solid var(--hairline)',
                      whiteSpace: 'nowrap',
                      width: i === 0 ? 40 : undefined,
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(recentPlayers ?? []).map((p, i) => {
                const r = Array.isArray(p.ratings) ? p.ratings[0] : p.ratings;
                const elo = (r as { singles_elo: number | null } | null)?.singles_elo ?? null;
                const isPending = p.status === 'pending_approval';
                return (
                  <tr key={p.id}>
                    <td
                      style={{
                        padding: '14px 24px',
                        borderBottom: '1px solid var(--hairline-soft)',
                        fontFamily: 'var(--font-display)',
                        color: '#555',
                        fontSize: 14,
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {String(i + 1).padStart(2, '0')}
                    </td>
                    <td
                      style={{
                        padding: '14px 24px',
                        borderBottom: '1px solid var(--hairline-soft)',
                        fontSize: 13,
                        color: 'var(--ink)',
                        fontWeight: 500,
                      }}
                    >
                      {p.full_name}
                    </td>
                    <td
                      style={{
                        padding: '14px 24px',
                        borderBottom: '1px solid var(--hairline-soft)',
                        fontFamily: 'var(--font-display)',
                        color: 'var(--ink)',
                        fontWeight: 600,
                        fontVariantNumeric: 'tabular-nums',
                        fontSize: 14,
                      }}
                    >
                      {elo ?? '—'}
                    </td>
                    <td
                      style={{
                        padding: '14px 24px',
                        borderBottom: '1px solid var(--hairline-soft)',
                      }}
                    >
                      <Badge variant={isPending ? 'warning' : 'success'}>
                        {isPending ? 'Pending' : 'Active'}
                      </Badge>
                    </td>
                    <td
                      style={{
                        padding: '14px 24px',
                        borderBottom: '1px solid var(--hairline-soft)',
                        color: 'var(--muted)',
                        fontSize: 12,
                        letterSpacing: '0.02em',
                      }}
                    >
                      {formatDate(p.created_at as string)}
                    </td>
                  </tr>
                );
              })}
              {(!recentPlayers || recentPlayers.length === 0) && (
                <tr>
                  <td
                    colSpan={5}
                    style={{
                      padding: '32px 24px',
                      textAlign: 'center',
                      color: 'var(--muted)',
                      fontSize: 12,
                    }}
                  >
                    No players yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div style={{ background: 'var(--surface1)' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '20px 24px',
              borderBottom: '1px solid var(--hairline)',
            }}
          >
            <div
              style={{
                fontSize: 10,
                letterSpacing: '0.2em',
                textTransform: 'uppercase',
                color: 'var(--ink)',
                fontWeight: 700,
              }}
            >
              Matches <span style={{ color: 'var(--faint)', marginLeft: 8, fontWeight: 500 }}>/ Recent</span>
            </div>
            <Link
              href="/matches"
              style={{
                fontSize: 10,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: 'var(--muted)',
                fontWeight: 600,
              }}
            >
              View All →
            </Link>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Match', 'Score', 'Date', 'Status'].map((h) => (
                  <th
                    key={h}
                    style={{
                      textAlign: 'left',
                      fontSize: 9,
                      letterSpacing: '0.18em',
                      textTransform: 'uppercase',
                      fontWeight: 600,
                      color: 'var(--faint)',
                      padding: '12px 24px',
                      borderBottom: '1px solid var(--hairline)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(recentMatches ?? []).map((m) => {
                const parts = (m.match_participants ?? []) as Array<{
                  team_side: 'a' | 'b';
                  player: { full_name: string } | { full_name: string }[] | null;
                }>;
                const a = parts.filter((p) => p.team_side === 'a');
                const b = parts.filter((p) => p.team_side === 'b');
                const fmt = (arr: typeof a) =>
                  arr
                    .map((p) =>
                      Array.isArray(p.player)
                        ? p.player[0]?.full_name
                        : p.player?.full_name
                    )
                    .filter(Boolean)
                    .join(' & ') || '—';
                const status = m.result_status as string;
                return (
                  <tr key={m.id}>
                    <td
                      style={{
                        padding: '14px 24px',
                        borderBottom: '1px solid var(--hairline-soft)',
                        fontSize: 13,
                        color: 'var(--ink)',
                        fontWeight: 500,
                      }}
                    >
                      {fmt(a)}{' '}
                      <span style={{ color: 'var(--faint)' }}>vs</span>{' '}
                      {fmt(b)}
                    </td>
                    <td
                      style={{
                        padding: '14px 24px',
                        borderBottom: '1px solid var(--hairline-soft)',
                        fontFamily: 'var(--font-display)',
                        fontWeight: 600,
                        color: 'var(--ink)',
                        fontSize: 12,
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {(m.score_summary as string) || '—'}
                    </td>
                    <td
                      style={{
                        padding: '14px 24px',
                        borderBottom: '1px solid var(--hairline-soft)',
                        color: 'var(--muted)',
                        fontSize: 12,
                      }}
                    >
                      {formatDate(m.played_at as string)}
                    </td>
                    <td
                      style={{
                        padding: '14px 24px',
                        borderBottom: '1px solid var(--hairline-soft)',
                      }}
                    >
                      <Badge
                        variant={
                          status === 'confirmed'
                            ? 'success'
                            : status === 'disputed'
                              ? 'danger'
                              : 'warning'
                        }
                      >
                        {status}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
              {(!recentMatches || recentMatches.length === 0) && (
                <tr>
                  <td
                    colSpan={4}
                    style={{
                      padding: '32px 24px',
                      textAlign: 'center',
                      color: 'var(--muted)',
                      fontSize: 12,
                    }}
                  >
                    No matches yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

