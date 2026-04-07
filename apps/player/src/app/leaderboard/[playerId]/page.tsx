import { createServerSupabaseClient } from '@/lib/supabase-server';
import { Badge, Avatar } from '@badminton/ui';
import { PLAYER_STATUS_LABELS, getWinRate, getStreakDisplay, getPointDifferential, formatDate, getSeasonTier } from '@badminton/shared';
import { notFound } from 'next/navigation';
import {
  Target,
  Swords,
  TrendingUp,
  Flame,
  BarChart3,
  Trophy,
  Users,
  ArrowLeft,
} from 'lucide-react';
import Link from 'next/link';
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/motion-wrapper';

export default async function PlayerProfilePage({ params }: { params: Promise<{ playerId: string }> }) {
  const { playerId } = await params;
  const supabase = await createServerSupabaseClient();

  const [
    { data: player },
    { data: rating },
    { data: recentMatches },
    { data: h2hStats },
  ] = await Promise.all([
    supabase.from('players').select('*').eq('id', playerId).single(),
    supabase.from('ratings').select('*').eq('player_id', playerId).single(),
    supabase.from('match_participants')
      .select('*, match:matches(score_summary, played_at, match_type, format, result_status, winner_side)')
      .eq('player_id', playerId)
      .order('created_at', { ascending: false, referencedTable: 'matches' })
      .limit(10),
    supabase.from('head_to_head_stats')
      .select('*')
      .or(`player_a_id.eq.${playerId},player_b_id.eq.${playerId}`)
      .order('total_matches', { ascending: false })
      .limit(5),
  ]);

  if (!player) notFound();
  const r = rating;

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link href="/leaderboard" className="inline-flex items-center gap-1.5 text-sm text-[#64748B] hover:text-[#94A3B8] transition-colors">
        <ArrowLeft className="w-4 h-4" />
        Back to Leaderboard
      </Link>

      {/* Player Header */}
      <FadeIn>
        <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-6">
          <div className="flex items-center gap-4">
            <Avatar name={player.full_name} size="lg" />
            <div className="flex-1">
              <h1 className="text-2xl font-black text-shuttle-white font-display tracking-wide">{player.full_name}</h1>
              <div className="flex gap-2 mt-2">
                <Badge variant={player.status === 'competitive' ? 'success' : 'default'}>
                  {PLAYER_STATUS_LABELS[player.status as keyof typeof PLAYER_STATUS_LABELS]}
                </Badge>
                {r && (() => {
                  const t = getSeasonTier(r.singles_elo);
                  return (
                    <span
                      className="text-xs font-bold px-2 py-0.5 rounded-full"
                      style={{ backgroundColor: `${t.color}20`, color: t.color }}
                    >
                      {t.tier}
                    </span>
                  );
                })()}
              </div>
            </div>
            <Link
              href={`/challenges/new?opponent=${playerId}`}
              className="ml-auto px-4 py-2 bg-[#EF4444]/15 text-[#EF4444] text-sm font-bold rounded-xl border border-[#EF4444]/20 hover:bg-[#EF4444]/25 transition-colors flex items-center gap-2"
            >
              <Swords className="w-4 h-4" />
              Challenge
            </Link>
          </div>
        </div>
      </FadeIn>

      {r && (
        <>
          {/* Main Stats */}
          <FadeIn delay={0.05}>
            <StaggerContainer className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StaggerItem>
                <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-7 h-7 rounded-lg bg-[#EF4444]/10 flex items-center justify-center">
                      <Target className="w-3.5 h-3.5 text-[#EF4444]" />
                    </div>
                    <span className="text-xs text-[#64748B] font-medium">Singles Elo</span>
                  </div>
                  <p className="text-2xl font-black text-shuttle-white font-display">{r.singles_elo}</p>
                  <p className="text-xs text-[#64748B] mt-1">{r.singles_provisional ? <span className="text-[#FFD700]">Provisional</span> : 'Established'}</p>
                </div>
              </StaggerItem>
              <StaggerItem>
                <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-7 h-7 rounded-lg bg-[#FFD700]/10 flex items-center justify-center">
                      <Swords className="w-3.5 h-3.5 text-[#FFD700]" />
                    </div>
                    <span className="text-xs text-[#64748B] font-medium">Doubles Elo</span>
                  </div>
                  <p className="text-2xl font-black text-shuttle-white font-display">{r.doubles_elo}</p>
                  <p className="text-xs text-[#64748B] mt-1">{r.doubles_provisional ? <span className="text-[#FFD700]">Provisional</span> : 'Established'}</p>
                </div>
              </StaggerItem>
              <StaggerItem>
                <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-7 h-7 rounded-lg bg-[#EF4444]/10 flex items-center justify-center">
                      <TrendingUp className="w-3.5 h-3.5 text-[#EF4444]" />
                    </div>
                    <span className="text-xs text-[#64748B] font-medium">Singles W/L</span>
                  </div>
                  <p className="text-2xl font-black text-shuttle-white font-display">{r.singles_wins}-{r.singles_losses}</p>
                  <p className="text-xs text-[#64748B] mt-1">{getWinRate(r.singles_wins, r.singles_losses)}</p>
                </div>
              </StaggerItem>
              <StaggerItem>
                <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-7 h-7 rounded-lg bg-[#FFD700]/10 flex items-center justify-center">
                      <Users className="w-3.5 h-3.5 text-[#FFD700]" />
                    </div>
                    <span className="text-xs text-[#64748B] font-medium">Doubles W/L</span>
                  </div>
                  <p className="text-2xl font-black text-shuttle-white font-display">{r.doubles_wins}-{r.doubles_losses}</p>
                  <p className="text-xs text-[#64748B] mt-1">{getWinRate(r.doubles_wins, r.doubles_losses)}</p>
                </div>
              </StaggerItem>
            </StaggerContainer>
          </FadeIn>

          {/* Extended Stats */}
          <FadeIn delay={0.1}>
            <StaggerContainer className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { icon: Flame, color: '#EF4444', label: 'S. Streak', value: getStreakDisplay(r.current_singles_streak) },
                { icon: Flame, color: '#F59E0B', label: 'D. Streak', value: getStreakDisplay(r.current_doubles_streak) },
                { icon: BarChart3, color: '#EF4444', label: 'S. Point +/-', value: getPointDifferential(r.singles_points_scored, r.singles_points_allowed) },
                { icon: BarChart3, color: '#FFD700', label: 'D. Point +/-', value: getPointDifferential(r.doubles_points_scored, r.doubles_points_allowed) },
              ].map((stat) => (
                <StaggerItem key={stat.label}>
                  <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <stat.icon className="w-3.5 h-3.5" style={{ color: stat.color }} />
                      <span className="text-xs text-[#64748B] font-medium">{stat.label}</span>
                    </div>
                    <p className="text-xl font-bold text-shuttle-white font-display">{stat.value}</p>
                  </div>
                </StaggerItem>
              ))}
            </StaggerContainer>
          </FadeIn>
        </>
      )}

      {/* Recent Matches */}
      <FadeIn delay={0.15}>
        <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-4">
          <div className="flex items-center gap-2 mb-4">
            <Trophy className="w-4 h-4 text-[#FFD700]" />
            <h2 className="text-sm font-bold text-shuttle-white uppercase tracking-wider font-display">Recent Matches</h2>
          </div>
          <div className="space-y-2">
            {recentMatches?.map((mp) => {
              const m = mp.match as Record<string, unknown> | null;
              if (!m) return null;
              const isWin = mp.win_flag === true;
              const isLoss = mp.win_flag === false;
              return (
                <div key={mp.id} className="flex items-center justify-between p-3 bg-white/[0.03] rounded-lg border border-white/[0.04]">
                  <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-black ${
                      isWin ? 'bg-emerald-500/15 text-emerald-400' : isLoss ? 'bg-[#EF4444]/15 text-[#EF4444]' : 'bg-white/[0.06] text-[#64748B]'
                    }`}>
                      {isWin ? 'W' : isLoss ? 'L' : '?'}
                    </div>
                    <span className="text-sm font-mono text-shuttle-white font-medium">{m.score_summary as string || '-'}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.06] text-[#64748B] font-medium">{m.match_type as string}</span>
                  </div>
                  <div className="text-right flex items-center gap-3">
                    <span className={`font-mono text-sm font-bold ${(mp.rating_delta ?? 0) >= 0 ? 'text-emerald-400' : 'text-[#EF4444]'}`}>
                      {mp.rating_delta !== null ? `${(mp.rating_delta ?? 0) >= 0 ? '+' : ''}${mp.rating_delta}` : ''}
                    </span>
                    <span className="text-xs text-[#475569]">{m.played_at ? formatDate(m.played_at as string) : ''}</span>
                  </div>
                </div>
              );
            })}
            {(!recentMatches || recentMatches.length === 0) && (
              <div className="text-center py-8">
                <Trophy className="w-8 h-8 text-[#1E293B] mx-auto mb-2" />
                <p className="text-[#64748B] text-sm">No matches</p>
              </div>
            )}
          </div>
        </div>
      </FadeIn>

      {/* Head to Head */}
      {h2hStats && h2hStats.length > 0 && (
        <FadeIn delay={0.2}>
          <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-4">
            <div className="flex items-center gap-2 mb-4">
              <Swords className="w-4 h-4 text-[#EF4444]" />
              <h2 className="text-sm font-bold text-shuttle-white uppercase tracking-wider font-display">Head to Head</h2>
            </div>
            <div className="space-y-2">
              {h2hStats.map((h) => {
                const isA = h.player_a_id === playerId;
                const wins = isA ? h.player_a_wins : h.player_b_wins;
                const losses = isA ? h.player_b_wins : h.player_a_wins;
                return (
                  <div key={h.id} className="flex items-center justify-between p-3 bg-white/[0.03] rounded-lg border border-white/[0.04]">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-[#94A3B8]">{h.match_type}</span>
                      <span className="text-xs text-[#475569]">&middot; {h.total_matches} matches</span>
                    </div>
                    <span className="font-mono text-sm font-bold">
                      <span className="text-emerald-400">{wins}W</span>
                      <span className="text-[#475569] mx-1">-</span>
                      <span className="text-[#EF4444]">{losses}L</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </FadeIn>
      )}
    </div>
  );
}
