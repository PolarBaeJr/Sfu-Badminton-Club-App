import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { Badge } from '@badminton/ui';
import { MATCH_FORMAT_LABELS, formatRelativeTime, getWinRate } from '@badminton/shared';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  Swords,
  TrendingUp,
  TrendingDown,
  ChevronRight,
  Zap,
  Trophy,
  Target,
  Flame,
} from 'lucide-react';
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/motion-wrapper';

export default async function FeedPage() {
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();
  const r = Array.isArray(player.ratings) ? player.ratings[0] : player.ratings;

  const [
    { data: pendingChallenges },
    { data: recentMatches },
    { count: unreadNotifs },
  ] = await Promise.all([
    supabase
      .from('challenge_participants')
      .select('*, challenge:challenges(*, creator:players!challenges_created_by_fkey(full_name))')
      .eq('player_id', player.id)
      .eq('confirmation_status', 'pending')
      .limit(5),
    supabase
      .from('match_participants')
      .select('*, match:matches(score_summary, played_at, match_type, result_status)')
      .eq('player_id', player.id)
      .order('created_at', { ascending: false, referencedTable: 'matches' })
      .limit(5),
    supabase.from('notifications').select('*', { count: 'exact', head: true }).eq('player_id', player.id).eq('read_flag', false),
  ]);

  const singlesWinRate = r ? getWinRate(r.singles_wins, r.singles_losses) : '0%';
  const doublesWinRate = r ? getWinRate(r.doubles_wins, r.doubles_losses) : '0%';

  return (
    <div className="space-y-6">
      {/* Greeting */}
      <FadeIn>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-black text-shuttle-white font-display tracking-wide">
              Hey, {player.full_name.split(' ')[0]}!
            </h1>
            <p className="text-[#64748B] text-sm mt-0.5">Here&apos;s what&apos;s happening</p>
          </div>
          {unreadNotifs && unreadNotifs > 0 ? (
            <Link
              href="/notifications"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#EF4444]/10 text-[#EF4444] text-xs font-semibold hover:bg-[#EF4444]/15 transition-colors"
            >
              <Flame className="w-3.5 h-3.5" />
              {unreadNotifs} new
            </Link>
          ) : null}
        </div>
      </FadeIn>

      {/* Elo Stats */}
      {r && (
        <FadeIn delay={0.05}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {/* Singles Elo */}
            <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-4 group hover:border-[#EF4444]/20 transition-all duration-300">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-7 h-7 rounded-lg bg-[#EF4444]/10 flex items-center justify-center">
                  <Target className="w-3.5 h-3.5 text-[#EF4444]" />
                </div>
                <span className="text-xs text-[#64748B] font-medium">Singles</span>
              </div>
              <p className="text-2xl font-black text-shuttle-white font-display">{r.singles_elo}</p>
              <p className="text-xs text-[#64748B] mt-1">
                {r.singles_provisional ? (
                  <span className="text-[#FFD700]">Provisional</span>
                ) : (
                  <>Win rate: {singlesWinRate}</>
                )}
              </p>
            </div>

            {/* Doubles Elo */}
            <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-4 group hover:border-[#FFD700]/20 transition-all duration-300">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-7 h-7 rounded-lg bg-[#FFD700]/10 flex items-center justify-center">
                  <Swords className="w-3.5 h-3.5 text-[#FFD700]" />
                </div>
                <span className="text-xs text-[#64748B] font-medium">Doubles</span>
              </div>
              <p className="text-2xl font-black text-shuttle-white font-display">{r.doubles_elo}</p>
              <p className="text-xs text-[#64748B] mt-1">
                {r.doubles_provisional ? (
                  <span className="text-[#FFD700]">Provisional</span>
                ) : (
                  <>Win rate: {doublesWinRate}</>
                )}
              </p>
            </div>

            {/* Singles Record */}
            <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-7 h-7 rounded-lg bg-[#EF4444]/10 flex items-center justify-center">
                  <TrendingUp className="w-3.5 h-3.5 text-[#EF4444]" />
                </div>
                <span className="text-xs text-[#64748B] font-medium">Singles W/L</span>
              </div>
              <p className="text-2xl font-black text-shuttle-white font-display">
                {r.singles_wins ?? 0}
                <span className="text-[#64748B] font-normal text-lg mx-1">/</span>
                {r.singles_losses ?? 0}
              </p>
            </div>

            {/* Doubles Record */}
            <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-7 h-7 rounded-lg bg-[#FFD700]/10 flex items-center justify-center">
                  <TrendingDown className="w-3.5 h-3.5 text-[#FFD700]" />
                </div>
                <span className="text-xs text-[#64748B] font-medium">Doubles W/L</span>
              </div>
              <p className="text-2xl font-black text-shuttle-white font-display">
                {r.doubles_wins ?? 0}
                <span className="text-[#64748B] font-normal text-lg mx-1">/</span>
                {r.doubles_losses ?? 0}
              </p>
            </div>
          </div>
        </FadeIn>
      )}

      {/* Pending Challenges */}
      {pendingChallenges && pendingChallenges.length > 0 && (
        <FadeIn delay={0.1}>
          <div className="bg-[#161B2E] border border-[#FFD700]/10 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <Zap className="w-4 h-4 text-[#FFD700]" />
              <h2 className="text-sm font-bold text-shuttle-white uppercase tracking-wider font-display">
                Pending Challenges
              </h2>
              <span className="ml-auto bg-[#FFD700]/10 text-[#FFD700] text-xs font-bold px-2 py-0.5 rounded-full">
                {pendingChallenges.length}
              </span>
            </div>
            <StaggerContainer className="space-y-2">
              {pendingChallenges.map((pc) => {
                const c = pc.challenge as Record<string, unknown>;
                if (!c) return null;
                const creator = c.creator as Record<string, unknown>;
                return (
                  <StaggerItem key={pc.id}>
                    <Link href={`/challenges/${c.id}`} className="block group">
                      <div className="flex items-center justify-between p-3 bg-white/[0.03] rounded-lg border border-white/[0.04] hover:border-[#FFD700]/20 hover:bg-white/[0.05] transition-all duration-200">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-full bg-[#FFD700]/10 flex items-center justify-center">
                            <Swords className="w-4 h-4 text-[#FFD700]" />
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-shuttle-white">
                              {creator?.full_name as string} challenged you
                            </p>
                            <p className="text-xs text-[#64748B]">
                              {c.type as string} &middot; {MATCH_FORMAT_LABELS[(c.format as string) as keyof typeof MATCH_FORMAT_LABELS]}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="warning">Respond</Badge>
                          <ChevronRight className="w-4 h-4 text-[#64748B] group-hover:text-[#FFD700] transition-colors" />
                        </div>
                      </div>
                    </Link>
                  </StaggerItem>
                );
              })}
            </StaggerContainer>
          </div>
        </FadeIn>
      )}

      {/* Recent Matches */}
      <FadeIn delay={0.2}>
        <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-4 w-full">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Trophy className="w-4 h-4 text-[#FFD700]" />
              <h2 className="text-sm font-bold text-shuttle-white uppercase tracking-wider font-display">
                Recent Matches
              </h2>
            </div>
            <Link href="/my-stats" className="text-xs text-[#EF4444] hover:text-[#F87171] font-medium transition-colors">
              All stats
            </Link>
          </div>
          {recentMatches && recentMatches.length > 0 ? (
            <div className="space-y-2">
              {recentMatches.map((mp) => {
                const m = mp.match as Record<string, unknown> | null;
                if (!m) return null;
                const isWin = mp.win_flag === true;
                const isLoss = mp.win_flag === false;
                return (
                  <div
                    key={mp.id}
                    className="flex items-center justify-between p-3 bg-white/[0.03] rounded-lg border border-white/[0.04]"
                  >
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-black ${
                        isWin
                          ? 'bg-emerald-500/15 text-emerald-400'
                          : isLoss
                            ? 'bg-[#EF4444]/15 text-[#EF4444]'
                            : 'bg-white/[0.06] text-[#64748B]'
                      }`}>
                        {isWin ? 'W' : isLoss ? 'L' : '?'}
                      </div>
                      <span className="text-sm font-mono text-shuttle-white font-medium">
                        {m.score_summary as string || '-'}
                      </span>
                    </div>
                    <span className="text-xs text-[#475569]">
                      {m.played_at ? formatRelativeTime(m.played_at as string) : ''}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-6 text-center">
              <Trophy className="w-8 h-8 text-[#1E293B] mb-2" />
              <p className="text-sm text-[#64748B]">No matches yet</p>
            </div>
          )}
        </div>
      </FadeIn>

      {/* Quick Actions */}
      <FadeIn delay={0.25}>
        <div className="flex gap-3">
          <Link href="/challenges/new" className="flex-1">
            <button className="w-full h-12 rounded-xl bg-gradient-to-r from-[#EF4444] to-[#DC2626] text-white font-bold text-sm tracking-wide flex items-center justify-center gap-2 shadow-lg shadow-[#EF4444]/20 hover:shadow-[#EF4444]/30 hover:from-[#DC2626] hover:to-[#B91C1C] transition-all duration-300">
              <Swords className="w-4 h-4" />
              Create Challenge
            </button>
          </Link>
          <Link href="/leaderboard" className="flex-1">
            <button className="w-full h-12 rounded-xl bg-white/[0.04] border border-white/[0.08] text-shuttle-white font-bold text-sm tracking-wide flex items-center justify-center gap-2 hover:bg-white/[0.08] hover:border-white/[0.12] transition-all duration-300">
              <Trophy className="w-4 h-4 text-[#FFD700]" />
              Leaderboard
            </button>
          </Link>
        </div>
      </FadeIn>
    </div>
  );
}
