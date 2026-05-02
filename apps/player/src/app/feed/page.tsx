import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { Badge, PageHero } from '@badminton/ui';
import { MATCH_FORMAT_LABELS, formatRelativeTime, getWinRate } from '@badminton/shared';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  Swords,
  ChevronRight,
  Zap,
  Trophy,
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
    <div>
      <PageHero
        eyebrow="Season 02 · Spring 2026"
        title={<>Born on the<br/>court.</>}
        subtitle="ELO that moves with every match. Sessions you can join on the fly. Challenges that end on the score, not the dispute."
        watermark="A1"
        size={64}
        watermarkOpacity={0.08}
      />
      <div className="space-y-6 px-2 md:px-6 py-8">
      {/* Profile hero */}
      <FadeIn>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            {/* Avatar */}
            <div className="w-[52px] h-[52px] rounded-full flex items-center justify-center shrink-0 overflow-hidden bg-[var(--bg-card)] border-[0.5px] border-[var(--border-strong)]">
              {player.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={player.avatar_url as string} alt="" className="w-full h-full object-cover" />
              ) : (
                <span className="text-[18px] font-medium text-[var(--text-secondary)]">
                  {(player.full_name as string).split(' ').map((p: string) => p[0]).slice(0, 2).join('').toUpperCase()}
                </span>
              )}
            </div>
            {/* Name + tier pill */}
            <div className="min-w-0">
              <p className="text-[16px] font-medium text-[var(--text-primary)] truncate">
                {player.full_name}
              </p>
              {player.status && (
                <span className="inline-flex items-center gap-1.5 mt-1.5 px-[10px] py-[3px] rounded-full text-[11px] text-[var(--accent)] bg-[var(--bg-accent)] border-[0.5px] border-[var(--accent-border)]">
                  <span className="w-[5px] h-[5px] rounded-full bg-[var(--accent)] inline-block" />
                  {player.status.charAt(0).toUpperCase() + player.status.slice(1)}
                </span>
              )}
            </div>
          </div>
          {/* ELO hero (singles) */}
          {r && (
            <div className="text-right shrink-0">
              <p className="nums text-[28px] font-medium leading-none text-[var(--text-primary)]">
                {r.singles_elo}
              </p>
              <p className="mt-1 text-[10px] tracking-[0.04em] uppercase text-[var(--text-muted)]">
                Singles ELO
              </p>
            </div>
          )}
        </div>
      </FadeIn>

      {/* Stat grid */}
      {r && (
        <FadeIn delay={0.05}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <div
              className="reveal reveal-1 bg-[var(--bg-card)] py-[10px] px-[12px] border-[0.5px] border-[var(--border)]"
              style={{ borderLeft: '3px solid var(--ds-accent)' }}
            >
              <p className="text-[10px] tracking-[0.04em] uppercase font-normal text-[var(--text-muted)]">Singles ELO</p>
              <p className="nums mt-1 text-[18px] font-medium text-[var(--text-primary)]">{r.singles_elo}</p>
              <p className="mt-1 text-[11px] text-[var(--accent)]">
                {r.singles_provisional ? 'Provisional' : `Win rate ${singlesWinRate}`}
              </p>
            </div>
            <div
              className="reveal reveal-2 bg-[var(--bg-card)] py-[10px] px-[12px] border-[0.5px] border-[var(--border)]"
              style={{ borderLeft: '3px solid var(--ds-accent)' }}
            >
              <p className="text-[10px] tracking-[0.04em] uppercase font-normal text-[var(--text-muted)]">Doubles ELO</p>
              <p className="nums mt-1 text-[18px] font-medium text-[var(--text-primary)]">{r.doubles_elo}</p>
              <p className="mt-1 text-[11px] text-[var(--accent)]">
                {r.doubles_provisional ? 'Provisional' : `Win rate ${doublesWinRate}`}
              </p>
            </div>
            <div
              className="reveal reveal-3 bg-[var(--bg-card)] py-[10px] px-[12px] border-[0.5px] border-[var(--border)]"
              style={{ borderLeft: '3px solid var(--loss)' }}
            >
              <p className="text-[10px] tracking-[0.04em] uppercase font-normal text-[var(--text-muted)]">Singles W/L</p>
              <p className="nums mt-1 text-[18px] font-medium text-[var(--text-primary)]">{r.singles_wins ?? 0} / {r.singles_losses ?? 0}</p>
            </div>
            <div
              className="reveal reveal-4 bg-[var(--bg-card)] py-[10px] px-[12px] border-[0.5px] border-[var(--border)]"
              style={{ borderLeft: '3px solid var(--loss)' }}
            >
              <p className="text-[10px] tracking-[0.04em] uppercase font-normal text-[var(--text-muted)]">Doubles W/L</p>
              <p className="nums mt-1 text-[18px] font-medium text-[var(--text-primary)]">{r.doubles_wins ?? 0} / {r.doubles_losses ?? 0}</p>
            </div>
          </div>
        </FadeIn>
      )}

      {/* Pending Challenges */}
      {pendingChallenges && pendingChallenges.length > 0 && (
        <FadeIn delay={0.1}>
          <div className="card-elevated p-4" style={{ borderColor: 'color-mix(in srgb, var(--color-gold) 12%, transparent)' }}>
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
                          <div className="w-9 h-9 rounded-full bg-[var(--color-gold)]/10 flex items-center justify-center shrink-0">
                            <Swords className="w-4 h-4 text-gold" />
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-shuttle-white">
                              {creator?.full_name as string} challenged you
                            </p>
                            <p className="text-xs text-[var(--text-muted)] mt-0.5">
                              {c.type as string} &middot; {MATCH_FORMAT_LABELS[(c.format as string) as keyof typeof MATCH_FORMAT_LABELS]}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="chip chip-gold">Respond</span>
                          <ChevronRight className="w-4 h-4 text-[var(--text-muted)] group-hover:text-gold transition-colors" />
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
            <Link href="/my-stats" className="text-xs text-[var(--ds-accent)] hover:text-[var(--ds-accent)]/80 font-semibold transition-colors">
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
                    className="flex items-center justify-between p-3 bg-[var(--bg-card)] border border-[var(--border)]"
                  >
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 flex items-center justify-center text-xs font-black ${
                        isWin
                          ? 'bg-emerald-500/15 text-emerald-400'
                          : isLoss
                            ? 'bg-[var(--ds-accent)]/15 text-[var(--ds-accent)]'
                            : 'bg-[var(--on-surface-med)] text-[var(--text-muted)]'
                      }`}>
                        {isWin ? 'W' : isLoss ? 'L' : '?'}
                      </div>
                      <span className="text-sm font-mono text-shuttle-white font-medium nums">
                        {m.score_summary as string || '-'}
                      </span>
                    </div>
                    <span className="text-xs text-[var(--text-dim)]">
                      {m.played_at ? formatRelativeTime(m.played_at as string) : ''}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Trophy className="w-8 h-8 text-[var(--text-dim)] mb-2" />
              <p className="text-sm text-[var(--text-muted)]">No matches yet</p>
            </div>
          )}
        </div>
      </FadeIn>

      {/* Quick Actions */}
      <FadeIn delay={0.25}>
        <div className="flex gap-3">
          <Link href="/challenges/new" className="flex-1 press">
            <button type="button" className="w-full h-12 gradient-court text-[var(--ds-bg-base)] font-bold text-sm tracking-wide flex items-center justify-center gap-2 glow-red hover:opacity-90 transition-opacity">
              <Swords className="w-4 h-4" />
              Create Challenge
            </button>
          </Link>
          <Link href="/leaderboard" className="flex-1 press">
            <button type="button" className="w-full h-12 bg-[var(--on-surface-soft)] border border-[var(--border)] text-[var(--text-primary)] font-bold text-sm tracking-wide flex items-center justify-center gap-2 hover:bg-[var(--on-surface-med)] hover:border-[var(--border-hover)] transition-all duration-300">
              <Trophy className="w-4 h-4 text-gold" />
              Leaderboard
            </button>
          </Link>
        </div>
      </FadeIn>
    </div>
    </div>
  );
}
