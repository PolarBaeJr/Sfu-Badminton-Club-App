import { createAdminClient, getAuthenticatedConsoleUser } from '@/lib/supabase-server';
import { accessLevelFor, permits, UNRESTRICTED } from '@/lib/permissions';
import { Card, Badge, StatCard, AvatarChip, PageHeader } from '@badminton/ui';
import { PLAYER_STATUS_LABELS, MATCH_FORMAT_LABELS, TOURNAMENT_EVENT_TYPE_LABELS, getWinRate, getStreakDisplay, getPointDifferential } from '@badminton/shared';
import { PlayerEditForm } from './edit-form';
import { VarsityNotes } from './varsity-notes';
import { ReliabilityEditor } from './reliability-editor';
import { CancelDeletionButton } from './cancel-deletion-button';
import { RequireWaiverResignatureButton } from './require-waiver-resignature-button';
import { notFound } from 'next/navigation';
import { ArrowLeft, Shield, Target, Trophy, Swords, TrendingUp, Flame, FileText, AlertTriangle, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import Link from 'next/link';
import { SeasonPicker } from './season-picker';

export default async function PlayerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ season?: string }>;
}) {
  const { id } = await params;
  const { season: seasonParam } = await searchParams;
  // Execs manage this page; privilege, account lifecycle, the legal
  // re-signature gate and reliability counters stay with admins.
  //
  // A varsity trainer sees the same page with everything writable removed
  // EXCEPT the varsity notes panel — which is the only reason they are here.
  const viewer = await getAuthenticatedConsoleUser();
  const level = accessLevelFor(viewer);
  const isAdmin = level === 'admin';
  // Ask for the capability the edit form's Save invokes, not for a level —
  // anyone holding only players.read sees this page exactly as a trainer does,
  // read-only. Same reasoning as /players itself.
  const canManage = permits(level, UNRESTRICTED, 'players.update.write');
  const supabase = createAdminClient();

  // Which season this page is showing. Defaults to the active one; ?season=
  // overrides it so a particular season's view is a shareable link.
  const { data: seasons } = await supabase
    .from('seasons')
    .select('id, term, year, active_flag, start_date, end_date')
    .order('year', { ascending: false })
    .order('term');
  const seasonList = seasons ?? [];
  const selectedSeason =
    seasonList.find((s) => s.id === seasonParam)
    ?? seasonList.find((s) => s.active_flag)
    ?? seasonList[0]
    ?? null;
  const seasonId = selectedSeason?.id ?? null;
  const isActiveSeason = Boolean(selectedSeason?.active_flag);

  const [
    { data: player },
    { data: rating },
    { data: reliability },
    { data: recentMatches },
    { data: varsityNotes },
    { data: walkoverEvents },
    { data: tournamentNoShows },
  ] = await Promise.all([
    supabase.from('players').select('*').eq('id', id).single(),
    supabase.from('ratings').select('*').eq('player_id', id).single(),
    supabase.from('reliability_metrics').select('*').eq('player_id', id).maybeSingle(),
    // !inner so the season filter on the embedded matches row actually
    // excludes the participant row rather than just nulling the embed.
    supabase.from('match_participants')
      .select('*, match:matches!inner(*, match_games(*))')
      .eq('player_id', id)
      .eq('matches.season_id', seasonId ?? '')
      .order('created_at', { ascending: false, referencedTable: 'matches' })
      .limit(10),
    supabase.from('varsity_notes').select('*, author:players!varsity_notes_author_id_fkey(full_name)').eq('player_id', id).order('created_at', { ascending: false }),
    // walkovers carries no season_id and reaches a match only through the
    // challenge, which has none either — so it is scoped by date against the
    // season window instead of a two-hop embed filter.
    supabase.from('walkovers')
      .select('id, walkover_type, notice_hours, reported_at, status, admin_notes, challenge:challenges(type), reporter:players!walkovers_reported_by_fkey(full_name)')
      .eq('forfeit_player_id', id)
      .gte('reported_at', selectedSeason?.start_date ?? '1970-01-01')
      .lte('reported_at', selectedSeason?.end_date ?? '2999-12-31')
      .order('reported_at', { ascending: false }),
    supabase.from('tournament_participants')
      .select('id, status, event:tournament_events!inner(event_type, tournament:tournaments!inner(name, season_id))')
      .eq('player_id', id)
      .eq('tournament_events.tournaments.season_id', seasonId ?? '')
      .eq('status', 'no_show'),
  ]);

  if (!player) notFound();

  // ratings holds ONE cumulative Elo with no season dimension, so it is only
  // the right answer for the season currently running. For a past season the
  // archived snapshot is what that season actually ended on; showing today's
  // live rating under a 2024 heading would be plainly wrong.
  let r = rating;
  if (!isActiveSeason && seasonId) {
    const { data: archived } = await supabase
      .from('season_final_ratings')
      .select('singles_elo, doubles_elo')
      .eq('player_id', id)
      .eq('season_id', seasonId)
      .maybeSingle();
    // No snapshot means the player did not finish that season — null rather
    // than falling back to the live rating, which would silently misattribute
    // their current standing to a season they were not in.
    r = archived ? ({ ...rating, ...archived } as typeof rating) : null;
  }

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link href="/players" className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--color-accent)] transition-colors">
        <ArrowLeft className="w-4 h-4" />
        Back to Players
      </Link>

      {/* Header */}
      <div className="flex items-center gap-4">
        <AvatarChip name={player.full_name} size="lg" id={player.id} />
        <PageHeader
          className="no-period flex-1 !mb-0"
          title={player.full_name}
          sub={
            <>
              {player.email}
              <span className="flex gap-2 mt-2">
                <Badge variant={player.status === 'competitive' ? 'success' : player.status === 'suspended' ? 'danger' : 'default'}>
                  {PLAYER_STATUS_LABELS[player.status as keyof typeof PLAYER_STATUS_LABELS]}
                </Badge>
                <Badge variant="neutral">
                  <Shield className="w-3 h-3 inline mr-1" />
                  {player.role}
                </Badge>
                {player.is_exec && <Badge variant="info">Exec</Badge>}
                {player.is_trainer && <Badge variant="info">Trainer</Badge>}
              </span>
            </>
          }
        />
      </div>

      {/* Season switcher. Everything below is scoped to this season EXCEPT
          varsity notes and reliability — those are a player's standing record
          and follow them across seasons. */}
      <div className="flex items-end justify-between gap-4">
        <SeasonPicker seasons={seasonList} selectedId={seasonId} />
        {!isActiveSeason && (
          <p className="text-xs text-[var(--text-muted)]">
            Viewing a past season. Ratings shown are that season&apos;s final archived values.
          </p>
        )}
      </div>

      {/* Pending self-service account deletion */}
      {player.deletion_requested_at && (
        <div className="flex items-center justify-between gap-3 p-4 rounded-xl bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/20">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-[var(--color-danger)] shrink-0" />
            <p className="text-sm text-[var(--color-danger)]">
              Deletion requested {new Date(player.deletion_requested_at).toLocaleDateString()} — permanently anonymized on{' '}
              {new Date(new Date(player.deletion_requested_at).getTime() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString()}.
            </p>
          </div>
          {isAdmin && <CancelDeletionButton playerId={player.id} />}
        </div>
      )}

      {/* Stats Grid */}
      {r && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-4 gap-4">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
            <div className="flex items-center gap-2 mb-2">
              <Target className="w-4 h-4 text-[var(--color-accent)]" />
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

      {/* Two columns for a trainer (no edit form), three for everyone else. */}
      <div className={`grid grid-cols-1 gap-6 ${canManage ? 'lg:grid-cols-3' : 'lg:grid-cols-2'}`}>
        {/* Edit Form. Dropped entirely for a trainer: updatePlayer asks for
            players.update.write, so every control in it — status, membership,
            the reason box, Save — would reject them. */}
        {canManage && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6">
          <h2 className="text-base font-semibold text-[var(--text-primary)] mb-4">Edit Player</h2>
          <PlayerEditForm player={player} rating={r} isAdmin={isAdmin} />
          {isAdmin && (
            <div className="mt-4 pt-4 border-t border-[var(--border)]">
              <p className="text-xs text-[var(--text-muted)] mb-2">
                Forces only this player to re-sign the liability waiver on their next visit.
              </p>
              <RequireWaiverResignatureButton playerId={player.id} />
            </div>
          )}
        </div>
        )}

        {/* Reliability */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6">
          <div className="flex items-center gap-2 mb-4">
            <Shield className="w-4 h-4 text-[var(--text-muted)]" />
            <h2 className="text-base font-semibold text-[var(--text-primary)] flex-1">Reliability</h2>
            {/* Read-only panel below stays visible to execs; only the editor
                trigger is admin-only — adjustReliability rewrites the
                no-show/penalty counters and was not part of the brief. */}
            {isAdmin && (
              <ReliabilityEditor
                playerId={id}
                noShows={reliability?.no_shows ?? 0}
                lateCancellations={reliability?.late_cancellations ?? 0}
                earlyWithdrawals={reliability?.early_withdrawals ?? 0}
                walkoverFlag={reliability?.walkover_flag ?? false}
              />
            )}
          </div>
          {reliability ? (
            <div className="space-y-3">
              {[
                { label: 'Challenges Issued', value: reliability.challenges_issued },
                { label: 'Matches Completed', value: reliability.matches_completed },
                { label: 'No-Shows', value: reliability.no_shows, danger: reliability.no_shows > 0 },
                { label: 'Late Cancellations', value: reliability.late_cancellations },
                { label: 'Early Withdrawals', value: reliability.early_withdrawals },
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
          {((walkoverEvents && walkoverEvents.length > 0) || (tournamentNoShows && tournamentNoShows.length > 0)) && (
            <div className="mt-4 pt-4 border-t border-[var(--border)] space-y-2">
              <p className="text-xs text-[var(--text-muted)] uppercase">Events</p>
              {walkoverEvents?.map((w) => {
                const challengeRaw = w.challenge as unknown;
                const challenge = (Array.isArray(challengeRaw) ? challengeRaw[0] : challengeRaw) as { type: string } | null;
                const reporterRaw = w.reporter as unknown;
                const reporter = (Array.isArray(reporterRaw) ? reporterRaw[0] : reporterRaw) as { full_name: string } | null;
                // <24h notice = "late" — same cutoff the walkover flow uses to
                // increment late_cancellations vs early_withdrawals.
                const label = w.walkover_type === 'no_show'
                  ? 'No-show'
                  : (w.notice_hours ?? 0) < 24 ? 'Late withdrawal' : 'Withdrawal';
                return (
                  <div key={w.id} className="p-2 rounded-lg bg-[var(--bg-elevated)]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm text-[var(--text-primary)]">
                        {label}
                        {w.notice_hours !== null && ` (${w.notice_hours}h notice)`}
                        {challenge && ` · ${challenge.type}`}
                      </span>
                      <Badge variant={w.status === 'pending' ? 'warning' : w.status === 'confirmed' ? 'success' : 'danger'}>
                        {w.status}
                      </Badge>
                    </div>
                    <p className="text-xs text-[var(--text-muted)] mt-1">
                      {new Date(w.reported_at).toLocaleDateString()}
                      {reporter && ` · Reported by ${reporter.full_name}`}
                    </p>
                    {w.admin_notes && (
                      <p className="text-xs text-[var(--text-secondary)] mt-1">{w.admin_notes}</p>
                    )}
                  </div>
                );
              })}
              {tournamentNoShows?.map((tp) => {
                const eventRaw = tp.event as unknown;
                const event = (Array.isArray(eventRaw) ? eventRaw[0] : eventRaw) as { event_type: string; tournament: { name: string } | { name: string }[] | null } | null;
                const tournamentRaw = event?.tournament as unknown;
                const tournament = (Array.isArray(tournamentRaw) ? tournamentRaw[0] : tournamentRaw) as { name: string } | null;
                const eventLabel = event ? (TOURNAMENT_EVENT_TYPE_LABELS[event.event_type as keyof typeof TOURNAMENT_EVENT_TYPE_LABELS] ?? event.event_type) : '';
                return (
                  <div key={tp.id} className="p-2 rounded-lg bg-[var(--bg-elevated)] flex items-center justify-between gap-2">
                    <span className="text-sm text-[var(--text-primary)]">
                      Tournament no-show{tournament && ` — ${tournament.name}`}{eventLabel && ` · ${eventLabel}`}
                    </span>
                    <Badge variant="danger">no_show</Badge>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Varsity Notes */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6">
          <div className="flex items-center gap-2 mb-4">
            <FileText className="w-4 h-4 text-[var(--text-muted)]" />
            <h2 className="text-base font-semibold text-[var(--text-primary)]">Varsity Notes</h2>
          </div>
          <VarsityNotes playerId={player.id} notes={varsityNotes ?? []} />
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
