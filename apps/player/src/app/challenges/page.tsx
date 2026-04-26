import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { Badge } from '@badminton/ui';
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

  function ChallengeRow({ cp }: { cp: Record<string, unknown> }) {
    const c = cp.challenge as Record<string, unknown>;
    if (!c) return null;
    const parts = (c.challenge_participants as Record<string, unknown>[]) || [];
    const creator = c.creator as Record<string, unknown>;

    const statusChip: Record<string, string> = {
      proposed: 'chip chip-gold',
      partially_confirmed: 'chip chip-gold',
      accepted: 'chip chip-success',
      completed: 'chip',
      disputed: 'chip chip-red',
    };

    return (
      <StaggerItem>
        <Link href={`/challenges/${c.id}`} className="block group">
          <div className="card-surface card-interactive flex items-center justify-between p-4">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 rounded-xl bg-[var(--ds-accent)]/10 flex items-center justify-center shrink-0">
                <Swords className="w-5 h-5 text-court-red" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-shuttle-white font-semibold truncate">{creator?.full_name as string}</span>
                  <span className="chip">{c.type as string}</span>
                  {Boolean(c.rated_flag) && <span className="chip chip-gold">Rated</span>}
                </div>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                  {MATCH_FORMAT_LABELS[(c.format as string) as keyof typeof MATCH_FORMAT_LABELS]} &middot; {formatRelativeTime(c.created_at as string)}
                </p>
                <p className="text-xs text-[var(--text-dim)] mt-0.5 truncate">
                  {parts.map((p) => (p.player as Record<string, unknown>)?.full_name as string).join(' vs ')}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0 ml-3">
              <span className={statusChip[c.status as string] || 'chip'}>
                {c.status as string}
              </span>
              <ChevronRight className="w-4 h-4 text-[var(--text-dim)] group-hover:text-court-red transition-colors" />
            </div>
          </div>
        </Link>
      </StaggerItem>
    );
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex items-center justify-between reveal reveal-1">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[var(--ds-accent)]/10 flex items-center justify-center">
              <Swords className="w-5 h-5 text-court-red" />
            </div>
            <div>
              <p className="eyebrow">My Challenges</p>
              <h1 className="display-lg text-shuttle-white">Challenges</h1>
            </div>
          </div>
          <Link
            href="/challenges/new"
            className="press flex items-center gap-2 px-4 py-2.5 rounded-xl gradient-court text-[#0A0A0A] font-bold text-sm glow-red hover:opacity-90 transition-opacity"
          >
            <Plus className="w-4 h-4" />
            New
          </Link>
        </div>
      </FadeIn>

      {incoming.length > 0 && (
        <FadeIn delay={0.05}>
          <div className="card-elevated p-4 border-[var(--color-gold)]/12">
            <div className="flex items-center gap-2 mb-3">
              <Zap className="w-4 h-4 text-gold" />
              <h2 className="eyebrow text-[var(--text-primary)]">Incoming</h2>
              <span className="ml-auto chip chip-gold">{incoming.length}</span>
            </div>
            <StaggerContainer className="space-y-2">
              {incoming.map((cp) => <ChallengeRow key={cp.id} cp={cp as Record<string, unknown>} />)}
            </StaggerContainer>
          </div>
        </FadeIn>
      )}

      {active.length > 0 && (
        <FadeIn delay={0.1}>
          <div className="card-elevated p-4">
            <div className="flex items-center gap-2 mb-3">
              <Clock className="w-4 h-4 text-blue-400" />
              <h2 className="eyebrow text-[var(--text-primary)]">Active</h2>
              <span className="ml-auto chip chip-success">{active.length}</span>
            </div>
            <StaggerContainer className="space-y-2">
              {active.map((cp) => <ChallengeRow key={cp.id} cp={cp as Record<string, unknown>} />)}
            </StaggerContainer>
          </div>
        </FadeIn>
      )}

      {outgoing.length > 0 && (
        <FadeIn delay={0.15}>
          <div className="card-elevated p-4">
            <div className="flex items-center gap-2 mb-3">
              <Swords className="w-4 h-4 text-court-red" />
              <h2 className="eyebrow text-[var(--text-primary)]">My Challenges</h2>
              <span className="ml-auto chip chip-red">{outgoing.length}</span>
            </div>
            <StaggerContainer className="space-y-2">
              {outgoing.map((cp) => <ChallengeRow key={cp.id} cp={cp as Record<string, unknown>} />)}
            </StaggerContainer>
          </div>
        </FadeIn>
      )}

      {completed.length > 0 && (
        <FadeIn delay={0.2}>
          <div className="card-elevated p-4">
            <div className="flex items-center gap-2 mb-3">
              <CheckCircle2 className="w-4 h-4 text-[var(--text-muted)]" />
              <h2 className="eyebrow text-[var(--text-primary)]">Completed</h2>
            </div>
            <StaggerContainer className="space-y-2">
              {completed.map((cp) => <ChallengeRow key={cp.id} cp={cp as Record<string, unknown>} />)}
            </StaggerContainer>
          </div>
        </FadeIn>
      )}

      {(!myChallenges || myChallenges.length === 0) && (
        <FadeIn delay={0.05}>
          <div className="card-elevated p-12 text-center">
            <Inbox className="w-12 h-12 text-[var(--text-dim)] mx-auto mb-3" />
            <p className="text-[var(--text-muted)] mb-3 font-medium">No challenges yet</p>
            <Link href="/challenges/new" className="press chip chip-red">
              Create your first challenge
            </Link>
          </div>
        </FadeIn>
      )}
    </div>
  );
}
