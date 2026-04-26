import { createAdminClient } from '@/lib/supabase-server';
import { Card, Badge, StatCard, Avatar } from '@badminton/ui';
import { PLAYER_STATUS_LABELS, MATCH_FORMAT_LABELS, getWinRate, getStreakDisplay, getPointDifferential } from '@badminton/shared';
import { PlayerEditForm } from './edit-form';
import { notFound } from 'next/navigation';
import { ArrowLeft, Shield, Target, Trophy, Swords, TrendingUp, Flame, FileText, AlertTriangle, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import Link from 'next/link';

export default async function PlayerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = createAdminClient();

  const [
    { data: player },
    { data: rating },
    { data: reliability },
    { data: recentMatches },
    { data: varsityNotes },
  ] = await Promise.all([
    supabase.from('players').select('*').eq('id', id).single(),
    supabase.from('ratings').select('*').eq('player_id', id).single(),
    supabase.from('reliability_metrics').select('*').eq('player_id', id).single(),
    supabase.from('match_participants')
      .select('*, match:matches(*, match_games(*))')
      .eq('player_id', id)
      .order('created_at', { ascending: false, referencedTable: 'matches' })
      .limit(10),
    supabase.from('varsity_notes').select('*, author:players!varsity_notes_author_id_fkey(full_name)').eq('player_id', id).order('created_at', { ascending: false }),
  ]);

  if (!player) notFound();

  const r = rating;

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link href="/players" className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--ds-accent)] transition-colors">
        <ArrowLeft className="w-4 h-4" />
        Back to Players
      </Link>

      {/* Header */}
      <div className="flex items-center gap-4">
        <Avatar name={player.full_name} size="lg" />
        <div>
          <h1 className="text-3xl font-bold font-display text-[var(--text-primary)]">{player.full_name}</h1>
          <p className="text-sm text-[var(--text-muted)]">{player.email}</p>
          <div className="flex gap-2 mt-2">
            <Badge variant={player.status === 'competitive' ? 'success' : player.status === 'suspended' ? 'danger' : 'default'}>
              {PLAYER_STATUS_LABELS[player.status as keyof typeof PLAYER_STATUS_LABELS]}
            </Badge>
            <Badge variant="neutral">
              <Shield className="w-3 h-3 inline mr-1" />
              {player.role}
            </Badge>
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      {r && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-4 gap-4">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
            <div className="flex items-center gap-2 mb-2">
              <Target className="w-4 h-4 text-[var(--ds-accent)]" />
              <span className="text-xs text-[var(--text-muted)] uppercase">Singles Elo</span>
            </div>
            <p className="text-2xl font-bold font-mono text-[var(--text-primary)]">{r.singles_elo}</p>
            <p className="text-xs text-[var(--text-muted)] mt-1">{r.singles_provisional ? 'Provisional' : 'Established'} · {r.singles_wins}W-{r.singles_losses}L ({getWinRate(r.singles_wins, r.singles_losses)})</p>
          </div>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
            <div className="flex items-center gap-2 mb-2">
              <Swords className="w-4 h-4 text-[var(--color-info)]" />
              <span className="text-xs text-[var(--text-muted)] uppercase">Doubles Elo</span>
            </div>
            <p className="text-2xl font-bold font-mono text-[var(--text-primary)]">{r.doubles_elo}</p>
            <p className="text-xs text-[var(--text-muted)] mt-1">{r.doubles_provisional ? 'Provisional' : 'Established'} · {r.doubles_wins}W-{r.doubles_losses}L ({getWinRate(r.doubles_wins, r.doubles_losses)})</p>
          </div>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
            <div className="flex items-center gap-2 mb-2">
              <Flame className="w-4 h-4 text-[var(--color-warning)]" />
              <span className="text-xs text-[var(--text-muted)] uppercase">Streaks</span>
            </div>
            <p className="text-2xl font-bold font-mono text-[var(--text-primary)]">{getStreakDisplay(r.current_singles_streak)}</p>
            <p className="text-xs text-[var(--text-muted)] mt-1">Singles · Best: {r.best_singles_streak}</p>
          </div>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="w-4 h-4 text-[var(--color-success)]" />
              <span className="text-xs text-[var(--text-muted)] uppercase">Point Diff</span>
            </div>
            <p className="text-2xl font-bold font-mono text-[var(--text-primary)]">{getPointDifferential(r.singles_points_scored, r.singles_points_allowed)}</p>
            <p className="text-xs text-[var(--text-muted)] mt-1">Singles · D: {getPointDifferential(r.doubles_points_scored, r.doubles_points_allowed)}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Edit Form */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6">
          <h2 className="text-base font-semibold text-[var(--text-primary)] mb-4">Edit Player</h2>
          <PlayerEditForm player={player} rating={r} />
        </div>

        {/* Reliability */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6">
          <div className="flex items-center gap-2 mb-4">
            <Shield className="w-4 h-4 text-[var(--text-muted)]" />
            <h2 className="text-base font-semibold text-[var(--text-primary)]">Reliability</h2>
          </div>
          {reliability ? (
            <div className="space-y-3">
              {[
                { label: 'Challenges Issued', value: reliability.challenges_issued },
                { label: 'Matches Completed', value: reliability.matches_completed },
                { label: 'No-Shows', value: reliability.no_shows, danger: reliability.no_shows > 0 },
                { label: 'Late Cancellations', value: reliability.late_cancellations },
                { label: 'Dispute Involvement', value: reliability.dispute_involvement_count },
              ].map(({ label, value, danger }) => (
                <div key={label} className="flex justify-between items-center p-2 rounded-lg bg-[var(--bg-elevated)]">
                  <span className="text-sm text-[var(--text-muted)]">{label}</span>
                  <span className={`text-sm font-mono font-medium ${danger ? 'text-[var(--color-danger)]' : 'text-[var(--text-primary)]'}`}>{value}</span>
                </div>
              ))}
              {reliability.walkover_flag && (
                <div className="flex items-center gap-2 p-2 rounded-lg bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/20">
                  <AlertTriangle className="w-4 h-4 text-[var(--color-danger)]" />
                  <span className="text-sm font-medium text-[var(--color-danger)]">Flagged for No-Shows</span>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-[var(--text-muted)]">No reliability data</p>
          )}
        </div>

        {/* Varsity Notes */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6">
          <div className="flex items-center gap-2 mb-4">
            <FileText className="w-4 h-4 text-[var(--text-muted)]" />
            <h2 className="text-base font-semibold text-[var(--text-primary)]">Varsity Notes</h2>
          </div>
          <div className="space-y-3">
            {varsityNotes?.map((note) => (
              <div key={note.id} className="p-3 bg-[var(--bg-elevated)] rounded-lg border border-[var(--border)]">
                <p className="text-sm text-[var(--text-secondary)]">{note.note}</p>
                <p className="text-xs text-[var(--text-muted)] mt-2">
                  {(note.author as Record<string, unknown>)?.full_name as string} &middot; {new Date(note.created_at).toLocaleDateString()}
                </p>
              </div>
            ))}
            {(!varsityNotes || varsityNotes.length === 0) && (
              <p className="text-sm text-[var(--text-muted)]">No notes</p>
            )}
          </div>
        </div>
      </div>

      {/* Recent Matches */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)]">
        <div className="flex items-center gap-2 p-6 pb-4">
          <Trophy className="w-4 h-4 text-[var(--text-muted)]" />
          <h2 className="text-base font-semibold text-[var(--text-primary)]">Recent Matches</h2>
        </div>
        <div className="px-6 pb-6 space-y-1">
          {recentMatches?.map((mp) => {
            const m = mp.match as Record<string, unknown> | null;
            if (!m) return null;
            return (
              <div key={mp.id} className="flex items-center justify-between py-3 border-b border-[var(--border)] last:border-0 hover:bg-white/[0.02] -mx-3 px-3 rounded-lg transition-colors">
                <div className="flex items-center gap-3">
                  <Badge variant={mp.win_flag ? 'success' : 'danger'}>
                    {mp.win_flag ? 'W' : 'L'}
                  </Badge>
                  <span className="text-sm text-[var(--text-secondary)]">{m.score_summary as string || '-'}</span>
                  <Badge variant="neutral">{MATCH_FORMAT_LABELS[(m.format as string) as keyof typeof MATCH_FORMAT_LABELS] || m.format as string}</Badge>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm">
                    {mp.rating_delta !== null && mp.rating_delta !== undefined ? (
                      <span className={`flex items-center gap-0.5 ${mp.rating_delta >= 0 ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`}>
                        {mp.rating_delta >= 0 ? <ArrowUpRight className="w-3.5 h-3.5" /> : <ArrowDownRight className="w-3.5 h-3.5" />}
                        {mp.rating_delta >= 0 ? '+' : ''}{mp.rating_delta}
                      </span>
                    ) : '-'}
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">
                    {m.played_at ? new Date(m.played_at as string).toLocaleDateString() : ''}
                  </span>
                </div>
              </div>
            );
          })}
          {(!recentMatches || recentMatches.length === 0) && (
            <p className="text-sm text-[var(--text-muted)] py-4 text-center">No matches</p>
          )}
        </div>
      </div>
    </div>
  );
}
