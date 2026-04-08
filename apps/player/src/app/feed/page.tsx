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
            <p className="eyebrow mb-1">Dashboard</p>
            <h1 className="display-lg text-shuttle-white">
              Hey, {player.full_name.split(' ')[0]}!
            </h1>
            <p className="text-[#64748B] text-sm mt-1">Here&apos;s what&apos;s happening</p>
          </div>
          {unreadNotifs && unreadNotifs > 0 ? (
            <Link
              href="/notifications"
              className="chip chip-red press"
            >
              <Flame className="w-3 h-3" />
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
            <div className="card-surface card-interactive p-4 group reveal reveal-1">
              <p className="eyebrow mb-2">Singles ELO</p>
              <p className="display-md gradient-text-red nums">{r.singles_elo}</p>
              <p className="text-xs text-[#64748B] mt-1.5">
                {r.singles_provisional ? (
                  <span className="chip chip-gold">Provisional</span>
                ) : (
                  <>Win rate: {singlesWinRate}</>
                )}
              </p>
            </div>

            {/* Doubles Elo */}
            <div className="card-surface card-interactive p-4 group reveal reveal-2">
              <p className="eyebrow mb-2">Doubles ELO</p>
              <p className="display-md gradient-text-gold nums">{r.doubles_elo}</p>
              <p className="text-xs text-[#64748B] mt-1.5">
                {r.doubles_provisional ? (
                  <span className="chip chip-gold">Provisional</span>
                ) : (
                  <>Win rate: {doublesWinRate}</>
                )}
              </p>
            </div>

            {/* Singles Record */}
            <div className="card-surface p-4 reveal reveal-3">
              <p className="eyebrow mb-2">Singles W/L</p>
              <p className="display-md text-shuttle-white nums">
                <span className="text-emerald-400">{r.singles_wins ?? 0}</span>
                <span className="text-[#475569] font-normal mx-1">/</span>
                <span className="text-[#EF4444]">{r.singles_losses ?? 0}</span>
              </p>
            </div>

            {/* Doubles Record */}
            <div className="card-surface p-4 reveal reveal-4">
              <p className="eyebrow mb-2">Doubles W/L</p>
              <p className="display-md text-shuttle-white nums">
                <span className="text-emerald-400">{r.doubles_wins ?? 0}</span>
                <span className="text-[#475569] font-normal mx-1">/</span>
                <span className="text-[#EF4444]">{r.doubles_losses ?? 0}</span>
              </p>
            </div>
          </div>
        </FadeIn>
      )}

      {/* Pending Challenges */}
      {pendingChallenges && pendingChallenges.length > 0 && (
        <FadeIn delay={0.1}>
          <div className="card-elevated p-4" style={{ borderColor: 'rgba(252,211,77,0.12)' }}>
            <div className="flex items-center gap-2 mb-3">
              <Zap className="w-4 h-4 text-gold" />
              <h2 className="eyebrow" style={{ color: 'var(--text-primary)' }}>
                Pending Challenges
              </h2>
              <span className="ml-auto chip chip-gold">{pendingChallenges.length}</span>
            </div>
            <StaggerContainer className="space-y-2">
              {pendingChallenges.map((pc) => {
                const c = pc.challenge as Record<string, unknown>;
                if (!c) return null;
                const creator = c.creator as Record<string, unknown>;
                return (
                  <StaggerItem key={pc.id}>
                    <Link href={`/challenges/${c.id}`} className="block group">
                      <div className="card-surface card-interactive flex items-center justify-between p-3">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-full bg-[#FFD700]/10 flex items-center justify-center shrink-0">
                            <Swords className="w-4 h-4 text-gold" />
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-shuttle-white">
                              {creator?.full_name as string} challenged you
                            </p>
                            <p className="text-xs text-[#64748B] mt-0.5">
                              {c.type as string} &middot; {MATCH_FORMAT_LABELS[(c.format as string) as keyof typeof MATCH_FORMAT_LABELS]}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="chip chip-gold">Respond</span>
                          <ChevronRight className="w-4 h-4 text-[#64748B] group-hover:text-gold transition-colors" />
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
        <div className="card-elevated p-4 w-full">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Trophy className="w-4 h-4 text-gold" />
              <h2 className="eyebrow" style={{ color: 'var(--text-primary)' }}>Recent Matches</h2>
            </div>
            <Link href="/my-stats" className="text-xs text-court-red hover:text-[#F87171] font-semibold transition-colors">
              All stats →
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
                      <span className="text-sm font-mono text-shuttle-white font-medium nums">
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
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Trophy className="w-8 h-8 text-[#1E293B] mb-2" />
              <p className="text-sm text-[#64748B]">No matches yet</p>
            </div>
          )}
        </div>
      </FadeIn>

      {/* Quick Actions */}
      <FadeIn delay={0.25}>
        <div className="flex gap-3">
          <Link href="/challenges/new" className="flex-1 press">
            <button className="w-full h-12 rounded-xl gradient-court text-white font-bold text-sm tracking-wide flex items-center justify-center gap-2 glow-red hover:opacity-90 transition-opacity">
              <Swords className="w-4 h-4" />
              Create Challenge
            </button>
          </Link>
          <Link href="/leaderboard" className="flex-1 press">
            <button className="w-full h-12 rounded-xl bg-white/[0.04] border border-white/[0.08] text-shuttle-white font-bold text-sm tracking-wide flex items-center justify-center gap-2 hover:bg-white/[0.08] hover:border-white/[0.12] transition-all duration-300">
              <Trophy className="w-4 h-4 text-gold" />
              Leaderboard
            </button>
          </Link>
        </div>
      </FadeIn>
    </div>
  );
}
