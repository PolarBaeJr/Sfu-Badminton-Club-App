import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { Badge, PageHero } from '@badminton/ui';
import { MATCH_FORMAT_LABELS, formatRelativeTime } from '@badminton/shared';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Swords, Plus, Zap, Clock, CheckCircle2, ChevronRight, Inbox } from 'lucide-react';
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/motion-wrapper';

export default async function ChallengesPage() {
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();

  const { data: myChallenges } = await supabase
    .from('challenge_participants')
    .select('*, challenge:challenges(*, creator:players!challenges_created_by_fkey(full_name), challenge_participants(*, player:players(full_name)))')
    .eq('player_id', player.id)
    .order('created_at', { ascending: false, referencedTable: 'challenges' })
    .limit(20);

  const incoming = myChallenges?.filter((cp) => {
    const c = cp.challenge as Record<string, unknown>;
    return c?.created_by !== player.id && cp.confirmation_status === 'pending';
  }) || [];

  const outgoing = myChallenges?.filter((cp) => {
    const c = cp.challenge as Record<string, unknown>;
    return c?.created_by === player.id;
  }) || [];

  const active = myChallenges?.filter((cp) => {
    const c = cp.challenge as Record<string, unknown>;
    return ['accepted', 'partially_confirmed'].includes(c?.status as string);
  }) || [];

  const completed = myChallenges?.filter((cp) => {
    const c = cp.challenge as Record<string, unknown>;
    return ['completed', 'walkover_confirmed'].includes(c?.status as string);
  }) || [];

  function ChallengeRow({ cp, isIncoming = false }: { cp: Record<string, unknown>; isIncoming?: boolean }) {
    const c = cp.challenge as Record<string, unknown>;
    if (!c) return null;
    const parts = (c.challenge_participants as Record<string, unknown>[]) || [];
    const creator = c.creator as Record<string, unknown>;

    const statusStyle: Record<string, string> = {
      proposed: 'bg-[var(--bg-accent)] text-[var(--accent)] border-[var(--accent-border)]',
      partially_confirmed: 'bg-[var(--bg-accent)] text-[var(--accent)] border-[var(--accent-border)]',
      accepted: 'bg-[var(--bg-accent)] text-[var(--accent)] border-[var(--accent-border)]',
      completed: 'bg-[var(--bg-card)] text-[var(--text-muted)] border-[var(--border)]',
      disputed: 'bg-[var(--bg-loss)] text-[var(--loss)] border-[var(--loss-border)]',
    };

    return (
      <StaggerItem>
        <Link href={`/challenges/${c.id}`} className="block group">
          <div
            className={`bg-[var(--bg-card)] hover:bg-[var(--bg-card-hover)] flex items-center justify-between py-[14px] px-[14px] transition-colors duration-150 border-[0.5px] ${
              isIncoming ? 'border-[var(--accent-border)]' : 'border-[var(--border)]'
            }`}
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 bg-[var(--bg-accent)] flex items-center justify-center shrink-0 border-[0.5px] border-[var(--accent-border)]">
                <Swords className="w-4 h-4 text-[var(--accent)]" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[13px] text-[var(--text-primary)] font-medium truncate">{creator?.full_name as string}</span>
                  <span className="text-[10px] tracking-[0.04em] uppercase text-[var(--text-muted)]">{c.type as string}</span>
                  {Boolean(c.rated_flag) && (
                    <span className="text-[10px] tracking-[0.04em] uppercase text-[var(--accent)]">Rated</span>
                  )}
                </div>
                <p className="text-[12px] text-[var(--text-muted)] mt-0.5">
                  {MATCH_FORMAT_LABELS[(c.format as string) as keyof typeof MATCH_FORMAT_LABELS]} &middot; {formatRelativeTime(c.created_at as string)}
                </p>
                <p className="text-[12px] text-[var(--text-faint)] mt-0.5 truncate">
                  {parts.map((p) => (p.player as Record<string, unknown>)?.full_name as string).join(' vs ')}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0 ml-3">
              <span className={`text-[10px] tracking-[0.04em] uppercase px-2 py-0.5 rounded-full border-[0.5px] ${statusStyle[c.status as string] || 'bg-[var(--bg-card)] text-[var(--text-muted)] border-[var(--border)]'}`}>
                {c.status as string}
              </span>
              <ChevronRight className="w-4 h-4 text-[var(--text-faint)] group-hover:text-[var(--accent)] transition-colors" />
            </div>
          </div>
        </Link>
      </StaggerItem>
    );
  }

  return (
    <div>
      <PageHero
        eyebrow={`${incoming.length} incoming · ${outgoing.length} outgoing`}
        title="Challenges."
        subtitle="Issue a challenge, accept or decline incoming proposals. ELO swings are previewed before you commit."
        watermark="C"
      />
      <div className="space-y-6 px-2 md:px-6 py-8">
      <FadeIn>
        <div className="flex justify-end">
          <Link
            href="/challenges/new"
            className="press inline-flex items-center gap-2 px-4 py-2 bg-[var(--red)] text-white text-[11px] font-bold uppercase tracking-[0.16em] hover:bg-[var(--red-dark)] transition-colors"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            <Plus className="w-4 h-4" />
            New
          </Link>
        </div>
      </FadeIn>

      {incoming.length > 0 && (
        <FadeIn delay={0.05}>
          <div>
            <div className="flex items-center gap-2 mb-3 px-1">
              <Zap className="w-4 h-4 text-[var(--accent)]" />
              <h2 className="text-[10px] tracking-[0.04em] uppercase text-[var(--text-muted)]">Incoming</h2>
              <span className="ml-auto text-[10px] tracking-[0.04em] uppercase text-[var(--accent)]">{incoming.length}</span>
            </div>
            <StaggerContainer className="space-y-2">
              {incoming.map((cp) => <ChallengeRow key={cp.id} cp={cp as Record<string, unknown>} isIncoming />)}
            </StaggerContainer>
          </div>
        </FadeIn>
      )}

      {active.length > 0 && (
        <FadeIn delay={0.1}>
          <div>
            <div className="flex items-center gap-2 mb-3 px-1">
              <Clock className="w-4 h-4 text-[var(--text-muted)]" />
              <h2 className="text-[10px] tracking-[0.04em] uppercase text-[var(--text-muted)]">Active</h2>
              <span className="ml-auto text-[10px] tracking-[0.04em] uppercase text-[var(--text-muted)]">{active.length}</span>
            </div>
            <StaggerContainer className="space-y-2">
              {active.map((cp) => <ChallengeRow key={cp.id} cp={cp as Record<string, unknown>} />)}
            </StaggerContainer>
          </div>
        </FadeIn>
      )}

      {outgoing.length > 0 && (
        <FadeIn delay={0.15}>
          <div>
            <div className="flex items-center gap-2 mb-3 px-1">
              <Swords className="w-4 h-4 text-[var(--text-muted)]" />
              <h2 className="text-[10px] tracking-[0.04em] uppercase text-[var(--text-muted)]">Sent</h2>
              <span className="ml-auto text-[10px] tracking-[0.04em] uppercase text-[var(--text-muted)]">{outgoing.length}</span>
            </div>
            <StaggerContainer className="space-y-2">
              {outgoing.map((cp) => <ChallengeRow key={cp.id} cp={cp as Record<string, unknown>} />)}
            </StaggerContainer>
          </div>
        </FadeIn>
      )}

      {completed.length > 0 && (
        <FadeIn delay={0.2}>
          <div>
            <div className="flex items-center gap-2 mb-3 px-1">
              <CheckCircle2 className="w-4 h-4 text-[var(--text-faint)]" />
              <h2 className="text-[10px] tracking-[0.04em] uppercase text-[var(--text-muted)]">Completed</h2>
            </div>
            <StaggerContainer className="space-y-2">
              {completed.map((cp) => <ChallengeRow key={cp.id} cp={cp as Record<string, unknown>} />)}
            </StaggerContainer>
          </div>
        </FadeIn>
      )}

      {(!myChallenges || myChallenges.length === 0) && (
        <FadeIn delay={0.05}>
          <div className="py-16 text-center">
            <Inbox className="w-10 h-10 text-[var(--text-faint)] mx-auto mb-3" />
            <p className="text-[13px] text-[var(--text-muted)] mb-4">No challenges yet</p>
            <Link
              href="/challenges/new"
              className="press inline-flex items-center gap-2 px-4 py-2 bg-[var(--bg-accent)] border-[0.5px] border-[var(--accent-border)] text-[var(--accent)] text-[13px] font-medium hover:border-[var(--accent)] transition-colors"
            >
              Create your first challenge
            </Link>
          </div>
        </FadeIn>
      )}
    </div>
    </div>
  );
}
