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

    const statusStyles: Record<string, string> = {
      proposed: 'bg-[#FFD700]/10 text-[#FFD700]',
      partially_confirmed: 'bg-[#FFD700]/10 text-[#FFD700]',
      accepted: 'bg-blue-500/10 text-blue-400',
      completed: 'bg-[#EF4444]/10 text-[#EF4444]',
      disputed: 'bg-[#EF4444]/10 text-[#EF4444]',
    };

    return (
      <StaggerItem>
        <Link href={`/challenges/${c.id}`} className="block group">
          <div className="flex items-center justify-between p-4 bg-white/[0.03] rounded-xl border border-white/[0.04] hover:border-[#EF4444]/20 hover:bg-white/[0.05] transition-all duration-200">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 rounded-xl bg-[#EF4444]/10 flex items-center justify-center shrink-0">
                <Swords className="w-5 h-5 text-[#EF4444]" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-shuttle-white font-semibold truncate">{creator?.full_name as string}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.06] text-[#64748B] font-medium">{c.type as string}</span>
                  {Boolean(c.rated_flag) && <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#FFD700]/10 text-[#FFD700] font-medium">Rated</span>}
                </div>
                <p className="text-xs text-[#64748B] mt-0.5">
                  {MATCH_FORMAT_LABELS[(c.format as string) as keyof typeof MATCH_FORMAT_LABELS]} &middot; {formatRelativeTime(c.created_at as string)}
                </p>
                <p className="text-xs text-[#475569] mt-0.5 truncate">
                  {parts.map((p) => (p.player as Record<string, unknown>)?.full_name as string).join(' vs ')}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0 ml-3">
              <span className={`text-[10px] px-2 py-1 rounded-full font-semibold ${statusStyles[c.status as string] || 'bg-white/[0.06] text-[#64748B]'}`}>
                {c.status as string}
              </span>
              <ChevronRight className="w-4 h-4 text-[#475569] group-hover:text-[#EF4444] transition-colors" />
            </div>
          </div>
        </Link>
      </StaggerItem>
    );
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#EF4444]/10 flex items-center justify-center">
              <Swords className="w-5 h-5 text-[#EF4444]" />
            </div>
            <h1 className="text-3xl font-black font-display text-shuttle-white tracking-wider uppercase">Challenges</h1>
          </div>
          <Link
            href="/challenges/new"
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-[#EF4444] to-[#DC2626] text-white font-bold text-sm shadow-lg shadow-[#EF4444]/20 hover:shadow-[#EF4444]/30 hover:from-[#DC2626] hover:to-[#B91C1C] transition-all duration-300"
          >
            <Plus className="w-4 h-4" />
            New Challenge
          </Link>
        </div>
      </FadeIn>

      {incoming.length > 0 && (
        <FadeIn delay={0.05}>
          <div className="bg-[#161B2E] border border-[#FFD700]/10 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <Zap className="w-4 h-4 text-[#FFD700]" />
              <h2 className="text-sm font-bold text-shuttle-white uppercase tracking-wider font-display">
                Incoming
              </h2>
              <span className="ml-auto bg-[#FFD700]/10 text-[#FFD700] text-xs font-bold px-2 py-0.5 rounded-full">{incoming.length}</span>
            </div>
            <StaggerContainer className="space-y-2">
              {incoming.map((cp) => <ChallengeRow key={cp.id} cp={cp as Record<string, unknown>} />)}
            </StaggerContainer>
          </div>
        </FadeIn>
      )}

      {active.length > 0 && (
        <FadeIn delay={0.1}>
          <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <Clock className="w-4 h-4 text-blue-400" />
              <h2 className="text-sm font-bold text-shuttle-white uppercase tracking-wider font-display">
                Active
              </h2>
              <span className="ml-auto bg-blue-500/10 text-blue-400 text-xs font-bold px-2 py-0.5 rounded-full">{active.length}</span>
            </div>
            <StaggerContainer className="space-y-2">
              {active.map((cp) => <ChallengeRow key={cp.id} cp={cp as Record<string, unknown>} />)}
            </StaggerContainer>
          </div>
        </FadeIn>
      )}

      {outgoing.length > 0 && (
        <FadeIn delay={0.15}>
          <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <Swords className="w-4 h-4 text-[#EF4444]" />
              <h2 className="text-sm font-bold text-shuttle-white uppercase tracking-wider font-display">
                My Challenges
              </h2>
              <span className="ml-auto bg-[#EF4444]/10 text-[#EF4444] text-xs font-bold px-2 py-0.5 rounded-full">{outgoing.length}</span>
            </div>
            <StaggerContainer className="space-y-2">
              {outgoing.map((cp) => <ChallengeRow key={cp.id} cp={cp as Record<string, unknown>} />)}
            </StaggerContainer>
          </div>
        </FadeIn>
      )}

      {completed.length > 0 && (
        <FadeIn delay={0.2}>
          <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <CheckCircle2 className="w-4 h-4 text-[#64748B]" />
              <h2 className="text-sm font-bold text-shuttle-white uppercase tracking-wider font-display">
                Completed
              </h2>
            </div>
            <StaggerContainer className="space-y-2">
              {completed.map((cp) => <ChallengeRow key={cp.id} cp={cp as Record<string, unknown>} />)}
            </StaggerContainer>
          </div>
        </FadeIn>
      )}

      {(!myChallenges || myChallenges.length === 0) && (
        <FadeIn delay={0.05}>
          <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-12 text-center">
            <Inbox className="w-12 h-12 text-[#1E293B] mx-auto mb-3" />
            <p className="text-[#64748B] mb-2">No challenges yet</p>
            <Link href="/challenges/new" className="text-[#EF4444] text-sm font-semibold hover:text-[#F87171] transition-colors">
              Create your first challenge
            </Link>
          </div>
        </FadeIn>
      )}
    </div>
  );
}
