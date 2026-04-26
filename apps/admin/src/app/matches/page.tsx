export const dynamic = 'force-dynamic';
import { createAdminClient } from '@/lib/supabase-server';
import { Card, Badge } from '@badminton/ui';
import { MATCH_FORMAT_LABELS, formatDateTime } from '@badminton/shared';
import { MatchActions } from './actions';
import { CreateMatchForm } from './create-match';
import {
  Target,
  Plus,
  AlertTriangle,
  Clock,
  ArrowUp,
  ArrowDown,
  Minus,
  Inbox,
} from 'lucide-react';

export default async function MatchesPage() {
  const supabase = createAdminClient();

  // Round 1: matches + active player roster fetch in parallel (independent).
  const [
    { data: matches },
    { data: allPlayers },
  ] = await Promise.all([
    supabase
      .from('matches')
      .select('*, match_participants(*, player:players(full_name)), match_games(*)')
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('players')
      .select('id, full_name')
      .eq('active_flag', true)
      .neq('status', 'pending_approval')
      .order('full_name'),
  ]);

  // Round 2: disputes + walkovers depend on the match list, but can fetch in
  // parallel with each other.
  const matchIds = matches?.map(m => m.id) || [];
  const challengeIds = matches?.map(m => m.challenge_id).filter(Boolean) || [];
  const [
    { data: disputes },
    { data: walkovers },
  ] = await Promise.all([
    supabase
      .from('disputes')
      .select('*, opener:players!disputes_opened_by_fkey(full_name)')
      .in('match_id', matchIds.length > 0 ? matchIds : ['00000000-0000-0000-0000-000000000000']),
    supabase
      .from('walkovers')
      .select('*, forfeit:players!walkovers_forfeit_player_id_fkey(full_name)')
      .in('challenge_id', challengeIds.length > 0 ? challengeIds : ['00000000-0000-0000-0000-000000000000']),
  ]);

  const disputesByMatch = new Map<string, typeof disputes>();
  disputes?.forEach(d => {
    const existing = disputesByMatch.get(d.match_id) || [];
    existing.push(d);
    disputesByMatch.set(d.match_id, existing);
  });

  const walkoversByChallenge = new Map<string, typeof walkovers>();
  walkovers?.forEach(w => {
    const existing = walkoversByChallenge.get(w.challenge_id) || [];
    existing.push(w);
    walkoversByChallenge.set(w.challenge_id, existing);
  });

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-[var(--ds-accent)]/10 text-[var(--ds-accent)]">
            <Target className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-3xl font-bold font-display text-[var(--text-primary)]">MATCHES</h1>
            <p className="text-sm text-[var(--text-muted)] mt-0.5">
              Manage match results, disputes, and walkovers
            </p>
          </div>
        </div>
        <CreateMatchForm players={allPlayers || []} />
      </div>

      {/* Matches Table */}
      <Card padding={false}>
        <div className="overflow-x-auto">
          {(!matches || matches.length === 0) ? (
            <div className="flex flex-col items-center justify-center py-20 px-6 text-center">
              <div className="flex items-center justify-center w-14 h-14 rounded-full bg-[var(--border-hover)] mb-4">
                <Inbox className="w-7 h-7 text-[var(--text-muted)]" />
              </div>
              <h3 className="text-base font-semibold text-[var(--text-primary)] mb-1">No matches yet</h3>
              <p className="text-sm text-[var(--text-muted)] max-w-sm">
                Matches will appear here once players start competing. Create a new match to get started.
              </p>
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b-2 border-[var(--border)]">
                  <th className="px-5 py-4 text-left text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Players</th>
                  <th className="px-5 py-4 text-left text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Score</th>
                  <th className="px-5 py-4 text-left text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Type</th>
                  <th className="px-5 py-4 text-left text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Format</th>
                  <th className="px-5 py-4 text-left text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Elo</th>
                  <th className="px-5 py-4 text-left text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Status</th>
                  <th className="px-5 py-4 text-left text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Date</th>
                  <th className="px-5 py-4 text-right text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {matches?.map((m) => {
                  const sideA = m.match_participants?.filter((p: Record<string, unknown>) => p.team_side === 'a') || [];
                  const sideB = m.match_participants?.filter((p: Record<string, unknown>) => p.team_side === 'b') || [];
                  const matchDisputes = disputesByMatch.get(m.id) || [];
                  const matchWalkovers = m.challenge_id ? walkoversByChallenge.get(m.challenge_id) || [] : [];
                  const hasIssues = matchDisputes.length > 0 || matchWalkovers.length > 0;

                  return (
                    <tr
                      key={m.id}
                      className="transition-colors duration-150 hover:bg-[var(--border-hover)]"
                    >
                      <td className="px-5 py-4">
                        <div className="text-sm">
                          <span className={m.winner_side === 'a' ? 'text-[var(--color-success)] font-semibold' : 'text-[var(--text-secondary)]'}>
                            {sideA.map((p: Record<string, unknown>) => ((p.player as Record<string, unknown>)?.full_name as string)).join(' & ')}
                          </span>
                          <span className="text-[var(--text-muted)] mx-2 text-xs font-medium uppercase">vs</span>
                          <span className={m.winner_side === 'b' ? 'text-[var(--color-success)] font-semibold' : 'text-[var(--text-secondary)]'}>
                            {sideB.map((p: Record<string, unknown>) => ((p.player as Record<string, unknown>)?.full_name as string)).join(' & ')}
                          </span>
                        </div>

                        {/* Disputes inline */}
                        {matchDisputes.length > 0 && (
                          <div className="mt-2 space-y-1">
                            {matchDisputes.map((d: Record<string, unknown>) => (
                              <div
                                key={d.id as string}
                                className="flex items-start gap-1.5 text-xs rounded-md px-2.5 py-1.5 border-l-2 border-[var(--color-danger)] bg-[var(--color-danger)]/5"
                              >
                                <AlertTriangle className="w-3.5 h-3.5 text-[var(--color-danger)] mt-0.5 shrink-0" />
                                <span className="text-[var(--color-danger)]">
                                  <span className="font-medium">Dispute ({d.status as string})</span>: {d.reason_category as string} — {d.description as string}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Walkovers inline */}
                        {matchWalkovers.length > 0 && (
                          <div className="mt-2 space-y-1">
                            {matchWalkovers.map((w: Record<string, unknown>) => (
                              <div
                                key={w.id as string}
                                className="flex items-start gap-1.5 text-xs rounded-md px-2.5 py-1.5 border-l-2 border-[var(--color-warning)] bg-[var(--color-warning)]/5"
                              >
                                <Clock className="w-3.5 h-3.5 text-[var(--color-warning)] mt-0.5 shrink-0" />
                                <span className="text-[var(--color-warning)]">
                                  <span className="font-medium">Walkover ({w.walkover_type as string})</span>: {((w.forfeit as Record<string, unknown>)?.full_name as string)} — {w.status as string}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-4 font-mono text-sm font-medium text-[var(--text-primary)]">
                        {m.score_summary || <span className="text-[var(--text-muted)]">-</span>}
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-1.5">
                          <Badge variant={m.rated_flag ? 'warning' : 'neutral'}>
                            {m.rated_flag ? 'Rated' : 'Casual'}
                          </Badge>
                          <span className="text-xs text-[var(--text-muted)]">{m.match_type}</span>
                        </div>
                      </td>
                      <td className="px-5 py-4 text-sm text-[var(--text-muted)]">
                        {MATCH_FORMAT_LABELS[m.format as keyof typeof MATCH_FORMAT_LABELS]}
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex flex-col gap-1">
                          {m.match_participants?.map((p: Record<string, unknown>) => {
                            const delta = p.rating_delta as number;
                            const hasDelta = delta !== null && delta !== undefined;
                            const isPositive = hasDelta && delta > 0;
                            const isNegative = hasDelta && delta < 0;

                            return (
                              <span
                                key={p.id as string}
                                className={`inline-flex items-center gap-0.5 text-xs font-mono font-medium ${
                                  isPositive ? 'text-[var(--color-success)]' :
                                  isNegative ? 'text-[var(--color-danger)]' : 'text-[var(--text-muted)]'
                                }`}
                              >
                                {hasDelta ? (
                                  <>
                                    {isPositive && <ArrowUp className="w-3 h-3" />}
                                    {isNegative && <ArrowDown className="w-3 h-3" />}
                                    {!isPositive && !isNegative && <Minus className="w-3 h-3" />}
                                    {isPositive ? '+' : ''}{delta}
                                  </>
                                ) : (
                                  '-'
                                )}
                              </span>
                            );
                          })}
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <Badge
                          variant={
                            m.result_status === 'confirmed' ? 'success' :
                            m.result_status === 'disputed' ? 'danger' :
                            m.result_status === 'voided' ? 'neutral' :
                            'warning'
                          }
                        >
                          {m.result_status}
                        </Badge>
                      </td>
                      <td className="px-5 py-4 text-sm text-[var(--text-muted)]">
                        {m.played_at ? formatDateTime(m.played_at) : '-'}
                      </td>
                      <td className="px-5 py-4 text-right">
                        {m.result_status !== 'voided' && (
                          <MatchActions matchId={m.id} resultStatus={m.result_status} />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </div>
  );
}
