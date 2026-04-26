import { createServerSupabaseClient } from '@/lib/supabase-server';
import { Avatar } from '@badminton/ui';
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
    <div className="space-y-5 pb-28 px-4 sm:px-0 max-w-2xl mx-auto">
      {/* Back link */}
      <Link
        href="/leaderboard"
        className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors duration-150 group min-h-[44px] py-2"
      >
        <ArrowLeft className="w-4 h-4 transition-transform duration-150 group-hover:-translate-x-0.5" />
        Back to Leaderboard
      </Link>

      {/* Player Hero Card */}
      <FadeIn>
        <div className="card-elevated rounded-lg overflow-hidden">
          {/* Accent band */}
          <div className="h-0.5 bg-[var(--ds-accent)]" />
          <div className="p-6 flex flex-wrap items-center gap-5">
            <Avatar name={player.full_name} size="lg" />
            <div className="flex-1 min-w-0">
              <h1 className="ds-display text-3xl font-semibold tracking-tight text-[var(--text-primary)] truncate">{player.full_name}</h1>
              <div className="flex flex-wrap gap-2 mt-3">
                <span className={`chip ${player.status === 'competitive' ? 'chip-success' : ''}`}>
                  {PLAYER_STATUS_LABELS[player.status as keyof typeof PLAYER_STATUS_LABELS]}
                </span>
                {r && (() => {
                  const t = getSeasonTier(r.singles_elo);
                  return (
                    <span
                      className="chip"
                      style={{ borderColor: `${t.color}50`, background: `${t.color}18`, color: t.color }}
                    >
                      {t.tier}
                    </span>
                  );
                })()}
              </div>
            </div>
            <Link
              href={`/challenges/new?opponent=${playerId}`}
              className="press inline-flex items-center gap-2 px-4 min-h-[40px] bg-[var(--ds-accent)] text-[#0A0A0A] text-sm font-semibold rounded-md hover:brightness-110 active:scale-[0.98] transition-all duration-150 shrink-0 group"
            >
              <Swords className="w-4 h-4 group-hover:rotate-12 transition-transform duration-200" />
              Challenge
            </Link>
          </div>
        </div>
      </FadeIn>

      {r && (
        <>
          {/* Primary Stats */}
          <FadeIn delay={0.05}>
            <StaggerContainer className="grid grid-cols-2 gap-3">
              {[
                { icon: Target,    color: 'var(--ds-accent)', label: 'Singles Elo', value: r.singles_elo, sub: r.singles_provisional ? 'Provisional' : 'Established', gold: false },
                { icon: Swords,    color: 'var(--color-gold)',   label: 'Doubles Elo', value: r.doubles_elo, sub: r.doubles_provisional ? 'Provisional' : 'Established', gold: true  },
                { icon: TrendingUp,color: 'var(--ds-accent)', label: 'Singles W/L', value: `${r.singles_wins}–${r.singles_losses}`, sub: getWinRate(r.singles_wins, r.singles_losses), gold: false },
                { icon: Users,     color: 'var(--color-gold)',   label: 'Doubles W/L', value: `${r.doubles_wins}–${r.doubles_losses}`, sub: getWinRate(r.doubles_wins, r.doubles_losses), gold: true  },
              ].map((stat) => (
                <StaggerItem key={stat.label}>
                  <div className="card-surface rounded-lg p-5 h-full transition-colors duration-150 hover:border-[color-mix(in_srgb,var(--ds-accent)_30%,transparent)]">
                    <div className="flex items-center gap-2 mb-3">
                      <div className="w-7 h-7 rounded-md flex items-center justify-center shrink-0" style={{ background: `${stat.color}18` }}>
                        <stat.icon className="w-3.5 h-3.5" style={{ color: stat.color }} />
                      </div>
                      <span className="eyebrow">{stat.label}</span>
                    </div>
                    <p className="ds-mono text-[2.5rem] font-semibold leading-none mb-2" style={{ color: stat.color }}>
                      {stat.value}
                    </p>
                    <p className="text-xs text-[var(--text-muted)]">{stat.sub}</p>
                  </div>
                </StaggerItem>
              ))}
            </StaggerContainer>
          </FadeIn>

          {/* Extended Stats */}
          <FadeIn delay={0.1}>
            <StaggerContainer className="grid grid-cols-2 gap-3">
              {[
                { icon: Flame,    color: 'var(--ds-accent)', label: 'S. Streak',   value: getStreakDisplay(r.current_singles_streak) },
                { icon: Flame,    color: 'var(--color-warning)', label: 'D. Streak',   value: getStreakDisplay(r.current_doubles_streak) },
                { icon: BarChart3,color: 'var(--ds-accent)', label: 'S. Point +/-',value: getPointDifferential(r.singles_points_scored, r.singles_points_allowed) },
                { icon: BarChart3,color: 'var(--color-gold)',   label: 'D. Point +/-',value: getPointDifferential(r.doubles_points_scored, r.doubles_points_allowed) },
              ].map((stat) => (
                <StaggerItem key={stat.label}>
                  <div className="card-surface rounded-lg p-4 h-full">
                    <div className="flex items-center gap-2 mb-2">
                      <stat.icon className="w-3.5 h-3.5 shrink-0" style={{ color: stat.color }} />
                      <span className="eyebrow">{stat.label}</span>
                    </div>
                    <p className="ds-mono text-xl font-semibold text-[var(--text-primary)]">{stat.value}</p>
                  </div>
                </StaggerItem>
              ))}
            </StaggerContainer>
          </FadeIn>
        </>
      )}

      {/* Recent Matches */}
      <FadeIn delay={0.15}>
        <div className="card-elevated rounded-2xl overflow-hidden">
          <div className="flex items-center gap-2 p-4 pb-0 mb-3">
            <Trophy className="w-4 h-4 text-[var(--color-gold)]" />
            <h2 className="display-md text-base">Recent Matches</h2>
          </div>
          <div className="px-4 pb-4 space-y-2">
            {recentMatches?.map((mp, i) => {
              const m = mp.match as Record<string, unknown> | null;
              if (!m) return null;
              const isWin  = mp.win_flag === true;
              const isLoss = mp.win_flag === false;
              return (
                <div
                  key={mp.id}
                  className={`reveal reveal-${Math.min(i + 1, 6) as 1|2|3|4|5|6} flex items-center justify-between p-3 bg-white/[0.03] rounded-md border ${
                    isWin  ? 'border-[var(--color-success)]/15' :
                    isLoss ? 'border-[var(--color-danger)]/15' :
                    'border-[var(--border)]'
                  } gap-3`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={`w-8 h-8 rounded-md flex items-center justify-center text-xs font-bold shrink-0 ${
                      isWin ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]' :
                      isLoss ? 'bg-[var(--color-danger)]/15 text-[var(--color-danger)]' :
                      'bg-white/[0.06] text-[var(--text-muted)]'
                    }`}>
                      {isWin ? 'W' : isLoss ? 'L' : '?'}
                    </div>
                    <div className="min-w-0">
                      <p className="ds-mono text-sm font-semibold text-[var(--text-primary)] truncate">{m.score_summary as string || '–'}</p>
                      <span className="chip text-[10px] mt-0.5">{m.match_type as string}</span>
                    </div>
                  </div>
                  <div className="text-right shrink-0 flex flex-col items-end gap-0.5">
                    {mp.rating_delta !== null && (
                      <span className={`ds-mono text-sm font-bold ${(mp.rating_delta ?? 0) >= 0 ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`}>
                        {(mp.rating_delta ?? 0) >= 0 ? '+' : ''}{mp.rating_delta}
                      </span>
                    )}
                    <span className="text-xs text-[var(--text-dim)]">{m.played_at ? formatDate(m.played_at as string) : ''}</span>
                  </div>
                </div>
              );
            })}
            {(!recentMatches || recentMatches.length === 0) && (
              <div className="text-center py-10">
                <Trophy className="w-9 h-9 text-[var(--border-strong)] mx-auto mb-2" />
                <p className="text-[var(--text-muted)] text-sm">No matches yet</p>
              </div>
            )}
          </div>
        </div>
      </FadeIn>

      {/* Head to Head */}
      {h2hStats && h2hStats.length > 0 && (
        <FadeIn delay={0.2}>
          <div className="card-elevated rounded-2xl overflow-hidden">
            <div className="flex items-center gap-2 p-4 pb-0 mb-3">
              <Swords className="w-4 h-4 text-[var(--ds-accent)]" />
              <h2 className="display-md text-base">Head to Head</h2>
            </div>
            <div className="px-4 pb-4 space-y-2">
              {h2hStats.map((h) => {
                const isA   = h.player_a_id === playerId;
                const wins  = isA ? h.player_a_wins : h.player_b_wins;
                const losses= isA ? h.player_b_wins : h.player_a_wins;
                return (
                  <div key={h.id} className="flex items-center justify-between p-3 bg-white/[0.03] rounded-xl border border-[var(--border)] gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm text-[var(--text-secondary)] truncate capitalize">{h.match_type}</span>
                      <span className="eyebrow">&middot; {h.total_matches}m</span>
                    </div>
                    <span className="ds-mono text-sm font-bold shrink-0 flex items-center gap-1">
                      <span className="text-[var(--color-success)]">{wins}W</span>
                      <span className="text-[var(--text-dim)]">–</span>
                      <span className="text-[var(--color-danger)]">{losses}L</span>
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
