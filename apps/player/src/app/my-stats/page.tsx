import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { Badge } from '@badminton/ui';
import { getWinRate, getStreakDisplay, getPointDifferential, formatDate } from '@badminton/shared';
import { redirect } from 'next/navigation';
import {
  BarChart3,
  Target,
  Swords,
  TrendingUp,
  Flame,
  Trophy,
  Users,
  Shield,
  Zap,
  Activity,
} from 'lucide-react';
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/motion-wrapper';

export default async function MyStatsPage() {
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();
  const r = Array.isArray(player.ratings) ? player.ratings[0] : player.ratings;

  // Fan out the four independent stat queries in parallel — they used to chain
  // sequentially, blocking the page on ~4× round-trip latency.
  const [reliabilityRes, recentMatchesRes, h2hRes, partnersRes] = await Promise.all([
    supabase
      .from('reliability_metrics')
      .select('no_shows')
      .eq('player_id', player.id)
      .maybeSingle(),
    supabase
      .from('match_participants')
      .select('id, win_flag, rating_delta, match:matches(score_summary, played_at, match_type, format)')
      .eq('player_id', player.id)
      .order('created_at', { ascending: false, referencedTable: 'matches' })
      .limit(20),
    supabase
      .from('head_to_head_stats')
      .select('id, player_a_id, player_b_id, player_a_wins, player_b_wins, total_matches, match_type, a:players!head_to_head_stats_player_a_id_fkey(full_name), b:players!head_to_head_stats_player_b_id_fkey(full_name)')
      .or(`player_a_id.eq.${player.id},player_b_id.eq.${player.id}`)
      .order('total_matches', { ascending: false })
      .limit(10),
    supabase
      .from('partnership_stats')
      .select('id, wins, losses, win_rate, total_matches, partner:players!partnership_stats_partner_id_fkey(full_name)')
      .eq('player_id', player.id)
      .gte('total_matches', 3)
      .order('win_rate', { ascending: false })
      .limit(5),
  ]);

  const reliability = reliabilityRes.data;
  const recentMatches = recentMatchesRes.data;
  const h2h = h2hRes.data;
  const partners = partnersRes.data;

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#EF4444]/10 flex items-center justify-center">
            <BarChart3 className="w-5 h-5 text-[#EF4444]" />
          </div>
          <h1 className="text-3xl font-black font-display text-shuttle-white tracking-wider uppercase">My Stats</h1>
        </div>
      </FadeIn>

      {r && (
        <>
          {/* Primary Stats */}
          <FadeIn delay={0.05}>
            <StaggerContainer className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { icon: Target, color: '#EF4444', label: 'Singles Elo', value: r.singles_elo, sub: r.singles_provisional ? 'Provisional' : `K=${r.singles_k_factor}` },
                { icon: Swords, color: '#FFD700', label: 'Doubles Elo', value: r.doubles_elo, sub: r.doubles_provisional ? 'Provisional' : `K=${r.doubles_k_factor}` },
                { icon: TrendingUp, color: '#EF4444', label: 'Singles Record', value: `${r.singles_wins}W-${r.singles_losses}L`, sub: getWinRate(r.singles_wins, r.singles_losses) },
                { icon: Users, color: '#FFD700', label: 'Doubles Record', value: `${r.doubles_wins}W-${r.doubles_losses}L`, sub: getWinRate(r.doubles_wins, r.doubles_losses) },
              ].map((stat) => (
                <StaggerItem key={stat.label}>
                  <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-4 hover:border-white/[0.1] transition-colors">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${stat.color}15` }}>
                        <stat.icon className="w-3.5 h-3.5" style={{ color: stat.color }} />
                      </div>
                      <span className="text-xs text-[#64748B] font-medium">{stat.label}</span>
                    </div>
                    <p className="text-2xl font-black text-shuttle-white font-display">{stat.value}</p>
                    <p className="text-xs text-[#64748B] mt-1">
                      {stat.sub?.includes('Provisional') ? <span className="text-[#FFD700]">{stat.sub}</span> : stat.sub}
                    </p>
                  </div>
                </StaggerItem>
              ))}
            </StaggerContainer>
          </FadeIn>

          {/* Extended Stats */}
          <FadeIn delay={0.1}>
            <StaggerContainer className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { icon: Flame, color: '#EF4444', label: 'S. Streak', value: getStreakDisplay(r.current_singles_streak), sub: `Best: ${r.best_singles_streak}` },
                { icon: Flame, color: '#F59E0B', label: 'D. Streak', value: getStreakDisplay(r.current_doubles_streak), sub: `Best: ${r.best_doubles_streak}` },
                { icon: Activity, color: '#EF4444', label: 'S. Point Diff', value: getPointDifferential(r.singles_points_scored, r.singles_points_allowed), sub: null },
                { icon: Activity, color: '#FFD700', label: 'D. Point Diff', value: getPointDifferential(r.doubles_points_scored, r.doubles_points_allowed), sub: null },
                { icon: Zap, color: '#94A3B8', label: 'S. Games W/L', value: `${r.singles_games_won}-${r.singles_games_lost}`, sub: null },
                { icon: Zap, color: '#94A3B8', label: 'D. Games W/L', value: `${r.doubles_games_won}-${r.doubles_games_lost}`, sub: null },
                { icon: Trophy, color: '#FFD700', label: 'Total Matches', value: r.singles_matches_played + r.doubles_matches_played, sub: null },
                { icon: Shield, color: reliability?.no_shows ? '#EF4444' : '#EF4444', label: 'Reliability', value: `${reliability?.no_shows ?? 0} no-shows`, sub: null },
              ].map((stat) => (
                <StaggerItem key={stat.label}>
                  <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <stat.icon className="w-3.5 h-3.5" style={{ color: stat.color }} />
                      <span className="text-xs text-[#64748B] font-medium">{stat.label}</span>
                    </div>
                    <p className="text-xl font-bold text-shuttle-white font-display">{stat.value}</p>
                    {stat.sub && <p className="text-xs text-[#64748B] mt-1">{stat.sub}</p>}
                  </div>
                </StaggerItem>
              ))}
            </StaggerContainer>
          </FadeIn>
        </>
      )}

      {/* Head to Head */}
      {h2h && h2h.length > 0 && (
        <FadeIn delay={0.15}>
          <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-4">
            <div className="flex items-center gap-2 mb-4">
              <Swords className="w-4 h-4 text-[#EF4444]" />
              <h2 className="text-sm font-bold text-shuttle-white uppercase tracking-wider font-display">Head to Head</h2>
            </div>
            <div className="space-y-2">
              {h2h.map((h) => {
                const isA = h.player_a_id === player.id;
                const opponentRaw = isA ? h.b : h.a;
                const opponent = (Array.isArray(opponentRaw) ? opponentRaw[0] : opponentRaw) as { full_name?: string } | null;
                const wins = isA ? h.player_a_wins : h.player_b_wins;
                const losses = isA ? h.player_b_wins : h.player_a_wins;
                return (
                  <div key={h.id} className="flex items-center justify-between p-3 bg-white/[0.03] rounded-lg border border-white/[0.04]">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-shuttle-white font-medium">{opponent?.full_name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.06] text-[#64748B] font-medium">{h.match_type}</span>
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

      {/* Best Partners */}
      {partners && partners.length > 0 && (
        <FadeIn delay={0.17}>
          <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-4">
            <div className="flex items-center gap-2 mb-4">
              <Users className="w-4 h-4 text-[#FFD700]" />
              <h2 className="text-sm font-bold text-shuttle-white uppercase tracking-wider font-display">Best Partners</h2>
            </div>
            <div className="space-y-2">
              {partners.map((p) => {
                const partnerRaw = p.partner as unknown;
                const partner = (Array.isArray(partnerRaw) ? partnerRaw[0] : partnerRaw) as { full_name?: string } | null;
                return (
                <div key={p.id} className="flex items-center justify-between p-3 bg-white/[0.03] rounded-lg border border-white/[0.04]">
                  <span className="text-sm text-shuttle-white font-medium">{partner?.full_name}</span>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm">
                      <span className="text-emerald-400">{p.wins}W</span>
                      <span className="text-[#475569] mx-1">-</span>
                      <span className="text-[#EF4444]">{p.losses}L</span>
                    </span>
                    <span className="text-xs font-bold text-[#FFD700]">{Math.round(p.win_rate * 100)}%</span>
                  </div>
                </div>
                );
              })}
            </div>
          </div>
        </FadeIn>
      )}

      {/* Match History */}
      <FadeIn delay={0.2}>
        <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-4">
          <div className="flex items-center gap-2 mb-4">
            <Trophy className="w-4 h-4 text-[#FFD700]" />
            <h2 className="text-sm font-bold text-shuttle-white uppercase tracking-wider font-display">Match History</h2>
          </div>
          <div className="space-y-2">
            {recentMatches?.map((mp) => {
              const matchRaw = mp.match as unknown;
              const m = (Array.isArray(matchRaw) ? matchRaw[0] : matchRaw) as Record<string, unknown> | null;
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
                  <div className="flex items-center gap-3">
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
                <p className="text-[#64748B] text-sm">No matches yet</p>
              </div>
            )}
          </div>
        </div>
      </FadeIn>
    </div>
  );
}
