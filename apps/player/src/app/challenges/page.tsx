import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  Avatar,
  ScreenHeader,
  SectionLabel,
  Pill,
  EmptyState,
} from '@/components/v2/atoms';
import { formatRelative, formatScheduled } from '@badminton/shared';
import { InlineChallengeActions } from './inline-actions';
import { NewChallengeButton, SuggestedChallengeButton } from './sheet-controls';
import { DPageHead } from '@/components/desktop/page-shell';
import { DesktopChallengeForm } from './desktop-challenge-form';

type Challenge = {
  id: string;
  status: string;
  type: string;
  rated_flag: boolean;
  format: string;
  created_by: string;
  created_at: string;
  scheduled_at: string | null;
  creator: { full_name: string; avatar_url: string | null } | null;
  challenge_participants: Array<{
    player: { id: string; full_name: string; avatar_url: string | null } | null;
  }>;
};

export default async function ChallengesPage() {
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();

  const [{ data: myChallengesRaw }, { data: suggestedRaw }] = await Promise.all([
    supabase
      .from('challenge_participants')
      .select('id, confirmation_status, challenge:challenges(id, status, type, rated_flag, format, created_by, created_at, scheduled_at, creator:players!challenges_created_by_fkey(full_name, avatar_url), challenge_participants(player:players(id, full_name, avatar_url)))')
      .eq('player_id', player.id)
      .order('created_at', { ascending: false, referencedTable: 'challenges' })
      .limit(40),
    supabase
      .from('players')
      .select('id, full_name, avatar_url, ratings(singles_elo)')
      .eq('active_flag', true)
      .neq('id', player.id)
      .not('status', 'in', '("pending_approval","suspended")')
      .limit(20),
  ]);

  const myChallenges = (myChallengesRaw ?? []).map((cp) => ({
    cp_id: cp.id,
    confirmation_status: cp.confirmation_status as string,
    challenge: cp.challenge as unknown as Challenge | null,
  }));

  const incoming = myChallenges.filter(
    (cp) => cp.challenge && cp.challenge.created_by !== player.id && cp.confirmation_status === 'pending'
  );
  const sent = myChallenges.filter((cp) => cp.challenge && cp.challenge.created_by === player.id);

  // Sort suggested by ELO closeness to my singles ELO
  const myElo = ((player.ratings as { singles_elo?: number } | null)?.singles_elo) ?? 1500;
  const suggested = (suggestedRaw ?? [])
    .map((p) => {
      const r = (Array.isArray(p.ratings) ? p.ratings[0] : p.ratings) as { singles_elo: number | null } | null;
      return {
        id: p.id,
        full_name: p.full_name,
        avatar_url: p.avatar_url,
        singles_elo: r?.singles_elo ?? null,
      };
    })
    .filter((p) => p.singles_elo != null)
    .sort((a, b) => Math.abs((a.singles_elo ?? 0) - myElo) - Math.abs((b.singles_elo ?? 0) - myElo))
    .slice(0, 6);

  return (
    <>
      <div className="m-only">
      <ScreenHeader
        eyebrow="Compete"
        title="Challenges"
        action={<NewChallengeButton />}
      />

      {/* Incoming */}
      {incoming.length > 0 && (
        <section style={{ padding: '0 24px 16px' }}>
          <SectionLabel>Incoming · {incoming.length}</SectionLabel>
          {incoming.map(({ challenge: c, cp_id }) => {
            if (!c) return null;
            return (
              <div
                key={cp_id}
                style={{
                  background: '#222',
                  border: '1px solid #303030',
                  borderLeft: '3px solid #da291c',
                  padding: 16,
                  marginBottom: 8,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <Link
                  href={`/challenges/${c.id}`}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    color: '#fff',
                    textDecoration: 'none',
                  }}
                >
                  <Avatar
                    name={c.creator?.full_name ?? 'Unknown'}
                    src={c.creator?.avatar_url}
                    size={44}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{c.creator?.full_name}</div>
                    <div style={{ fontSize: 11, color: '#969696', marginTop: 2 }}>
                      {c.type} · {c.scheduled_at ? formatScheduled(c.scheduled_at) : formatRelative(c.created_at)}
                    </div>
                  </div>
                </Link>
                <InlineChallengeActions challengeId={c.id} />
              </div>
            );
          })}
        </section>
      )}

      {/* Sent */}
      {sent.length > 0 && (
        <section style={{ padding: '0 24px 16px' }}>
          <SectionLabel>Sent · {sent.length}</SectionLabel>
          {sent.map(({ challenge: c, cp_id }) => {
            if (!c) return null;
            const opponents = c.challenge_participants
              .map((p) => p.player)
              .filter((p): p is { id: string; full_name: string; avatar_url: string | null } => p != null && p.id !== player.id);
            const oppName = opponents[0]?.full_name ?? 'Awaiting';
            const statusLabel = labelForStatus(c.status);
            return (
              <Link
                key={cp_id}
                href={`/challenges/${c.id}`}
                style={{
                  background: '#222',
                  border: '1px solid #303030',
                  padding: 16,
                  marginBottom: 8,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  color: '#fff',
                  textDecoration: 'none',
                }}
              >
                <Avatar name={oppName} src={opponents[0]?.avatar_url} size={44} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{oppName}</div>
                  <div style={{ fontSize: 11, color: '#969696', marginTop: 2 }}>
                    {c.type} · {c.scheduled_at ? formatScheduled(c.scheduled_at) : formatRelative(c.created_at)}
                  </div>
                </div>
                <Pill
                  color={statusLabel.color}
                  bg={statusLabel.bg}
                  border={`1px solid ${statusLabel.border}`}
                >
                  {statusLabel.text}
                </Pill>
              </Link>
            );
          })}
        </section>
      )}

      {/* Suggested */}
      {suggested.length > 0 && (
        <section style={{ padding: '0 24px 24px' }}>
          <SectionLabel>Suggested · Close to your ELO</SectionLabel>
          <div
            className="scroll"
            style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 4 }}
          >
            {suggested.map((p) => (
              <div
                key={p.id}
                style={{
                  width: 160,
                  flexShrink: 0,
                  background: '#222',
                  border: '1px solid #303030',
                  padding: '20px 16px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <Avatar name={p.full_name} src={p.avatar_url} size={48} />
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 4,
                    minHeight: 40,
                    justifyContent: 'flex-start',
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.2, textAlign: 'center' }}>
                    {p.full_name}
                  </div>
                  <div
                    style={{
                      fontSize: 10,
                      color: '#969696',
                      letterSpacing: '0.65px',
                      textTransform: 'uppercase',
                      fontWeight: 600,
                      fontFamily: 'JetBrains Mono, monospace',
                    }}
                  >
                    ELO {p.singles_elo}
                  </div>
                </div>
                <SuggestedChallengeButton opponentId={p.id} />
              </div>
            ))}
          </div>
        </section>
      )}

      {incoming.length === 0 && sent.length === 0 && suggested.length === 0 && (
        <EmptyState
          title="No challenges yet"
          hint="Send a challenge to get on the leaderboard."
          icon={
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5" />
              <line x1="13" y1="19" x2="19" y2="13" />
              <line x1="16" y1="16" x2="20" y2="20" />
              <polyline points="14.5 6.5 18 3 21 3 21 6 17.5 9.5" />
              <line x1="5" y1="14" x2="9" y2="18" />
            </svg>
          }
        />
      )}
      </div>{/* /.m-only */}

      {/* DESKTOP VIEW */}
      <div className="d-only">
        <DPageHead
          eyebrow={`${incoming.length} incoming · ${sent.length} outgoing`}
          title="Challenges."
          meta="Issue a challenge, accept or decline incoming proposals. ELO swings are previewed before you commit."
        />

        {incoming.length > 0 && (
          <div className="d-ch-section">
            <h3>Incoming</h3>
            {incoming.map(({ challenge: c, cp_id }) => {
              if (!c) return null;
              return (
                <div key={cp_id} className="d-ch-card">
                  <div>
                    <div className="d-ch-card-name">{c.creator?.full_name ?? 'Unknown'}</div>
                    <div className="d-ch-card-meta">
                      {c.type} · {c.scheduled_at ? formatScheduled(c.scheduled_at) : formatRelative(c.created_at)}
                    </div>
                  </div>
                  <div className="d-ch-card-actions">
                    <InlineChallengeActions challengeId={c.id} />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {sent.length > 0 && (
          <div className="d-ch-section">
            <h3>Outgoing</h3>
            {sent.map(({ challenge: c, cp_id }) => {
              if (!c) return null;
              const opponents = c.challenge_participants
                .map((p) => p.player)
                .filter((p): p is { id: string; full_name: string; avatar_url: string | null } => p != null && p.id !== player.id);
              const oppNames = opponents.map((o) => o.full_name).join(' / ') || 'Awaiting';
              const statusLabel = labelForStatus(c.status);
              return (
                <div key={cp_id} className="d-ch-card">
                  <div>
                    <div className="d-ch-card-name">{oppNames}</div>
                    <div className="d-ch-card-meta">
                      {c.type} · {c.scheduled_at ? formatScheduled(c.scheduled_at) : formatRelative(c.created_at)}
                    </div>
                    <div className="d-ch-status">● {statusLabel.text}</div>
                  </div>
                  <div className="d-ch-card-actions">
                    <Link href={`/challenges/${c.id}`} className="d-btn d-btn-ghost">
                      View
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <DesktopChallengeForm myElo={myElo} suggested={suggested} />

        {incoming.length === 0 && sent.length === 0 && (
          <div className="d-ch-section">
            <h3>Suggested · Close to your ELO</h3>
            {suggested.length === 0 ? (
              <div className="d-empty">No suggestions available right now.</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
                {suggested.map((p) => (
                  <div key={p.id} className="d-ch-card" style={{ gridTemplateColumns: '1fr' }}>
                    <div>
                      <div className="d-ch-card-name" style={{ fontSize: 18 }}>
                        {p.full_name}
                      </div>
                      <div className="d-ch-card-meta">ELO {p.singles_elo}</div>
                    </div>
                    <div className="d-ch-card-actions">
                      <SuggestedChallengeButton opponentId={p.id} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function labelForStatus(status: string): { text: string; color: string; bg: string; border: string } {
  switch (status) {
    case 'proposed':
      return {
        text: 'Awaiting',
        color: '#f59e0b',
        bg: 'rgba(245,158,11,0.12)',
        border: 'rgba(245,158,11,0.35)',
      };
    case 'accepted':
    case 'partially_confirmed':
      return {
        text: 'Accepted',
        color: '#03904a',
        bg: 'rgba(3,144,74,0.12)',
        border: 'rgba(3,144,74,0.35)',
      };
    case 'completed':
    case 'walkover_confirmed':
      return {
        text: 'Done',
        color: '#969696',
        bg: 'rgba(255,255,255,0.05)',
        border: 'rgba(255,255,255,0.15)',
      };
    case 'disputed':
      return {
        text: 'Disputed',
        color: '#da291c',
        bg: 'rgba(218,41,28,0.12)',
        border: 'rgba(218,41,28,0.35)',
      };
    default:
      return {
        text: status,
        color: '#969696',
        bg: 'rgba(255,255,255,0.05)',
        border: 'rgba(255,255,255,0.15)',
      };
  }
}

