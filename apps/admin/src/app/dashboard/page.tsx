export const dynamic = 'force-dynamic';
import { createAdminClient } from '@/lib/supabase-server';
import { Badge, Avatar } from '@badminton/ui';
import { PLAYER_STATUS_LABELS } from '@badminton/shared';
import Link from 'next/link';
import {
  Users,
  UserCheck,
  AlertTriangle,
  Clock,
  Swords,
  ArrowUpRight,
  Trophy,
} from 'lucide-react';
import { ApproveButtons } from './approve-buttons';

export default async function DashboardPage() {
  const supabase = createAdminClient();

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
    supabase.from('players').select('id', { count: 'exact', head: true }).neq('status', 'pending_approval'),
    supabase.from('players').select('id', { count: 'exact', head: true }).eq('status', 'pending_approval'),
    supabase.from('disputes').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    supabase.from('walkovers').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('matches').select('id, score_summary, played_at, match_type, format, created_at, result_status, match_participants(player_id, win_flag, rating_delta, player:players(full_name))').order('created_at', { ascending: false }).limit(5),
    supabase.from('tournaments').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('challenges').select('id', { count: 'exact', head: true }).in('status', ['proposed', 'partially_confirmed', 'accepted']),
    supabase
      .from('players')
      .select('id, full_name, email, avatar_url, created_at')
      .eq('status', 'pending_approval')
      .order('created_at', { ascending: false })
      .limit(10),
  ]);

  const hasAlerts = (pendingPlayers ?? 0) > 0 || (openDisputes ?? 0) > 0 || (pendingWalkovers ?? 0) > 0;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold font-display text-[var(--text-primary)] tracking-wide">DASHBOARD</h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">Overview of club activity and action items</p>
      </div>

      {/* Alert Banner */}
      {hasAlerts && (
        <div className="rounded-xl border border-[var(--color-warning)]/20 bg-[var(--color-warning)]/5 p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-[var(--color-warning)]/10 flex items-center justify-center flex-shrink-0">
            <AlertTriangle className="w-5 h-5 text-[var(--color-warning)]" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-medium text-[var(--text-primary)]">Items need your attention</p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              {[
                pendingPlayers && pendingPlayers > 0 ? `${pendingPlayers} pending approval${pendingPlayers > 1 ? 's' : ''}` : null,
                openDisputes && openDisputes > 0 ? `${openDisputes} open dispute${openDisputes > 1 ? 's' : ''}` : null,
                pendingWalkovers && pendingWalkovers > 0 ? `${pendingWalkovers} pending walkover${pendingWalkovers > 1 ? 's' : ''}` : null,
              ].filter(Boolean).join(' · ')}
            </p>
          </div>
        </div>
      )}

      {/* Pending Players */}
      {pendingPlayersList && pendingPlayersList.length > 0 && (
        <div className="rounded-xl border border-[var(--color-warning)]/20 bg-[var(--bg-card)] overflow-hidden">
          <div className="px-5 py-4 border-b border-[var(--border)] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <UserCheck className="w-4 h-4 text-[var(--color-warning)]" />
              <h2 className="text-sm font-semibold text-[var(--text-primary)] uppercase tracking-wide">Pending Approvals</h2>
              <span className="text-xs bg-[var(--color-warning)]/10 text-[var(--color-warning)] px-2 py-0.5 rounded-full font-medium">{pendingPlayersList.length}</span>
            </div>
            <Link href="/players?tab=attention" className="text-xs text-[var(--ds-accent)] hover:underline flex items-center gap-1">
              View All <ArrowUpRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="divide-y divide-[var(--border)]">
            {pendingPlayersList.map((player) => (
              <div key={player.id} className="px-5 py-3 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <Avatar src={player.avatar_url} name={player.full_name} size="sm" />
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

      {/* Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Link href="/players" className="group">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-5 hover:border-[var(--border-hover)] transition-all hover:shadow-lg hover:shadow-black/5">
            <div className="flex items-center justify-between mb-3">
              <div className="w-10 h-10 rounded-lg bg-[var(--color-info)]/10 flex items-center justify-center">
                <Users className="w-5 h-5 text-[var(--color-info)]" />
              </div>
              <ArrowUpRight className="w-4 h-4 text-[var(--text-muted)] opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
            <p className="text-2xl font-bold font-mono text-[var(--text-primary)]">{totalPlayers ?? 0}</p>
            <p className="text-xs text-[var(--text-muted)] mt-1">Active Players</p>
          </div>
        </Link>

        <Link href="/players?tab=attention" className="group">
          <div className={`rounded-xl border p-5 transition-all hover:shadow-lg hover:shadow-black/5 ${
            (pendingPlayers ?? 0) > 0
              ? 'border-[var(--color-warning)]/30 bg-[var(--color-warning)]/5 hover:border-[var(--color-warning)]/50'
              : 'border-[var(--border)] bg-[var(--bg-card)] hover:border-[var(--border-hover)]'
          }`}>
            <div className="flex items-center justify-between mb-3">
              <div className="w-10 h-10 rounded-lg bg-[var(--color-warning)]/10 flex items-center justify-center">
                <UserCheck className="w-5 h-5 text-[var(--color-warning)]" />
              </div>
              <ArrowUpRight className="w-4 h-4 text-[var(--text-muted)] opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
            <p className="text-2xl font-bold font-mono text-[var(--text-primary)]">{pendingPlayers ?? 0}</p>
            <p className="text-xs text-[var(--text-muted)] mt-1">Pending Approvals</p>
          </div>
        </Link>

        <Link href="/disputes" className="group">
          <div className={`rounded-xl border p-5 transition-all hover:shadow-lg hover:shadow-black/5 ${
            (openDisputes ?? 0) > 0
              ? 'border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 hover:border-[var(--color-danger)]/50'
              : 'border-[var(--border)] bg-[var(--bg-card)] hover:border-[var(--border-hover)]'
          }`}>
            <div className="flex items-center justify-between mb-3">
              <div className="w-10 h-10 rounded-lg bg-[var(--color-danger)]/10 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-[var(--color-danger)]" />
              </div>
              <ArrowUpRight className="w-4 h-4 text-[var(--text-muted)] opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
            <p className="text-2xl font-bold font-mono text-[var(--text-primary)]">{openDisputes ?? 0}</p>
            <p className="text-xs text-[var(--text-muted)] mt-1">Open Disputes</p>
          </div>
        </Link>

        <Link href="/walkovers" className="group">
          <div className={`rounded-xl border p-5 transition-all hover:shadow-lg hover:shadow-black/5 ${
            (pendingWalkovers ?? 0) > 0
              ? 'border-[var(--color-warning)]/30 bg-[var(--color-warning)]/5 hover:border-[var(--color-warning)]/50'
              : 'border-[var(--border)] bg-[var(--bg-card)] hover:border-[var(--border-hover)]'
          }`}>
            <div className="flex items-center justify-between mb-3">
              <div className="w-10 h-10 rounded-lg bg-[var(--color-warning)]/10 flex items-center justify-center">
                <Clock className="w-5 h-5 text-[var(--color-warning)]" />
              </div>
              <ArrowUpRight className="w-4 h-4 text-[var(--text-muted)] opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
            <p className="text-2xl font-bold font-mono text-[var(--text-primary)]">{pendingWalkovers ?? 0}</p>
            <p className="text-xs text-[var(--text-muted)] mt-1">Pending Walkovers</p>
          </div>
        </Link>
      </div>

      {/* Two Column Section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Active Tournaments */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Trophy className="w-4 h-4 text-[var(--text-muted)]" />
              <h2 className="text-sm font-semibold text-[var(--text-primary)] uppercase tracking-wide">Tournaments</h2>
            </div>
            <Link href="/tournaments" className="text-xs text-[var(--ds-accent)] hover:underline flex items-center gap-1">
              Manage <ArrowUpRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="flex items-end gap-2">
            <p className="text-4xl font-bold font-mono text-[var(--text-primary)]">{activeTournaments ?? 0}</p>
            <p className="text-sm text-[var(--text-muted)] mb-1">active</p>
          </div>
        </div>

        {/* Active Challenges */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Swords className="w-4 h-4 text-[var(--text-muted)]" />
              <h2 className="text-sm font-semibold text-[var(--text-primary)] uppercase tracking-wide">Active Challenges</h2>
            </div>
            <Link href="/challenges" className="text-xs text-[var(--ds-accent)] hover:underline flex items-center gap-1">
              View All <ArrowUpRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="flex items-end gap-2">
            <p className="text-4xl font-bold font-mono text-[var(--text-primary)]">{activeChalls ?? 0}</p>
            <p className="text-sm text-[var(--text-muted)] mb-1">active</p>
          </div>
        </div>
      </div>

      {/* Recent Matches */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)]">
        <div className="flex items-center justify-between p-6 pb-4">
          <div className="flex items-center gap-2">
            <Trophy className="w-4 h-4 text-[var(--text-muted)]" />
            <h2 className="text-sm font-semibold text-[var(--text-primary)] uppercase tracking-wide">Recent Matches</h2>
          </div>
          <Link href="/matches" className="text-xs text-[var(--ds-accent)] hover:underline flex items-center gap-1">
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
