export const dynamic = 'force-dynamic';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { Card, Badge, TableCard, Atomic } from '@badminton/ui';
import { MATCH_FORMAT_LABELS, formatRelativeTime } from '@badminton/shared';
import { SearchableTable } from '@/components/searchable-table';
import { ChallengeActions } from './actions';
import { CreateChallengeForm } from './create-challenge';
import { Swords, Plus, Clock, CheckCircle2, XCircle, Users, Trophy } from 'lucide-react';

export default async function ChallengesPage() {
  // The same capability middleware already resolves for '/challenges', re-asked
  // where the rows are read. This page opened a service-role client and queried
  // immediately, so every row below depended on middleware having run.
  await requireCapability('challenges.page');
  const supabase = createAdminClient();

  const { data: challenges } = await supabase
    .from('challenges')
    .select('*, creator:players!challenges_created_by_fkey(full_name), challenge_participants(*, player:players(full_name))')
    .order('created_at', { ascending: false })
    .limit(50);

  // Get all active players for the create challenge form
  const { data: allPlayers } = await supabase
    .from('players')
    .select('id, full_name, avatar_url')
    .eq('active_flag', true)
    .neq('status', 'pending_approval')
    .order('full_name');

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
        return <Clock size={14} style={{ color: 'var(--color-accent)', opacity: 0.8 }} />;
      case 'accepted':
        return <CheckCircle2 size={14} style={{ color: 'var(--color-accent)' }} />;
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

  // Both renderings of a row are built here, from one set of names, so the
  // desktop <tr> and the phone <TableCard> cannot come to disagree about who is
  // on a challenge — and so the search has one key to match rather than two.
  const challengeRows = (challenges ?? []).map((c) => {
    const creatorName = (c.creator as Record<string, unknown>)?.full_name as string | undefined;
    const participantNames: string[] = (c.challenge_participants ?? [])
      .map((p: Record<string, unknown>) => (p.player as Record<string, unknown>)?.full_name as string)
      .filter(Boolean);
    const actions = ['proposed', 'partially_confirmed', 'accepted'].includes(c.status)
      ? <ChallengeActions challengeId={c.id} />
      : undefined;

    return {
      id: c.id as string,
      // The creator is in the key alongside the participants: they have their
      // own column, and on a challenge nobody has answered yet they can be the
      // only person named on the row.
      players: Array.from(new Set([creatorName, ...participantNames].filter(Boolean) as string[])),
      card: (
        <TableCard
          title={<Atomic separator=",">{participantNames.join(', ')}</Atomic>}
          badges={
            <>
              <Badge variant={c.type === 'singles' ? 'default' : 'info'}>{c.type}</Badge>
              {c.rated_flag && <Badge variant="warning">Rated</Badge>}
              <span className="inline-flex items-center gap-1.5">
                <StatusIcon status={c.status} />
                <Badge variant={statusVariant(c.status)}>{c.status}</Badge>
              </span>
            </>
          }
          fields={[
            { label: 'Creator', value: <Atomic>{creatorName}</Atomic> },
            { label: 'Created', value: formatRelativeTime(c.created_at) },
            { label: 'Format', value: MATCH_FORMAT_LABELS[c.format as keyof typeof MATCH_FORMAT_LABELS], wide: true },
          ]}
          actions={actions}
        />
      ),
      row: (
        <tr className="hover:bg-white/5 transition-colors">
          <td style={{ padding: '1rem 1.25rem', fontSize: '0.875rem', color: 'var(--text-primary)', fontWeight: 500 }}>
            {creatorName}
          </td>
          <td style={{ padding: '1rem 1.25rem', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
            {participantNames.join(', ')}
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
            {actions}
          </td>
        </tr>
      ),
    };
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      {/* Page Header — wraps so the New Challenge button drops below the title
          on a phone instead of pushing the page sideways. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div style={{
            width: '48px',
            height: '48px',
            borderRadius: '12px',
            background: 'var(--color-accent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: 0.9,
          }}>
            <Swords size={24} style={{ color: 'white' }} />
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

      {/* Stats Row — three equal tiles on desktop (same flex-grow, same basis),
          wrapping to two-up on a phone rather than overflowing. */}
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
        <div style={{
          flex: '1 1 150px',
          padding: '1rem 1.25rem',
          borderRadius: '10px',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
            <Trophy size={14} style={{ color: 'var(--color-accent)' }} />
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 500, letterSpacing: '0.05em' }}>
              Total Challenges
            </span>
          </div>
          <span style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            {challenges?.length ?? 0}
          </span>
        </div>
        <div style={{
          flex: '1 1 150px',
          padding: '1rem 1.25rem',
          borderRadius: '10px',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
            <Clock size={14} style={{ color: 'var(--color-accent)' }} />
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 500, letterSpacing: '0.05em' }}>
              Active
            </span>
          </div>
          <span style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            {activeCount}
          </span>
        </div>
        <div style={{
          flex: '1 1 150px',
          padding: '1rem 1.25rem',
          borderRadius: '10px',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
            <Users size={14} style={{ color: 'var(--color-accent)' }} />
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 500, letterSpacing: '0.05em' }}>
              Players
            </span>
          </div>
          <span style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            {allPlayers?.length ?? 0}
          </span>
        </div>
      </div>

      {/* Section Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
        <div style={{
          width: '28px',
          height: '28px',
          borderRadius: '8px',
          background: 'var(--color-accent)',
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
          <Swords size={15} style={{ color: 'var(--color-accent)' }} />
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
        <SearchableTable
          head={
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
          }
          rows={challengeRows}
          label="Search challenges by player"
          // "any player" rather than "opponent": a row matches on whoever is
          // named on it, which is the question an admin is actually asking.
          placeholder="Search by any player…"
          noun="challenge"
          empty={
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
          }
        />
      </Card>
    </div>
  );
}
