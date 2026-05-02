export const dynamic = 'force-dynamic';
import { createAdminClient } from '@/lib/supabase-server';
import { formatDateShort as formatDate } from '@badminton/shared';
import { PageHero } from '@badminton/ui';
import Link from 'next/link';
import { CreateMatchForm } from './create-match';

type Participant = {
  team_side: 'a' | 'b';
  player: { full_name: string } | { full_name: string }[] | null;
};

type Match = {
  id: string;
  score_summary: string | null;
  match_type: string;
  result_status: string;
  played_at: string | null;
  created_at: string;
  rated_flag: boolean;
  match_participants: Participant[];
};

export default async function MatchesPage() {
  const supabase = createAdminClient();

  const [{ data: matches }, { data: allPlayers }] = await Promise.all([
    supabase
      .from('matches')
      .select(
        'id, score_summary, match_type, result_status, played_at, created_at, rated_flag, match_participants(team_side, player:players(full_name))'
      )
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('players')
      .select('id, full_name')
      .eq('active_flag', true)
      .neq('status', 'pending_approval')
      .order('full_name'),
  ]);

  const list: Match[] = (matches ?? []) as unknown as Match[];
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayCount = list.filter(
    (m) => new Date((m.played_at ?? m.created_at) as string) >= todayStart
  ).length;
  const reviewCount = list.filter((m) => m.result_status === 'disputed').length;

  return (
    <div>
      <PageHero
        eyebrow={
          reviewCount > 0
            ? `${todayCount} today · ${reviewCount} under review`
            : `${list.length} matches`
        }
        title="Matches."
        subtitle="Every score submitted across the club — confirmed, disputed, and pending."
        watermark="M"
      />

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          padding: '20px 48px 0',
        }}
      >
        <CreateMatchForm players={allPlayers ?? []} />
      </div>

      <div style={{ overflowX: 'auto', padding: '20px 48px 48px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Match', 'Format', 'Score', 'Date', 'Status', 'Actions'].map((h) => (
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
            {list.map((m) => {
              const a = m.match_participants?.filter((p) => p.team_side === 'a') ?? [];
              const b = m.match_participants?.filter((p) => p.team_side === 'b') ?? [];
              const fmt = (arr: Participant[]) =>
                arr
                  .map((p) =>
                    Array.isArray(p.player)
                      ? p.player[0]?.full_name
                      : p.player?.full_name
                  )
                  .filter(Boolean)
                  .join(' & ') || '—';
              const status = m.result_status;
              return (
                <tr key={m.id}>
                  <td
                    style={{
                      padding: '14px 24px',
                      borderBottom: '1px solid var(--hairline-soft)',
                      color: 'var(--ink)',
                      fontSize: 13,
                      fontWeight: 500,
                    }}
                  >
                    {fmt(a)} <span style={{ color: 'var(--faint)' }}>vs</span> {fmt(b)}
                  </td>
                  <td
                    style={{
                      padding: '14px 24px',
                      borderBottom: '1px solid var(--hairline-soft)',
                      color: 'var(--muted)',
                      fontSize: 12,
                      letterSpacing: '0.02em',
                      textTransform: 'capitalize',
                    }}
                  >
                    {m.match_type}
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
                    {m.score_summary || '—'}
                  </td>
                  <td
                    style={{
                      padding: '14px 24px',
                      borderBottom: '1px solid var(--hairline-soft)',
                      color: 'var(--muted)',
                      fontSize: 12,
                    }}
                  >
                    {formatDate(m.played_at ?? m.created_at)}
                  </td>
                  <td
                    style={{
                      padding: '14px 24px',
                      borderBottom: '1px solid var(--hairline-soft)',
                    }}
                  >
                    <StatusBadge status={status} />
                  </td>
                  <td
                    style={{
                      padding: '14px 24px',
                      borderBottom: '1px solid var(--hairline-soft)',
                    }}
                  >
                    {status === 'disputed' ? (
                      <Link
                        href="/disputes"
                        style={{
                          color: 'var(--red)',
                          fontSize: 11,
                          letterSpacing: '0.12em',
                          textTransform: 'uppercase',
                          fontWeight: 600,
                          marginRight: 14,
                        }}
                      >
                        Review
                      </Link>
                    ) : (
                      <Link
                        href={`/matches?match=${m.id}`}
                        style={{
                          color: 'var(--muted)',
                          fontSize: 11,
                          letterSpacing: '0.12em',
                          textTransform: 'uppercase',
                          fontWeight: 600,
                          marginRight: 14,
                        }}
                      >
                        View
                      </Link>
                    )}
                  </td>
                </tr>
              );
            })}
            {list.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  style={{
                    padding: '40px 24px',
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
  );
}

type BadgeConf = { c: string; bg: string; bd: string; label: string };

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, BadgeConf> = {
    confirmed: {
      c: '#4ade80',
      bg: 'rgba(74,222,128,0.08)',
      bd: 'rgba(74,222,128,0.18)',
      label: 'Confirmed',
    },
    disputed: {
      c: '#CC0000',
      bg: 'rgba(204,0,0,0.10)',
      bd: 'rgba(204,0,0,0.22)',
      label: 'Under Review',
    },
    pending: {
      c: '#fbbf24',
      bg: 'rgba(251,191,36,0.08)',
      bd: 'rgba(251,191,36,0.18)',
      label: 'Pending',
    },
    pending_confirmation: {
      c: '#fbbf24',
      bg: 'rgba(251,191,36,0.08)',
      bd: 'rgba(251,191,36,0.18)',
      label: 'Pending',
    },
    resolved: {
      c: 'var(--muted)',
      bg: 'rgba(255,255,255,0.05)',
      bd: 'var(--hairline)',
      label: 'Resolved',
    },
  };
  const fallback: BadgeConf = {
    c: '#fbbf24',
    bg: 'rgba(251,191,36,0.08)',
    bd: 'rgba(251,191,36,0.18)',
    label: status,
  };
  const conf: BadgeConf = map[status] ?? fallback;
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: 9,
        letterSpacing: '0.15em',
        textTransform: 'uppercase',
        fontWeight: 600,
        padding: '3px 8px',
        color: conf.c,
        background: conf.bg,
        border: `1px solid ${conf.bd}`,
        lineHeight: 1.2,
      }}
    >
      {conf.label}
    </span>
  );
}

