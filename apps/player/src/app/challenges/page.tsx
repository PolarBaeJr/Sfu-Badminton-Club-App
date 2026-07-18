import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import {
  MATCH_FORMAT_LABELS,
  formatRelativeTime,
  pickOne,
  CHALLENGE_STATUS_LABEL,
  CHALLENGE_STATUS_TAG,
} from '@badminton/shared';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Plus, ChevronRight, Inbox, Crosshair } from 'lucide-react';
import { PageHeader, AvatarChip } from '@badminton/ui';

export default async function ChallengesPage() {
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();

  const { data: myChallenges } = await supabase
    .from('challenge_participants')
    .select('id, confirmation_status, challenge:challenges(id, created_by, type, format, rated_flag, status, created_at, creator:players!challenges_created_by_fkey(id, full_name), challenge_participants(id, player_id, role, team_side, player:players(id, full_name)))')
    .eq('player_id', player.id)
    .order('created_at', { ascending: false, referencedTable: 'challenges' })
    .limit(20);

  type CP = NonNullable<typeof myChallenges>[number];
  type Challenge = {
    id: string;
    created_by: string;
    type: string;
    format: string;
    rated_flag: boolean;
    status: string;
    created_at: string;
    creator: { id: string; full_name: string } | { id: string; full_name: string }[] | null;
    challenge_participants: { id: string; player_id: string; role: string; team_side: string; player: { id: string; full_name: string } | { id: string; full_name: string }[] | null }[];
  };

  function pickChallenge(cp: CP): Challenge | null {
    const c = cp.challenge as unknown;
    if (!c) return null;
    return Array.isArray(c) ? (c[0] ?? null) : (c as Challenge);
  }
  const all = (myChallenges ?? []).map((cp) => ({ cp, c: pickChallenge(cp) })).filter((x): x is { cp: CP; c: Challenge } => Boolean(x.c));

  const incoming = all.filter(({ cp, c }) => c.created_by !== player.id && cp.confirmation_status === 'pending');
  const active   = all.filter(({ c }) => ['accepted', 'partially_confirmed'].includes(c.status));
  const outgoing = all.filter(({ c }) => c.created_by === player.id && !['completed', 'walkover_confirmed', 'rejected', 'cancelled'].includes(c.status));
  const completed = all.filter(({ c }) => ['completed', 'walkover_confirmed'].includes(c.status));
  const archived = all.filter(({ c }) => ['rejected', 'cancelled'].includes(c.status));

  function ChallengeCard({ c }: { c: Challenge }) {
    const creator = pickOne(c.creator);
    const isMine = c.created_by === player.id;
    const opponentParticipants = c.challenge_participants
      .map((p) => ({ ...p, person: pickOne(p.player) }))
      .filter((p) => p.person);
    const youSide = opponentParticipants.find((p) => p.person?.id === player.id)?.team_side;
    const opponents = opponentParticipants.filter((p) => p.team_side !== youSide);
    const teammates = opponentParticipants.filter((p) => p.team_side === youSide && p.person?.id !== player.id);

    return (
      <Link
        href={`/challenges/${c.id}`}
        className="press"
        style={{
          display: 'block',
          padding: 18,
          border: '1px solid var(--line)',
          borderRadius: 'var(--r-lg)',
          background: 'var(--surface)',
        }}
      >
        <div className="row" style={{ marginBottom: 12, fontSize: 12, flexWrap: 'wrap', gap: 8 }}>
          <span className="tag tag-red">{(c.type || '').toUpperCase()}</span>
          <span className="tag">{MATCH_FORMAT_LABELS[c.format as keyof typeof MATCH_FORMAT_LABELS] || c.format}</span>
          {c.rated_flag && <span className="tag tag-gold">RATED</span>}
          <span className="mono muted" style={{ marginLeft: 'auto' }}>
            {formatRelativeTime(c.created_at)}
          </span>
        </div>

        <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="row" style={{ gap: 10, flex: 1, minWidth: 200 }}>
            <AvatarChip name={creator?.full_name ?? '?'} id={creator?.id} size="md" />
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                {isMine ? 'You' : creator?.full_name ?? 'Unknown'} {isMine ? 'challenged' : 'challenged you'}
              </div>
              <div className="mono muted" style={{ fontSize: 11, marginTop: 2 }}>
                {opponents.length > 0
                  ? `vs ${opponents.map((o) => o.person?.full_name).filter(Boolean).join(' & ')}`
                  : 'Awaiting roster'}
                {teammates.length > 0 && ` · with ${teammates.map((t) => t.person?.full_name).filter(Boolean).join(', ')}`}
              </div>
            </div>
          </div>
          <span className={CHALLENGE_STATUS_TAG[c.status] ?? 'tag'}>{CHALLENGE_STATUS_LABEL[c.status] ?? c.status}</span>
          <ChevronRight size={16} className="text-[var(--mute)]" />
        </div>
      </Link>
    );
  }

  function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
    return (
      <div className="card-base">
        <div className="card-head">
          <h3 className="card-title">{title}</h3>
          {count !== undefined && <span className="tag">{count}</span>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{children}</div>
      </div>
    );
  }

  return (
    <div data-screen-label="Challenges">
      <PageHeader
        title="Challenges"
        sub="Issue, accept, and track challenges. Pending responses live at the top — answer them so the queue clears."
        actions={
          <Link href="/challenges/new" className="btn btn-primary">
            <Plus size={14} /> New challenge
          </Link>
        }
      />

      {all.length === 0 ? (
        <div className="card-base">
          <div className="empty">
            <Inbox size={40} className="text-[var(--mute)]" style={{ display: 'block', margin: '0 auto 12px' }} />
            <div style={{ marginBottom: 12 }}>No challenges yet.</div>
            <Link href="/challenges/new" className="btn btn-primary">
              <Plus size={14} /> Issue your first challenge
            </Link>
          </div>
        </div>
      ) : (
        <div className="feed-col">
          {incoming.length > 0 && (
            <Section title="Incoming" count={incoming.length}>
              {incoming.map(({ cp, c }) => <ChallengeCard key={cp.id} c={c} />)}
            </Section>
          )}
          {active.length > 0 && (
            <Section title="Active" count={active.length}>
              {active.map(({ cp, c }) => <ChallengeCard key={cp.id} c={c} />)}
            </Section>
          )}
          {outgoing.length > 0 && (
            <Section title="Your challenges" count={outgoing.length}>
              {outgoing.map(({ cp, c }) => <ChallengeCard key={cp.id} c={c} />)}
            </Section>
          )}
          {completed.length > 0 && (
            <Section title="Completed">
              {completed.map(({ cp, c }) => <ChallengeCard key={cp.id} c={c} />)}
            </Section>
          )}
          {archived.length > 0 && (
            <Section title="Archived">
              {archived.map(({ cp, c }) => <ChallengeCard key={cp.id} c={c} />)}
            </Section>
          )}
        </div>
      )}
    </div>
  );
}
