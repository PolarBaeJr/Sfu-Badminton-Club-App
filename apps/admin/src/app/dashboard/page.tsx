export const dynamic = 'force-dynamic';
import { createAdminClient, getAuthenticatedExecOrAdmin } from '@/lib/supabase-server';
import { accessLevelFor, canAccess } from '@/lib/permissions';
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

export default async function DashboardPage() {
  const supabase = createAdminClient();

  // The dashboard links into every other section, so it has to answer the same
  // question the sidebar and middleware answer — through the SAME helper, not a
  // hand-kept second list. An exec used to see tiles for disputes, walkovers,
  // fees and challenges, every one of which bounced them to /unauthorized.
  const viewer = await getAuthenticatedExecOrAdmin();
  const level = accessLevelFor(viewer);
  const showPlayers = canAccess(level, '/players');
  const showDisputes = canAccess(level, '/disputes');
  const showWalkovers = canAccess(level, '/walkovers');
  const showChallenges = canAccess(level, '/challenges');
  const showFees = canAccess(level, '/fees');

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
    showPlayers ? supabase.from('players').select('id', { count: 'exact', head: true }).eq('status', 'pending_approval') : noCount,
    showDisputes ? supabase.from('disputes').select('id', { count: 'exact', head: true }).eq('status', 'open') : noCount,
    showWalkovers ? supabase.from('walkovers').select('id', { count: 'exact', head: true }).eq('status', 'pending') : noCount,
    supabase.from('matches').select('id, score_summary, played_at, match_type, format, created_at, result_status, match_participants(player_id, team_side, win_flag, rating_delta, player:players(full_name))').order('created_at', { ascending: false }).limit(5),
    supabase.from('tournaments').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    showChallenges ? supabase.from('challenges').select('id', { count: 'exact', head: true }).in('status', ['proposed', 'partially_confirmed', 'accepted']) : noCount,
    showPlayers
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
    showPlayers && pendingPlayers && pendingPlayers > 0 ? `${pendingPlayers} pending approval${pendingPlayers > 1 ? 's' : ''}` : null,
    showDisputes && openDisputes && openDisputes > 0 ? `${openDisputes} open dispute${openDisputes > 1 ? 's' : ''}` : null,
    showWalkovers && pendingWalkovers && pendingWalkovers > 0 ? `${pendingWalkovers} pending walkover${pendingWalkovers > 1 ? 's' : ''}` : null,
  ].filter(Boolean);
  const hasAlerts = alertTerms.length > 0;

  // Finance snapshot: club-fee income collected for the active season so far.
  // Admin-only — /fees is, and this is the same ledger.
  let activeSeason: { id: string; name: string } | null = null;
  let seasonIncomeCents = 0;
  if (showFees) {
    const { data } = await supabase
      .from('seasons')
      .select('id, name')
      .eq('active_flag', true)
      .maybeSingle();
    activeSeason = data;
    if (activeSeason) {
      const { data: paidFees } = await supabase
        .from('club_fees')
        .select('amount_cents')
        .eq('season_id', activeSeason.id)
        .not('paid_at', 'is', null);
      seasonIncomeCents = (paidFees ?? []).reduce((s, f) => s + (f.amount_cents ?? 0), 0);
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
          takes getExecOrAdmin(), so the buttons here work for both. */}
      {showPlayers && pendingPlayersList && pendingPlayersList.length > 0 && (
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
          <>
            <Link href="/players" className="hover:bg-[var(--bg-card)] transition-colors">
              <p className="stat-label">Active Players</p>
              <p className="stat-value">{totalPlayers ?? 0}</p>
            </Link>
            <Link href="/players?tab=attention" className="hover:bg-[var(--bg-card)] transition-colors">
              <p className="stat-label">Pending Approvals</p>
              <p className={`stat-value ${(pendingPlayers ?? 0) > 0 ? 'text-[var(--color-warning)]' : ''}`}>{pendingPlayers ?? 0}</p>
            </Link>
          </>
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

      {/* Finance snapshot — active-season income (expenses tracking to follow) */}
      {showFees && activeSeason && (
        <Link href="/fees" className="group block">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-5 hover:border-[var(--border-hover)] transition-all hover:shadow-lg hover:shadow-black/5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[var(--text-muted)] uppercase">{activeSeason.name} · Income collected</p>
              <p className="text-3xl font-bold font-mono text-[var(--text-primary)] mt-1">${(seasonIncomeCents / 100).toFixed(2)}</p>
            </div>
            <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
              Manage fees <ArrowUpRight className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          </div>
        </Link>
      )}

      {/* Two Column Section. Collapses to one column when Challenges is hidden,
          so an exec gets a full-width Tournaments card rather than a half-width
          one floating beside a gap. */}
      <div className={`grid grid-cols-1 gap-6 ${showChallenges ? 'lg:grid-cols-2' : ''}`}>
        {/* Active Tournaments */}
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

      {/* Recent Matches */}
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
    </div>
  );
}
