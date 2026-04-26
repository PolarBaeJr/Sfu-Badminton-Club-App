import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { MATCH_FORMAT_LABELS, formatRelativeTime } from '@badminton/shared';
import { notFound, redirect } from 'next/navigation';
import { ChallengeDetailActions } from './actions';
import { ArrowLeft, Clock, Zap, Trophy, MessageSquare, Crosshair } from 'lucide-react';
import Link from 'next/link';

const STATUS_TAG: Record<string, string> = {
  proposed: 'tag tag-gold',
  partially_confirmed: 'tag tag-gold',
  accepted: 'tag tag-win',
  completed: 'tag',
  disputed: 'tag tag-red',
  cancelled: 'tag',
  expired: 'tag',
  walkover_pending: 'tag tag-gold',
  walkover_confirmed: 'tag',
  rejected: 'tag',
};
const CONFIRM_TAG: Record<string, string> = {
  accepted: 'tag tag-win',
  rejected: 'tag tag-red',
  pending: 'tag tag-gold',
};

function initials(name: string | null | undefined) {
  return (name || '?').split(' ').map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}
function toneFor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return ((h % 7) + 1);
}

export default async function ChallengeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();

  const { data: challenge } = await supabase
    .from('challenges')
    .select('*, creator:players!challenges_created_by_fkey(full_name), challenge_participants(*, player:players(id, full_name, ratings(*)))')
    .eq('id', id)
    .single();

  if (!challenge) notFound();

  const { data: match } = await supabase
    .from('matches')
    .select('*, match_participants(*, player:players(full_name)), match_games(*)')
    .eq('challenge_id', id)
    .maybeSingle();

  type Participant = {
    id: string;
    player_id: string;
    team_side: string;
    confirmation_status: string;
    role: string;
    player: { id: string; full_name: string; ratings?: unknown } | { id: string; full_name: string; ratings?: unknown }[] | null;
  };

  const participants = (challenge.challenge_participants ?? []) as Participant[];
  const myParticipant = participants.find((cp) => cp.player_id === player.id);
  const sideA = participants.filter((cp) => cp.team_side === 'a');
  const sideB = participants.filter((cp) => cp.team_side === 'b');

  function pickPerson(p: Participant['player']) {
    if (!p) return null;
    return Array.isArray(p) ? (p[0] ?? null) : p;
  }

  return (
    <div data-screen-label="Challenge Detail" style={{ maxWidth: 720, margin: '0 auto' }}>
      <div className="page-header" style={{ marginBottom: 18 }}>
        <Link
          href="/challenges"
          className="row press"
          style={{ gap: 8, fontSize: 13, color: 'var(--mute)' }}
        >
          <ArrowLeft size={16} />
          Back to challenges
        </Link>
      </div>

      <div className="card-base" style={{ padding: 0, overflow: 'hidden' }}>
        <div
          className="card-head"
          style={{
            padding: '20px 22px 16px',
            borderBottom: '1px solid var(--line)',
            marginBottom: 0,
          }}
        >
          <div>
            <div className="page-eyebrow" style={{ marginBottom: 4 }}>
              <span className="bar" /> CHALLENGE
            </div>
            <h1
              style={{
                fontFamily: 'var(--display)',
                fontSize: 28,
                fontWeight: 700,
                letterSpacing: '-.02em',
                margin: 0,
              }}
            >
              {challenge.type === 'singles' ? 'Singles match' : 'Doubles match'}
            </h1>
          </div>
          <span className={STATUS_TAG[challenge.status] ?? 'tag'}>
            {challenge.status.replace(/_/g, ' ')}
          </span>
        </div>

        <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div className="grid grid-2">
            {[
              { icon: Crosshair, label: 'Type',    value: challenge.type as string },
              { icon: Trophy,    label: 'Format',  value: MATCH_FORMAT_LABELS[challenge.format as keyof typeof MATCH_FORMAT_LABELS] ?? (challenge.format as string) },
              { icon: Zap,       label: 'Rated',   value: challenge.rated_flag ? 'Rated' : 'Casual' },
              { icon: Clock,     label: 'Created', value: formatRelativeTime(challenge.created_at) },
            ].map((item) => (
              <div
                key={item.label}
                style={{
                  padding: 14,
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  background: 'var(--surface)',
                }}
              >
                <div className="row" style={{ gap: 6, marginBottom: 6 }}>
                  <item.icon size={12} className="text-[var(--mute)]" />
                  <span className="stat-label">{item.label}</span>
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', textTransform: 'capitalize' }}>
                  {item.value}
                </div>
              </div>
            ))}
          </div>

          {challenge.note && (
            <div
              className="row"
              style={{
                padding: 14,
                border: '1px solid var(--line)',
                borderRadius: 10,
                background: 'var(--surface-2)',
                gap: 10,
                alignItems: 'flex-start',
              }}
            >
              <MessageSquare size={16} className="text-[var(--mute)]" style={{ marginTop: 2, flexShrink: 0 }} />
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--ink-2)' }}>{challenge.note}</p>
            </div>
          )}

          <div className="grid grid-2">
            {[
              { label: 'Team A', players: sideA },
              { label: 'Team B', players: sideB },
            ].map((team) => (
              <div
                key={team.label}
                style={{
                  padding: 14,
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  background: 'var(--surface)',
                }}
              >
                <div className="stat-label" style={{ marginBottom: 10 }}>{team.label.toUpperCase()}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {team.players.length === 0 ? (
                    <div className="muted" style={{ fontSize: 12, fontStyle: 'italic' }}>No players yet.</div>
                  ) : (
                    team.players.map((cp) => {
                      const p = pickPerson(cp.player);
                      return (
                        <div key={cp.id} className="row" style={{ gap: 10 }}>
                          <span className="avatar" data-size="sm" data-tone={toneFor(p?.id ?? cp.id)}>
                            {initials(p?.full_name)}
                          </span>
                          <span style={{ flex: 1, fontSize: 13, fontWeight: 500, minWidth: 0 }} className="truncate">
                            {p?.full_name ?? 'Unknown'}
                          </span>
                          <span className={CONFIRM_TAG[cp.confirmation_status] ?? 'tag'}>
                            {cp.confirmation_status}
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            ))}
          </div>

          {match && (
            <div
              style={{
                padding: 18,
                border: '1px solid var(--line)',
                borderRadius: 12,
                background: 'var(--surface)',
              }}
            >
              <div className="card-head" style={{ marginBottom: 12 }}>
                <div className="row" style={{ gap: 8 }}>
                  <Trophy size={14} className="text-[var(--gold)]" />
                  <span className="stat-label">Match result</span>
                </div>
                <span className={'tag ' + (match.result_status === 'confirmed' ? 'tag-win' : match.result_status === 'disputed' ? 'tag-red' : 'tag-gold')}>
                  {match.result_status}
                </span>
              </div>
              <div className="mono" style={{ fontFamily: 'var(--display)', fontSize: 32, fontWeight: 700, letterSpacing: '-.02em' }}>
                {match.score_summary || 'Pending'}
              </div>
              {match.match_games && match.match_games.length > 0 && (
                <div className="mono muted" style={{ fontSize: 12, marginTop: 8, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  {match.match_games.map((g: Record<string, unknown>) => (
                    <span key={g.id as string}>
                      G{g.game_number as number} {g.side_a_score as number}–{g.side_b_score as number}
                    </span>
                  ))}
                </div>
              )}
              {match.match_participants && match.match_participants.length > 0 && (
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {match.match_participants.map((mp: Record<string, unknown>) => {
                    const p = mp.player as { full_name?: string } | { full_name?: string }[] | null;
                    const person = Array.isArray(p) ? p[0] : p;
                    const delta = mp.rating_delta as number | null;
                    return (
                      <div key={mp.id as string} className="row" style={{ gap: 10 }}>
                        <span style={{ flex: 1, fontSize: 13 }}>{person?.full_name ?? 'Unknown'}</span>
                        <span
                          className="mono"
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            color: typeof delta !== 'number' ? 'var(--mute)' : delta >= 0 ? 'var(--win)' : 'var(--loss)',
                          }}
                        >
                          {typeof delta === 'number' ? `${delta >= 0 ? '+' : ''}${delta}` : 'pending'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <ChallengeDetailActions
          challengeId={id}
          challengeStatus={challenge.status}
          matchId={match?.id}
          matchStatus={match?.result_status}
          myParticipantStatus={myParticipant?.confirmation_status}
          isCreator={challenge.created_by === player.id}
          format={challenge.format}
          participants={challenge.challenge_participants}
          playerId={player.id}
        />
      </div>
    </div>
  );
}
