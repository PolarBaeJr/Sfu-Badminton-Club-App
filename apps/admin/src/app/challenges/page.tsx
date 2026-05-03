export const dynamic = 'force-dynamic';
import { createAdminClient } from '@/lib/supabase-server';
import { Card, Badge } from '@badminton/ui';
import { MATCH_FORMAT_LABELS, formatRelativeTime } from '@badminton/shared';
import { ChallengeActions } from './actions';
import { CreateChallengeForm } from './create-challenge';
import { QrModalButton } from './qr-modal';
import { Swords, Plus, Clock, CheckCircle2, XCircle, Users, Trophy } from 'lucide-react';

export default async function ChallengesPage() {
  const supabase = createAdminClient();

  // Fetch challenges, active season, and player roster in parallel — they're
  // independent. Was 3 sequential round-trips.
  const [
    { data: challenges },
    { data: activeSeason },
    { data: allPlayers },
  ] = await Promise.all([
    supabase
      .from('challenges')
      .select('*, creator:players!challenges_created_by_fkey(full_name), challenge_participants(*, player:players(full_name)), matches(id)')
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('seasons')
      .select('id, start_date')
      .eq('active_flag', true)
      .maybeSingle(),
    supabase
      .from('players')
      .select('id, full_name')
      .eq('active_flag', true)
      .neq('status', 'pending_approval')
      .order('full_name'),
  ]);

  // QR adoption analytics depend on the active season — small follow-up query.
  let qrStats: { qr: number; total: number; pct: number } = { qr: 0, total: 0, pct: 0 };
  if (activeSeason?.start_date) {
    const { data: seasonChallenges } = await supabase
      .from('challenges')
      .select('submitted_via')
      .gte('created_at', activeSeason.start_date)
      .in('status', ['completed', 'disputed', 'walkover_confirmed']);
    const total = seasonChallenges?.length ?? 0;
    const qr = seasonChallenges?.filter((c) => c.submitted_via === 'qr').length ?? 0;
    qrStats = { qr, total, pct: total > 0 ? Math.round((qr / total) * 100) : 0 };
  }

  const statusVariant = (s: string) => {
    switch (s) {
      case 'proposed': case 'partially_confirmed': return 'warning' as const;
      case 'accepted': return 'info' as const;
      case 'completed': return 'success' as const;
      case 'rejected': case 'expired': case 'cancelled': return 'neutral' as const;
      case 'disputed': case 'walkover_pending': return 'danger' as const;
      default: return 'neutral' as const;
    }
  };

  const StatusIcon = ({ status }: { status: string }) => {
    switch (status) {
      case 'proposed':
      case 'partially_confirmed':
        return <Clock size={14} style={{ color: 'var(--ds-accent)', opacity: 0.8 }} />;
      case 'accepted':
        return <CheckCircle2 size={14} style={{ color: 'var(--ds-accent)' }} />;
      case 'completed':
        return <CheckCircle2 size={14} style={{ color: '#22c55e' }} />;
      case 'rejected':
      case 'expired':
      case 'cancelled':
        return <XCircle size={14} style={{ color: 'var(--text-muted)' }} />;
      case 'disputed':
      case 'walkover_pending':
        return <XCircle size={14} style={{ color: '#ef4444' }} />;
      default:
        return <Clock size={14} style={{ color: 'var(--text-muted)' }} />;
    }
  };

  const activeCount = challenges?.filter(c =>
    ['proposed', 'partially_confirmed', 'accepted'].includes(c.status)
  ).length ?? 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      {/* Page Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div style={{
            width: '48px',
            height: '48px',
            borderRadius: '12px',
            background: 'var(--ds-accent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: 0.9,
          }}>
            <Swords size={24} style={{ color: '#F2F2F2' }} />
          </div>
          <div>
            <h1 style={{
              fontSize: '1.875rem',
              fontWeight: 700,
              color: 'var(--text-primary)',
              lineHeight: 1.2,
            }}>
              CHALLENGES
            </h1>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', marginTop: '2px' }}>
              Manage player challenges and match disputes
            </p>
          </div>
        </div>
        <CreateChallengeForm players={allPlayers || []} />
      </div>

      {/* Stats Row */}
      <div style={{ display: 'flex', gap: '1rem' }}>
        <div style={{
          flex: 1,
          padding: '1rem 1.25rem',
          borderRadius: '10px',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
            <Trophy size={14} style={{ color: 'var(--ds-accent)' }} />
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 500, letterSpacing: '0.05em' }}>
              Total Challenges
            </span>
          </div>
          <span style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            {challenges?.length ?? 0}
          </span>
        </div>
        <div style={{
          flex: 1,
          padding: '1rem 1.25rem',
          borderRadius: '10px',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
            <Clock size={14} style={{ color: 'var(--ds-accent)' }} />
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 500, letterSpacing: '0.05em' }}>
              Active
            </span>
          </div>
          <span style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            {activeCount}
          </span>
        </div>
        <div style={{
          flex: 1,
          padding: '1rem 1.25rem',
          borderRadius: '10px',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
            <Users size={14} style={{ color: 'var(--ds-accent)' }} />
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 500, letterSpacing: '0.05em' }}>
              Players
            </span>
          </div>
          <span style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            {allPlayers?.length ?? 0}
          </span>
        </div>
        <div style={{
          flex: 1,
          padding: '1rem 1.25rem',
          borderRadius: '10px',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
            <CheckCircle2 size={14} style={{ color: 'var(--ds-accent)' }} />
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 500, letterSpacing: '0.05em' }}>
              QR Submissions (season)
            </span>
          </div>
          <span style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            {qrStats.qr} / {qrStats.total}
          </span>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginLeft: '0.5rem' }}>
            ({qrStats.pct}%)
          </span>
        </div>
      </div>

      {/* Section Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
        <div style={{
          width: '28px',
          height: '28px',
          borderRadius: '8px',
          background: 'var(--ds-accent)',
          opacity: 0.15,
          position: 'absolute',
        }} />
        <div style={{
          width: '28px',
          height: '28px',
          borderRadius: '8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
        }}>
          <Swords size={15} style={{ color: 'var(--ds-accent)' }} />
        </div>
        <h2 style={{
          fontSize: '0.875rem',
          fontWeight: 600,
          color: 'var(--text-primary)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}>
          All Challenges
        </h2>
        <span style={{
          fontSize: '0.75rem',
          color: 'var(--text-muted)',
          background: 'var(--border)',
          padding: '2px 8px',
          borderRadius: '9999px',
          fontWeight: 500,
        }}>
          {challenges?.length ?? 0}
        </span>
      </div>

      {/* Challenges Table */}
      <Card padding={false}>
        <div className="overflow-x-auto">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: '0.875rem 1.25rem', textAlign: 'left', fontSize: '0.6875rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  Creator
                </th>
                <th style={{ padding: '0.875rem 1.25rem', textAlign: 'left', fontSize: '0.6875rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  Participants
                </th>
                <th style={{ padding: '0.875rem 1.25rem', textAlign: 'left', fontSize: '0.6875rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  Type
                </th>
                <th style={{ padding: '0.875rem 1.25rem', textAlign: 'left', fontSize: '0.6875rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  Format
                </th>
                <th style={{ padding: '0.875rem 1.25rem', textAlign: 'left', fontSize: '0.6875rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  Status
                </th>
                <th style={{ padding: '0.875rem 1.25rem', textAlign: 'left', fontSize: '0.6875rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  Created
                </th>
                <th style={{ padding: '0.875rem 1.25rem', textAlign: 'right', fontSize: '0.6875rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {challenges?.map((c, index) => (
                <tr
                  key={c.id}
                  className="hover:bg-white/5 transition-colors"
                  style={{
                    borderBottom: index < (challenges?.length ?? 0) - 1 ? '1px solid var(--border)' : 'none',
                  }}
                >
                  <td style={{ padding: '1rem 1.25rem', fontSize: '0.875rem', color: 'var(--text-primary)', fontWeight: 500 }}>
                    {(c.creator as Record<string, unknown>)?.full_name as string}
                  </td>
                  <td style={{ padding: '1rem 1.25rem', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                    {c.challenge_participants?.map((p: Record<string, unknown>) =>
                      ((p.player as Record<string, unknown>)?.full_name as string)
                    ).join(', ')}
                  </td>
                  <td style={{ padding: '1rem 1.25rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                      <Badge variant={c.type === 'singles' ? 'default' : 'info'}>{c.type}</Badge>
                      {c.rated_flag && <Badge variant="warning" className="ml-1">Rated</Badge>}
                    </div>
                  </td>
                  <td style={{ padding: '1rem 1.25rem', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                    {MATCH_FORMAT_LABELS[c.format as keyof typeof MATCH_FORMAT_LABELS]}
                  </td>
                  <td style={{ padding: '1rem 1.25rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                      <StatusIcon status={c.status} />
                      <Badge variant={statusVariant(c.status)}>{c.status}</Badge>
                    </div>
                  </td>
                  <td style={{ padding: '1rem 1.25rem', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                    {formatRelativeTime(c.created_at)}
                  </td>
                  <td style={{ padding: '1rem 1.25rem', textAlign: 'right' }}>
                    <div style={{ display: 'inline-flex', gap: '0.375rem', alignItems: 'center' }}>
                      {c.status === 'accepted' && (
                        <QrModalButton
                          challengeId={c.id}
                          status={c.status}
                          hasExistingQr={!!(c as Record<string, unknown>).qr_token}
                          hasMatch={Array.isArray((c as Record<string, unknown>).matches) && ((c as Record<string, unknown>).matches as unknown[]).length > 0}
                        />
                      )}
                      {['proposed', 'partially_confirmed', 'accepted'].includes(c.status) && (
                        <ChallengeActions challengeId={c.id} />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Empty State */}
        {(!challenges || challenges.length === 0) && (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '4rem 2rem',
            gap: '1rem',
          }}>
            <div style={{
              width: '64px',
              height: '64px',
              borderRadius: '16px',
              background: 'var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <Swords size={28} style={{ color: 'var(--text-muted)' }} />
            </div>
            <div style={{ textAlign: 'center' }}>
              <p style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.25rem' }}>
                No challenges yet
              </p>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                Create a new challenge to get players competing against each other.
              </p>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
