export const dynamic = 'force-dynamic';
import { createAdminClient } from '@/lib/supabase-server';
import { PageHero } from '@badminton/ui';
import Link from 'next/link';
import { AddPlayerButton } from './add-player-button';

type PlayerRow = {
  id: string;
  full_name: string;
  email: string;
  status: string;
  created_at: string;
  ratings:
    | {
        singles_elo: number | null;
        doubles_elo: number | null;
        singles_wins: number | null;
        singles_losses: number | null;
        doubles_wins: number | null;
        doubles_losses: number | null;
      }
    | null;
};

export default async function PlayersPage() {
  const supabase = createAdminClient();

  const [{ data: rawPlayers }, { count: total }] = await Promise.all([
    supabase
      .from('players')
      .select(
        'id, full_name, email, status, created_at, ratings(singles_elo, doubles_elo, singles_wins, singles_losses, doubles_wins, doubles_losses)'
      )
      .order('created_at', { ascending: false })
      .limit(200),
    supabase.from('players').select('id', { count: 'exact', head: true }),
  ]);

  const players: PlayerRow[] = (rawPlayers ?? []).map((p) => ({
    id: p.id as string,
    full_name: p.full_name as string,
    email: p.email as string,
    status: p.status as string,
    created_at: p.created_at as string,
    ratings: (Array.isArray(p.ratings) ? p.ratings[0] : p.ratings) as PlayerRow['ratings'],
  }));

  const ranked = [...players].sort(
    (a, b) => (b.ratings?.singles_elo ?? 0) - (a.ratings?.singles_elo ?? 0)
  );

  return (
    <div>
      <PageHero
        eyebrow={`Roster · ${total ?? 0} players`}
        title="Players."
        subtitle="Full club roster. Approve pending registrations and review ELO movement across the season."
        watermark="P"
      />

      <div
        className="page-head-actions"
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 12,
          padding: '20px 48px 0',
        }}
      >
        <AddPlayerButton />
      </div>

      <div style={{ overflowX: 'auto', padding: '20px 48px 48px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Rank', 'Full Name', 'Singles ELO', 'Doubles ELO', 'W', 'L', 'Status', 'Joined', 'Actions'].map(
                (h) => (
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
                )
              )}
            </tr>
          </thead>
          <tbody>
            {ranked.map((p, i) => {
              const rank = i + 1;
              const tier = rank <= 3 ? 'top' : rank <= 8 ? 'mid' : 'low';
              const r = p.ratings;
              const isPending = p.status === 'pending_approval';
              const isSuspended = p.status === 'suspended';
              return (
                <tr
                  key={p.id}
                  style={{
                    transition: 'background 120ms ease-out, box-shadow 120ms ease-out',
                  }}
                >
                  <td
                    style={{
                      padding: '14px 24px',
                      borderBottom: '1px solid var(--hairline-soft)',
                      fontFamily: 'var(--font-display)',
                      fontWeight: tier === 'top' ? 700 : 400,
                      color:
                        tier === 'top'
                          ? '#F0F0F0'
                          : tier === 'mid'
                            ? '#555'
                            : '#333',
                      fontVariantNumeric: 'tabular-nums',
                      fontSize: tier === 'top' ? 18 : 14,
                    }}
                  >
                    {String(rank).padStart(2, '0')}
                  </td>
                  <td
                    style={{
                      padding: '14px 24px',
                      borderBottom: '1px solid var(--hairline-soft)',
                      color: 'var(--ink)',
                      fontWeight: 500,
                      fontSize: 13,
                    }}
                  >
                    {p.full_name}
                  </td>
                  <td style={eloCellStyle}>{r?.singles_elo ?? '—'}</td>
                  <td style={eloCellStyle}>{r?.doubles_elo ?? '—'}</td>
                  <td style={numCellStyle}>{r?.singles_wins ?? 0}</td>
                  <td style={numCellStyle}>{r?.singles_losses ?? 0}</td>
                  <td
                    style={{
                      padding: '14px 24px',
                      borderBottom: '1px solid var(--hairline-soft)',
                    }}
                  >
                    <Badge
                      tone={
                        isPending ? 'pending' : isSuspended ? 'suspended' : 'active'
                      }
                    >
                      {isPending ? 'Pending' : isSuspended ? 'Suspended' : 'Active'}
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
                    {formatDate(p.created_at)}
                  </td>
                  <td
                    style={{
                      padding: '14px 24px',
                      borderBottom: '1px solid var(--hairline-soft)',
                    }}
                  >
                    {isPending && <ActionLink href={`/players/${p.id}`} approve>Approve</ActionLink>}
                    <ActionLink href={`/players/${p.id}`}>View</ActionLink>
                  </td>
                </tr>
              );
            })}
            {ranked.length === 0 && (
              <tr>
                <td
                  colSpan={9}
                  style={{
                    padding: '40px 24px',
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
    </div>
  );
}

const eloCellStyle: React.CSSProperties = {
  padding: '14px 24px',
  borderBottom: '1px solid var(--hairline-soft)',
  fontFamily: 'var(--font-display)',
  fontWeight: 600,
  color: 'var(--ink)',
  fontVariantNumeric: 'tabular-nums',
  fontSize: 14,
};

const numCellStyle: React.CSSProperties = {
  padding: '14px 24px',
  borderBottom: '1px solid var(--hairline-soft)',
  fontFamily: 'var(--font-display)',
  fontWeight: 400,
  color: '#555',
  fontVariantNumeric: 'tabular-nums',
  fontSize: 14,
};

function ActionLink({
  href,
  children,
  approve,
}: {
  href: string;
  children: React.ReactNode;
  approve?: boolean;
}) {
  return (
    <Link
      href={href}
      style={{
        color: approve ? 'var(--red)' : 'var(--muted)',
        fontSize: 11,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        fontWeight: 600,
        marginRight: 14,
        textDecoration: 'none',
      }}
    >
      {children}
    </Link>
  );
}

function Badge({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: 'active' | 'pending' | 'suspended';
}) {
  const colors = {
    active: { c: '#4ade80', bg: 'rgba(74,222,128,0.08)', bd: 'rgba(74,222,128,0.18)' },
    pending: { c: '#fbbf24', bg: 'rgba(251,191,36,0.08)', bd: 'rgba(251,191,36,0.18)' },
    suspended: { c: '#CC0000', bg: 'rgba(204,0,0,0.10)', bd: 'rgba(204,0,0,0.22)' },
  }[tone];
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: 9,
        letterSpacing: '0.15em',
        textTransform: 'uppercase',
        fontWeight: 600,
        padding: '3px 8px',
        color: colors.c,
        background: colors.bg,
        border: `1px solid ${colors.bd}`,
        lineHeight: 1.2,
      }}
    >
      {children}
    </span>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
  } catch {
    return iso;
  }
}
