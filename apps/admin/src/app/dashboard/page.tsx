export const dynamic = 'force-dynamic';
import { createAdminClient, getAuthenticatedConsoleUser } from '@/lib/supabase-server';
import { accessLevelFor, atLeast, canAccess, portfolioOf, portfolioPermits } from '@/lib/permissions';
import { Badge, AvatarChip, PageHeader } from '@badminton/ui';
import { PLAYER_STATUS_LABELS } from '@badminton/shared';
import Link from 'next/link';
import {
  UserCheck,
  AlertTriangle,
  Swords,
  ArrowUpRight,
  Trophy,
} from 'lucide-react';
import { ApproveButtons } from './approve-buttons';
import { getSeasonFinances } from '@/lib/season-finance';

// Only needed to give the "trainer sees no matches" branch of the fetch below a
// type to agree with — the admin client carries no generated Database type, so
// the real query's rows are untyped.
type DashboardMatch = {
  id: string;
  score_summary: string | null;
  result_status: string;
  match_participants?: Record<string, unknown>[] | null;
};

export default async function DashboardPage() {
  const supabase = createAdminClient();

  // The dashboard links into every other section, so it has to answer the same
  // question the sidebar and middleware answer — through the SAME helper, not a
  // hand-kept second list. An exec used to see tiles for disputes, walkovers,
  // fees and challenges, every one of which bounced them to /unauthorized.
  const viewer = await getAuthenticatedConsoleUser();
  const level = accessLevelFor(viewer);
  // An exec's portfolio narrows this page exactly as it narrows the nav — the
  // tiles link into sections a narrowed exec can no longer open, and the fetches
  // behind them would otherwise ship those sections' counts into the RSC payload
  // for someone who is refused the page itself.
  const portfolio = portfolioOf(viewer);
  const showPlayers = canAccess(level, portfolio, '/players');
  const showDisputes = canAccess(level, portfolio, '/disputes');
  const showWalkovers = canAccess(level, portfolio, '/walkovers');
  const showChallenges = canAccess(level, portfolio, '/challenges');
  // NOT canAccess(level, '/fees'). /fees is exec-level now so an exec can reach
  // the Expenses tab, but the finance snapshot below is income, expenses AND
  // the net position — the club money an exec is deliberately kept away from.
  // Asking the route map here would have leaked all three into an exec's
  // dashboard the moment that map changed, from the one file that is supposed
  // to be the example of gating the fetch. Ask for the level the DATA needs.
  const showFinances = atLeast(level, 'admin');
  // Sections that used to be unconditional. A varsity trainer reaches the
  // dashboard (it is where sign-in lands) but has no business in matches or
  // tournaments, and both links bounce them to /unauthorized.
  const showMatches = canAccess(level, portfolio, '/matches');
  const showTournaments = canAccess(level, portfolio, '/tournaments');
  // /players is trainer-readable, but approving is exec work — the approve
  // buttons below call approvePlayer, which gates on getExecOrAdmin('internal').
  // Asking the level and the portfolio directly rather than reusing showPlayers
  // keeps the panel honest: this gates a FETCH, so a finance exec who kept the
  // panel would be handed the pending-approval list and buttons that throw.
  const canApprove = atLeast(level, 'exec') && portfolioPermits(level, portfolio, 'internal');

  // Gate the FETCHES, not just the tiles: a hidden card whose query still ran
  // would ship admin-only counts into the RSC payload for anyone with devtools.
  const noCount = Promise.resolve({ count: null as number | null });

  // Fold pendingPlayersList into the same parallel batch — it used to chain
  // sequentially after Promise.all, costing an extra round-trip on every load.
  // Use head:true counts everywhere instead of select('*') to avoid streaming
  // every row just to get a count.
  const [
    { count: totalPlayers },
    { count: pendingPlayers },
    { count: openDisputes },
    { count: pendingWalkovers },
    { data: recentMatches },
    { count: activeTournaments },
    { count: activeChalls },
    { data: pendingPlayersList },
  ] = await Promise.all([
    showPlayers ? supabase.from('players').select('id', { count: 'exact', head: true }).neq('status', 'pending_approval') : noCount,
    canApprove ? supabase.from('players').select('id', { count: 'exact', head: true }).eq('status', 'pending_approval') : noCount,
    showDisputes ? supabase.from('disputes').select('id', { count: 'exact', head: true }).eq('status', 'open') : noCount,
    showWalkovers ? supabase.from('walkovers').select('id', { count: 'exact', head: true }).eq('status', 'pending') : noCount,
    showMatches
      ? supabase.from('matches').select('id, score_summary, played_at, match_type, format, created_at, result_status, match_participants(player_id, team_side, win_flag, rating_delta, player:players(full_name))').order('created_at', { ascending: false }).limit(5)
      : Promise.resolve({ data: null as DashboardMatch[] | null }),
    showTournaments ? supabase.from('tournaments').select('id', { count: 'exact', head: true }).eq('status', 'active') : noCount,
    showChallenges ? supabase.from('challenges').select('id', { count: 'exact', head: true }).in('status', ['proposed', 'partially_confirmed', 'accepted']) : noCount,
    canApprove
      ? supabase
          .from('players')
          .select('id, full_name, email, avatar_url, created_at')
          .eq('status', 'pending_approval')
          .order('created_at', { ascending: false })
          .limit(10)
      : Promise.resolve({ data: null as { id: string; full_name: string; email: string; avatar_url: string | null; created_at: string }[] | null }),
  ]);

  // Each term is gated too: the banner text names open disputes and pending
  // walkovers, so leaving it ungated would leak the counts the tiles hide.
  const alertTerms = [
    canApprove && pendingPlayers && pendingPlayers > 0 ? `${pendingPlayers} pending approval${pendingPlayers > 1 ? 's' : ''}` : null,
    showDisputes && openDisputes && openDisputes > 0 ? `${openDisputes} open dispute${openDisputes > 1 ? 's' : ''}` : null,
    showWalkovers && pendingWalkovers && pendingWalkovers > 0 ? `${pendingWalkovers} pending walkover${pendingWalkovers > 1 ? 's' : ''}` : null,
  ].filter(Boolean);
  const hasAlerts = alertTerms.length > 0;

  // Finance snapshot for the active season: money in, money out, and whether
  // the club is in the positives. Admin-only, and gated on showFinances rather
  // than on reaching /fees — see the note beside that flag.
  let activeSeason: { id: string; name: string } | null = null;
  let seasonIncomeCents = 0;
  let seasonExpenseCents = 0;
  let seasonNetCents = 0;
  if (showFinances) {
    const { data } = await supabase
      .from('seasons')
      .select('id, name')
      .eq('active_flag', true)
      .maybeSingle();
    activeSeason = data;
    if (activeSeason) {
      // Every ledger, via the shared helper. Income used to be summed inline
      // from club_fees only, so recorded reinstatement and tournament money
      // read as $0.00 — and it was wrong here AND on /fees because each page
      // did its own arithmetic. Net is computed in exactly one place for the
      // same reason.
      const finances = await getSeasonFinances(supabase, activeSeason);
      seasonIncomeCents = finances.income.totalCents;
      seasonExpenseCents = finances.expenseCents;
      seasonNetCents = finances.netCents;
    }
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <PageHeader
        title="Dashboard"
        sub="Overview of club activity and action items"
        watermark="D"
      />

      {/* Alert Banner */}
      {hasAlerts && (
        <div className="rounded-xl border border-[var(--color-warning)]/20 bg-[var(--color-warning)]/5 p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-[var(--color-warning)]/10 flex items-center justify-center flex-shrink-0">
            <AlertTriangle className="w-5 h-5 text-[var(--color-warning)]" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-medium text-[var(--text-primary)]">Items need your attention</p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              {alertTerms.join(' · ')}
            </p>
          </div>
        </div>
      )}

      {/* Pending Players. Exec-allowed now that /players is — approvePlayer
          takes getExecOrAdmin(), so the buttons here work for both. Trainers
          reach /players but cannot approve, so this whole panel is theirs to
          not see: every row in it is a pair of buttons that would reject them. */}
      {canApprove && pendingPlayersList && pendingPlayersList.length > 0 && (
        <div className="rounded-xl border border-[var(--color-warning)]/20 bg-[var(--bg-card)] overflow-hidden">
          <div className="px-5 py-4 border-b border-[var(--border)] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <UserCheck className="w-4 h-4 text-[var(--color-warning)]" />
              <h2 className="text-sm font-semibold text-[var(--text-primary)] uppercase tracking-wide">Pending Approvals</h2>
              <span className="text-xs bg-[var(--color-warning)]/10 text-[var(--color-warning)] px-2 py-0.5 rounded-full font-medium">{pendingPlayersList.length}</span>
            </div>
            <Link href="/players?tab=attention" className="text-xs text-[var(--color-accent)] hover:underline flex items-center gap-1">
              View All <ArrowUpRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="divide-y divide-[var(--border)]">
            {pendingPlayersList.map((player) => (
              <div key={player.id} className="px-5 py-3 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <AvatarChip src={player.avatar_url} name={player.full_name} size="sm" id={player.id} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-[var(--text-primary)] truncate">{player.full_name}</p>
                    <p className="text-xs text-[var(--text-muted)] truncate">{player.email}</p>
                  </div>
                </div>
                <ApproveButtons playerId={player.id} playerName={player.full_name} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stat strip */}
      {(showPlayers || showDisputes || showWalkovers) && (
      <div className="stat-strip">
        {showPlayers && (
          <Link href="/players" className="hover:bg-[var(--bg-card)] transition-colors">
            <p className="stat-label">Active Players</p>
            <p className="stat-value">{totalPlayers ?? 0}</p>
          </Link>
        )}
        {/* Approving is exec work, so the COUNT is exec work too. This rode on
            showPlayers, which is trainer-level, so a trainer saw how many people
            were waiting on a decision they cannot make — and the panel and its
            buttons below were already exec-only, so the number was the one part
            that leaked. */}
        {canApprove && (
          <Link href="/players?tab=attention" className="hover:bg-[var(--bg-card)] transition-colors">
            <p className="stat-label">Pending Approvals</p>
            <p className={`stat-value ${(pendingPlayers ?? 0) > 0 ? 'text-[var(--color-warning)]' : ''}`}>{pendingPlayers ?? 0}</p>
          </Link>
        )}
        {/* Hidden outright rather than zeroed: a hollow "0 open disputes" tile
            that bounces to /unauthorized is worse than no tile. .stat-strip is
            grid-auto-flow:column, so the remaining tiles simply widen. */}
        {showDisputes && (
          <Link href="/disputes" className="hover:bg-[var(--bg-card)] transition-colors">
            <p className="stat-label">Open Disputes</p>
            <p className={`stat-value ${(openDisputes ?? 0) > 0 ? 'text-[var(--color-danger)]' : ''}`}>{openDisputes ?? 0}</p>
          </Link>
        )}
        {showWalkovers && (
          <Link href="/walkovers" className="hover:bg-[var(--bg-card)] transition-colors">
            <p className="stat-label">Pending Walkovers</p>
            <p className={`stat-value ${(pendingWalkovers ?? 0) > 0 ? 'text-[var(--color-warning)]' : ''}`}>{pendingWalkovers ?? 0}</p>
          </Link>
        )}
      </div>
      )}

      {/* Finance snapshot — in, out, and the net. The net is the headline
          because it is the question the club owner actually asks; income alone
          reads like good news no matter what has been spent. */}
      {showFinances && activeSeason && (
        <Link href="/fees" className="group block">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-5 hover:border-[var(--border-hover)] transition-all hover:shadow-lg hover:shadow-black/5 flex items-center justify-between gap-4 flex-wrap">
            <div>
              <p className="text-xs text-[var(--text-muted)] uppercase">{activeSeason.name} · Net position</p>
              <p
                className={`text-3xl font-bold font-mono mt-1 ${
                  seasonNetCents < 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-success)]'
                }`}
              >
                {seasonNetCents < 0 ? '-' : ''}${(Math.abs(seasonNetCents) / 100).toFixed(2)}
              </p>
              <p className="text-xs text-[var(--text-muted)] mt-1">
                <span className="text-[var(--color-success)] font-mono">${(seasonIncomeCents / 100).toFixed(2)}</span> in
                {' · '}
                <span className="text-[var(--color-danger)] font-mono">${(seasonExpenseCents / 100).toFixed(2)}</span> out
              </p>
            </div>
            <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
              Manage finances <ArrowUpRight className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          </div>
        </Link>
      )}

      {/* Two Column Section. Collapses to one column when Challenges is hidden,
          so an exec gets a full-width Tournaments card rather than a half-width
          one floating beside a gap. */}
      {(showTournaments || showChallenges) && (
      <div className={`grid grid-cols-1 gap-6 ${showTournaments && showChallenges ? 'lg:grid-cols-2' : ''}`}>
        {/* Active Tournaments */}
        {showTournaments && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Trophy className="w-4 h-4 text-[var(--text-muted)]" />
              <h2 className="text-sm font-semibold text-[var(--text-primary)] uppercase tracking-wide">Tournaments</h2>
            </div>
            <Link href="/tournaments" className="text-xs text-[var(--color-accent)] hover:underline flex items-center gap-1">
              Manage <ArrowUpRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="flex items-end gap-2">
            <p className="text-4xl font-bold font-mono text-[var(--text-primary)]">{activeTournaments ?? 0}</p>
            <p className="text-sm text-[var(--text-muted)] mb-1">active</p>
          </div>
        </div>
        )}

        {/* Active Challenges */}
        {showChallenges && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Swords className="w-4 h-4 text-[var(--text-muted)]" />
              <h2 className="text-sm font-semibold text-[var(--text-primary)] uppercase tracking-wide">Active Challenges</h2>
            </div>
            <Link href="/challenges" className="text-xs text-[var(--color-accent)] hover:underline flex items-center gap-1">
              View All <ArrowUpRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="flex items-end gap-2">
            <p className="text-4xl font-bold font-mono text-[var(--text-primary)]">{activeChalls ?? 0}</p>
            <p className="text-sm text-[var(--text-muted)] mb-1">active</p>
          </div>
        </div>
        )}
      </div>
      )}

      {/* Recent Matches */}
      {showMatches && (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)]">
        <div className="flex items-center justify-between p-6 pb-4">
          <div className="flex items-center gap-2">
            <Trophy className="w-4 h-4 text-[var(--text-muted)]" />
            <h2 className="text-sm font-semibold text-[var(--text-primary)] uppercase tracking-wide">Recent Matches</h2>
          </div>
          <Link href="/matches" className="text-xs text-[var(--color-accent)] hover:underline flex items-center gap-1">
            View All <ArrowUpRight className="w-3 h-3" />
          </Link>
        </div>
        <div className="px-6 pb-6">
          <div className="space-y-1">
            {recentMatches?.map((match) => {
              const participants = match.match_participants || [];
              const sideA = participants.filter((p: Record<string, unknown>) => p.team_side === 'a');
              const sideB = participants.filter((p: Record<string, unknown>) => p.team_side === 'b');

              return (
                <div key={match.id} className="flex items-center justify-between py-3 border-b border-[var(--border)] last:border-0 hover:bg-white/[0.02] -mx-3 px-3 rounded-lg transition-colors">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-sm text-[var(--text-primary)] truncate">
                      {sideA.map((p: Record<string, unknown>) => (p.player as Record<string, unknown>)?.full_name).join(' & ')}
                    </span>
                    <span className="text-xs text-[var(--text-muted)] flex-shrink-0 bg-[var(--border-hover)] px-1.5 py-0.5 rounded">vs</span>
                    <span className="text-sm text-[var(--text-primary)] truncate">
                      {sideB.map((p: Record<string, unknown>) => (p.player as Record<string, unknown>)?.full_name).join(' & ')}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0 ml-4">
                    <span className="text-sm font-mono text-[var(--text-primary)] font-medium">{match.score_summary || '-'}</span>
                    <Badge
                      variant={
                        match.result_status === 'confirmed' ? 'success' :
                        match.result_status === 'disputed' ? 'danger' :
                        'warning'
                      }
                    >
                      {match.result_status}
                    </Badge>
                  </div>
                </div>
              );
            })}
            {(!recentMatches || recentMatches.length === 0) && (
              <div className="flex flex-col items-center py-8">
                <Trophy className="w-8 h-8 text-[var(--text-muted)]/50 mb-2" />
                <p className="text-sm text-[var(--text-muted)]">No matches yet</p>
              </div>
            )}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
