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
        <div className="flex items-center gap-3 reveal reveal-1">
          <div className="w-10 h-10 rounded-md bg-[var(--ds-accent-dim)] flex items-center justify-center">
            <BarChart3 className="w-5 h-5 text-[var(--ds-accent)]" />
          </div>
          <div>
            <p className="eyebrow">Performance</p>
            <h1 className="ds-display text-3xl font-semibold tracking-tight text-[var(--text-primary)]">My Stats</h1>
          </div>
        </div>
      </FadeIn>

      {r && (
        <>
          {/* Primary Stats */}
          <FadeIn delay={0.05}>
            <StaggerContainer className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { icon: Target, color: 'var(--ds-accent)', label: 'Singles Elo', value: r.singles_elo, sub: r.singles_provisional ? 'Provisional' : `K=${r.singles_k_factor}` },
                { icon: Swords, color: 'var(--color-gold)', label: 'Doubles Elo', value: r.doubles_elo, sub: r.doubles_provisional ? 'Provisional' : `K=${r.doubles_k_factor}` },
                { icon: TrendingUp, color: 'var(--ds-accent)', label: 'Singles Record', value: `${r.singles_wins}W-${r.singles_losses}L`, sub: getWinRate(r.singles_wins, r.singles_losses) },
                { icon: Users, color: 'var(--color-gold)', label: 'Doubles Record', value: `${r.doubles_wins}W-${r.doubles_losses}L`, sub: getWinRate(r.doubles_wins, r.doubles_losses) },
              ].map((stat) => (
                <StaggerItem key={stat.label}>
                  <div className="card-surface p-5 transition-colors duration-150 hover:border-[color-mix(in_srgb,var(--ds-accent)_30%,transparent)]">
                    <p className="eyebrow mb-2">{stat.label}</p>
                    <p className="ds-mono text-2xl font-semibold leading-none" style={{ color: stat.color }}>{stat.value}</p>
                    <p className="text-xs text-[var(--text-muted)] mt-2">
                      {stat.sub?.includes('Provisional') ? <span className="chip chip-gold">{stat.sub}</span> : stat.sub}
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
                { icon: Flame, color: 'var(--ds-accent)', label: 'S. Streak', value: getStreakDisplay(r.current_singles_streak), sub: `Best: ${r.best_singles_streak}` },
                { icon: Flame, color: 'var(--color-warning)', label: 'D. Streak', value: getStreakDisplay(r.current_doubles_streak), sub: `Best: ${r.best_doubles_streak}` },
                { icon: Activity, color: 'var(--ds-accent)', label: 'S. Point Diff', value: getPointDifferential(r.singles_points_scored, r.singles_points_allowed), sub: null },
                { icon: Activity, color: 'var(--color-gold)', label: 'D. Point Diff', value: getPointDifferential(r.doubles_points_scored, r.doubles_points_allowed), sub: null },
                { icon: Zap, color: 'var(--text-secondary)', label: 'S. Games W/L', value: `${r.singles_games_won}-${r.singles_games_lost}`, sub: null },
                { icon: Zap, color: 'var(--text-secondary)', label: 'D. Games W/L', value: `${r.doubles_games_won}-${r.doubles_games_lost}`, sub: null },
                { icon: Trophy, color: 'var(--color-gold)', label: 'Total Matches', value: r.singles_matches_played + r.doubles_matches_played, sub: null },
                { icon: Shield, color: 'var(--ds-accent)', label: 'Reliability', value: `${reliability?.no_shows ?? 0} no-shows`, sub: null },
              ].map((stat) => (
                <StaggerItem key={stat.label}>
                  <div className="card-surface p-4">
                    <p className="eyebrow mb-2">{stat.label}</p>
                    <p className="ds-mono text-xl font-semibold text-[var(--text-primary)]">{stat.value}</p>
                    {stat.sub && <p className="text-xs text-[var(--text-muted)] mt-1">{stat.sub}</p>}
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
          <div className="card-elevated p-4">
            <div className="flex items-center gap-2 mb-4">
              <Swords className="w-4 h-4 text-court-red" />
              <h2 className="eyebrow" style={{ color: 'var(--text-primary)' }}>Head to Head</h2>
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
                      <span className="chip">{h.match_type}</span>
                    </div>
                    <span className="font-mono text-sm font-bold nums">
                      <span className="text-[var(--color-success)]">{wins}W</span>
                      <span className="text-[var(--text-dim)] mx-1">-</span>
                      <span className="text-[var(--color-danger)]">{losses}L</span>
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
          <div className="card-elevated p-4">
            <div className="flex items-center gap-2 mb-4">
              <Users className="w-4 h-4 text-gold" />
              <h2 className="eyebrow" style={{ color: 'var(--text-primary)' }}>Best Partners</h2>
            </div>
            <div className="space-y-2">
              {partners.map((p) => {
                const partnerRaw = p.partner as unknown;
                const partner = (Array.isArray(partnerRaw) ? partnerRaw[0] : partnerRaw) as { full_name?: string } | null;
                return (
                <div key={p.id} className="flex items-center justify-between p-3 bg-white/[0.03] rounded-lg border border-white/[0.04]">
                  <span className="text-sm text-shuttle-white font-medium">{partner?.full_name}</span>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm nums">
                      <span className="text-[var(--color-success)]">{p.wins}W</span>
                      <span className="text-[var(--text-dim)] mx-1">-</span>
                      <span className="text-[var(--color-danger)]">{p.losses}L</span>
                    </span>
                    <span className="chip chip-gold nums">{Math.round(p.win_rate * 100)}%</span>
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
        <div className="card-elevated p-4">
          <div className="flex items-center gap-2 mb-4">
            <Trophy className="w-4 h-4 text-gold" />
            <h2 className="eyebrow" style={{ color: 'var(--text-primary)' }}>Match History</h2>
          </div>
          <div className="space-y-2">
            {recentMatches?.map((mp) => {
              const matchRaw = mp.match as unknown;
              const m = (Array.isArray(matchRaw) ? matchRaw[0] : matchRaw) as Record<string, unknown> | null;
              if (!m) return null;
              const isWin = mp.win_flag === true;
              const isLoss = mp.win_flag === false;
              return (
                <div key={mp.id} className="flex items-center justify-between p-3 bg-white/[0.03] rounded-md border border-[var(--border)]">
                  <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-md flex items-center justify-center text-xs font-bold ${
                      isWin ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]' : isLoss ? 'bg-[var(--color-danger)]/15 text-[var(--color-danger)]' : 'bg-white/[0.06] text-[var(--text-muted)]'
                    }`}>
                      {isWin ? 'W' : isLoss ? 'L' : '?'}
                    </div>
                    <span className="ds-mono text-sm text-shuttle-white font-medium">{m.score_summary as string || '-'}</span>
                    <span className="chip">{m.match_type as string}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`ds-mono text-sm font-bold ${(mp.rating_delta ?? 0) >= 0 ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`}>
                      {mp.rating_delta !== null ? `${(mp.rating_delta ?? 0) >= 0 ? '+' : ''}${mp.rating_delta}` : ''}
                    </span>
                    <span className="text-xs text-[var(--text-dim)]">{m.played_at ? formatDate(m.played_at as string) : ''}</span>
                  </div>
                </div>
              );
            })}
            {(!recentMatches || recentMatches.length === 0) && (
              <div className="text-center py-8">
                <Trophy className="w-8 h-8 text-[var(--text-dim)] mx-auto mb-2" />
                <p className="text-[var(--text-muted)] text-sm">No matches yet</p>
              </div>
            )}
          </div>
        </div>
      </FadeIn>
    </div>
  );
}
