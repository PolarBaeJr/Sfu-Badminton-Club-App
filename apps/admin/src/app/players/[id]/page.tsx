import { createAdminClient, getAuthenticatedConsoleUser } from '@/lib/supabase-server';
import { accessLevelFor, permissionsOf, permits } from '@/lib/permissions';
import { Badge, AvatarChip, EmptyState, ResponsiveTable, TableCard, Atomic } from '@badminton/ui';
import { PLAYER_STATUS_LABELS, MATCH_FORMAT_LABELS, TOURNAMENT_EVENT_TYPE_LABELS, MEMBERSHIP_TYPES, getWinRate, getStreakDisplay, getPointDifferential, formatMemberNumber } from '@badminton/shared';
import { PlayerEditForm } from './edit-form';
import { VarsityNotes } from './varsity-notes';
import { ReliabilityEditor } from './reliability-editor';
import { CancelDeletionButton } from './cancel-deletion-button';
import { RequireWaiverResignatureButton } from './require-waiver-resignature-button';
import { Panel, PanelLabel, PanelRow } from './panel';
import { notFound } from 'next/navigation';
import { ArrowLeft, Shield, Trophy, FileText, AlertTriangle, ArrowUpRight, ArrowDownRight, SquarePen } from 'lucide-react';
import Link from 'next/link';
import { SeasonPicker } from './season-picker';

/** Local date only. The hour a match was played is noise in a history list. */
const day = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

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
  const permissions = permissionsOf(viewer);
  const isAdmin = level === 'admin';
  // Ask for the capability the edit form's Save invokes, not for a level —
  // anyone holding only players.read sees this page exactly as a trainer does,
  // read-only. Same reasoning as /players itself.
  const canManage = permits(level, permissions, 'players.update.write');
  // Approving a pending signup is its own capability, and the edit form saves
  // through approvePlayer for exactly those members — so a holder of the update
  // write alone would meet a Save that can only refuse.
  const canApprove = permits(level, permissions, 'players.approve.write');
  // This page is a data view of the same rows /players lists, one member at a
  // time and in far more detail, so it is behind the same capability. Elo,
  // reliability, match history and the season archive are all withheld without
  // it.
  const canRead = permits(level, permissions, 'players.read');
  // ...but the two WRITES that live here are not. The coaching log is a
  // trainer's whole reason to be in the console and the edit form is an exec's,
  // and both need the row they act on — so a holder of either keeps the identity
  // header and their own panel. Withholding the record from them would recreate,
  // in the same breath, the blank-panel bug this change is fixing on /fees.
  const canWriteNotes = permits(level, permissions, 'players.editor.varsitynotes.write');
  const showNotes = canRead || canWriteNotes;
  /** How many of the three panels below this viewer gets — the grid's columns. */
  const panelCount = [canManage, canRead, showNotes].filter(Boolean).length;
  // Nobody with a claim on this member at all. Every query below is skipped —
  // including the one that decides notFound(), which is deliberate: whether a
  // particular id exists is itself something the roster would tell them.
  if (!canRead && !canManage && !canWriteNotes) {
    return (
      <div className="space-y-6">
        <Link href="/players" className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--color-accent)] transition-colors">
          <ArrowLeft className="w-4 h-4" />
          Back to Players
        </Link>
        <Panel>
          <EmptyState
            title="Member records are not shown to you"
            description="You can open the roster section, but not the people in it."
          />
        </Panel>
      </div>
    );
  }
  const supabase = createAdminClient();

  // Which season this page is showing. Defaults to the active one; ?season=
  // overrides it so a particular season's view is a shareable link. Everything
  // it scopes is behind players.read, so without that there is nothing to scope
  // and no picker to draw.
  const { data: seasons } = canRead
    ? await supabase
        .from('seasons')
        .select('id, term, year, active_flag, start_date, end_date')
        .order('year', { ascending: false })
        .order('term')
    : { data: null };
  const seasonList = seasons ?? [];
  const selectedSeason =
    seasonList.find((s) => s.id === seasonParam)
    ?? seasonList.find((s) => s.active_flag)
    ?? seasonList[0]
    ?? null;
  // Null without players.read, because the season list it is chosen from was
  // never fetched. The season-archive query further down leans on exactly that
  // — keep the implication if this is ever restructured.
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
    // The member row itself stays: it is what notFound() reads, what the
    // identity header draws, and what seeds the edit form for somebody who may
    // change this person without browsing the club.
    supabase.from('players').select('*').eq('id', id).single(),
    // Everything from here down is the DETAIL, and every one of these is skipped
    // rather than hidden — a row that reaches this component reaches the RSC
    // payload whether or not it is drawn.
    canRead
      ? supabase.from('ratings').select('*').eq('player_id', id).single()
      : Promise.resolve({ data: null }),
    canRead
      ? supabase.from('reliability_metrics').select('*').eq('player_id', id).maybeSingle()
      : Promise.resolve({ data: null }),
    // !inner so the season filter on the embedded matches row actually
    // excludes the participant row rather than just nulling the embed.
    canRead
      ? supabase.from('match_participants')
          .select('*, match:matches!inner(*, match_games(*))')
          .eq('player_id', id)
          .eq('matches.season_id', seasonId ?? '')
          .order('created_at', { ascending: false, referencedTable: 'matches' })
          .limit(10)
      : Promise.resolve({ data: null }),
    // The coaching log follows the NOTE capability as well as the read. It is
    // not roster data — it is the thing a varsity trainer comes here to write —
    // and gating it on the roster alone would leave a holder of the write
    // staring at the blank panel this change exists to abolish.
    showNotes
      ? supabase.from('varsity_notes').select('*, author:players!varsity_notes_author_id_fkey(full_name)').eq('player_id', id).order('created_at', { ascending: false })
      : Promise.resolve({ data: null }),
    // walkovers carries no season_id and reaches a match only through the
    // challenge, which has none either — so it is scoped by date against the
    // season window instead of a two-hop embed filter.
    canRead
      ? supabase.from('walkovers')
          .select('id, walkover_type, notice_hours, reported_at, status, admin_notes, challenge:challenges(type), reporter:players!walkovers_reported_by_fkey(full_name)')
          .eq('forfeit_player_id', id)
          .gte('reported_at', selectedSeason?.start_date ?? '1970-01-01')
          .lte('reported_at', selectedSeason?.end_date ?? '2999-12-31')
          .order('reported_at', { ascending: false })
      : Promise.resolve({ data: null }),
    canRead
      ? supabase.from('tournament_participants')
          .select('id, status, event:tournament_events!inner(event_type, tournament:tournaments!inner(name, season_id))')
          .eq('player_id', id)
          .eq('tournament_events.tournaments.season_id', seasonId ?? '')
          .eq('status', 'no_show')
      : Promise.resolve({ data: null }),
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

  // Empty for a member with neither, which is every member until they pick a
  // handle and a pending signup who has not been numbered yet.
  //
  // The number goes through the shared formatter rather than being printed as
  // an integer, because its SHAPE is mid-change: the club owner wants a random
  // seven-character code, and the day that lands this line must not be one of
  // the places still rendering a padded counter.
  const identity = [
    player.handle ? `@${player.handle}` : null,
    formatMemberNumber(player.member_number),
  ].filter(Boolean).join(' · ');

  // Selected via `select('*')` but absent from the shared Player type, exactly
  // as the edit form reads it.
  const membershipType = (player as { membership_type?: string }).membership_type ?? 'internal';
  const membershipLabel = MEMBERSHIP_TYPES.find((m) => m.value === membershipType)?.label ?? membershipType;

  const events = [...(walkoverEvents ?? []), ...(tournamentNoShows ?? [])];

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link href="/players" className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--color-accent)] transition-colors">
        <ArrowLeft className="w-4 h-4" />
        Back to Players
      </Link>

      {/* Identity header, in the console's editorial style: mono eyebrow,
          display-font name, mono identity line. Hand-rolled rather than
          <PageHeader> because that component has no leading slot and the avatar
          belongs beside the name, not above it. The classes are the shared ones
          from globals.css, so the typography is the same either way.

          NOTHING HERE IS NEW: name, email, handle, number and the level badges
          are exactly what this header showed before. The member row is the one
          query that runs without players.read, so anything added here would be
          added for a notes-only trainer too — the extended detail lives in the
          Membership panel below, behind the read. */}
      <div className="page-header no-period !mb-0">
        <div className="flex min-w-0 items-start gap-4">
          <AvatarChip name={player.full_name} size="lg" id={player.id} />
          <div className="min-w-0">
            <div className="page-eyebrow">
              <span className="bar" />
              Member
            </div>
            <h1 className="page-title">{player.full_name}</h1>
            <div className="page-sub">
              {player.email}
              {/* Both read-only, and read-only for different reasons: the handle
                  belongs to the member (nobody sets anyone else's), and the
                  number belongs to the club (nobody sets one at all). Neither is
                  in adminPlayerUpdateSchema, so the Edit dialog cannot offer
                  them even by accident. */}
              {identity && (
                <span className="mt-1 block font-mono text-xs text-[var(--text-muted)]">{identity}</span>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge variant={player.status === 'competitive' ? 'success' : player.status === 'suspended' ? 'danger' : 'default'}>
                {PLAYER_STATUS_LABELS[player.status as keyof typeof PLAYER_STATUS_LABELS]}
              </Badge>
              <Badge variant="neutral">
                <Shield className="w-3 h-3 inline mr-1" />
                {player.role}
              </Badge>
              {player.is_exec && <Badge variant="info">Exec</Badge>}
              {player.is_trainer && <Badge variant="info">Trainer</Badge>}
            </div>
          </div>
        </div>

        {/* Season switcher. Everything below is scoped to this season EXCEPT
            varsity notes and reliability — those are a player's standing record
            and follow them across seasons. Nothing it scopes was fetched without
            players.read, so a picker over an empty page is not offered. */}
        {canRead && (
          <div className="flex flex-col items-start gap-2 md:items-end">
            <SeasonPicker seasons={seasonList} selectedId={seasonId} />
            {!isActiveSeason && (
              <p className="text-xs text-[var(--text-muted)]">
                Past season — ratings are that season&apos;s final archived values.
              </p>
            )}
          </div>
        )}
      </div>

      {/* The roster read, withheld. Said once, above the panels that survive it,
          rather than letting the reliability card say "No reliability data" and
          Recent Matches say "No matches" — both of which are false and neither
          of which a reader could tell apart from a quiet member. */}
      {!canRead && (
        <Panel>
          <EmptyState
            title="This member’s record is not shown to you"
            description={
              canManage
                ? 'You can edit them, but their ratings, reliability and match history are not yours to see.'
                : 'Their ratings, reliability and match history are not yours to see.'
            }
          />
        </Panel>
      )}

      {/* Pending self-service account deletion. `.danger-zone` is the console's
          existing red-hairline call-out; it replaces a hand-mixed
          --color-danger/10 wash, which was the one raw colour value on this
          page that no token stood behind. */}
      {player.deletion_requested_at && (
        <div className="danger-zone flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-danger)]" />
            <div>
              <p className="danger-title">Deletion requested</p>
              <p className="text-sm text-[var(--text-secondary)]">
                Requested {day(player.deletion_requested_at)} — permanently anonymized on{' '}
                {day(new Date(new Date(player.deletion_requested_at).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString())}.
              </p>
            </div>
          </div>
          {isAdmin && <CancelDeletionButton playerId={player.id} />}
        </div>
      )}

      {/* The season's headline numbers, as the console's hairline stat strip
          rather than four bordered tiles. `.stat-strip` is grid-auto-flow:column
          and reflows to two columns on a phone, so it needs no breakpoint
          classes of its own. */}
      {r && (
        <div className="stat-strip">
          <div>
            <p className="stat-label">Singles Elo</p>
            <p className="stat-value">{r.singles_elo}</p>
            <p className="mt-1.5 font-mono text-[11px] text-[var(--text-muted)]">
              {r.singles_provisional ? 'Provisional' : 'Established'} · {r.singles_wins}W-{r.singles_losses}L ({getWinRate(r.singles_wins, r.singles_losses)})
            </p>
          </div>
          <div>
            <p className="stat-label">Doubles Elo</p>
            <p className="stat-value">{r.doubles_elo}</p>
            <p className="mt-1.5 font-mono text-[11px] text-[var(--text-muted)]">
              {r.doubles_provisional ? 'Provisional' : 'Established'} · {r.doubles_wins}W-{r.doubles_losses}L ({getWinRate(r.doubles_wins, r.doubles_losses)})
            </p>
          </div>
          <div>
            <p className="stat-label">Singles streak</p>
            <p className="stat-value">{getStreakDisplay(r.current_singles_streak)}</p>
            <p className="mt-1.5 font-mono text-[11px] text-[var(--text-muted)]">Best {r.best_singles_streak}</p>
          </div>
          <div>
            <p className="stat-label">Point diff</p>
            <p className="stat-value">{getPointDifferential(r.singles_points_scored, r.singles_points_allowed)}</p>
            <p className="mt-1.5 font-mono text-[11px] text-[var(--text-muted)]">
              Doubles {getPointDifferential(r.doubles_points_scored, r.doubles_points_allowed)}
            </p>
          </div>
        </div>
      )}

      {/* One column per panel that survives this viewer's capabilities: the edit
          form on players.update.write, reliability on players.read, the notes on
          either the read or the note write. Three for an exec, two for a
          trainer — the same as before, now derived rather than assumed. */}
      <div className={`grid grid-cols-1 gap-6 ${
        panelCount >= 3 ? 'lg:grid-cols-3' : panelCount === 2 ? 'lg:grid-cols-2' : ''
      }`}>
        {/* Edit Form. Dropped entirely for a trainer: updatePlayer asks for
            players.update.write, so every control in it — status, membership,
            the reason box, Save — would reject them. */}
        {canManage && (
        <Panel title="Edit member" icon={<SquarePen className="h-4 w-4 text-[var(--text-muted)]" />}>
          <PlayerEditForm player={player} rating={r} isAdmin={isAdmin} canApprove={canApprove} />
          {isAdmin && (
            <div className="mt-5 border-t border-[var(--border)] pt-4">
              <PanelLabel>Legal</PanelLabel>
              <p className="mb-3 text-xs text-[var(--text-muted)]">
                Forces only this player to re-sign the liability waiver on their next visit.
              </p>
              <RequireWaiverResignatureButton playerId={player.id} />
            </div>
          )}
        </Panel>
        )}

        {/* Reliability. Roster data — the counters are this member's record —
            so it goes with players.read. */}
        {canRead && (
        <Panel
          title="Reliability"
          icon={<Shield className="h-4 w-4 text-[var(--text-muted)]" />}
          /* Read-only panel below stays visible to execs; only the editor
             trigger is admin-only — adjustReliability rewrites the
             no-show/penalty counters and was not part of the brief. */
          trailing={isAdmin ? (
            <ReliabilityEditor
              playerId={id}
              noShows={reliability?.no_shows ?? 0}
              lateCancellations={reliability?.late_cancellations ?? 0}
              earlyWithdrawals={reliability?.early_withdrawals ?? 0}
              walkoverFlag={reliability?.walkover_flag ?? false}
            />
          ) : undefined}
        >
          {reliability ? (
            <>
              <div className="divide-y divide-[var(--border)]">
                {[
                  { label: 'Challenges issued', value: reliability.challenges_issued },
                  { label: 'Matches completed', value: reliability.matches_completed },
                  { label: 'No-shows', value: reliability.no_shows, danger: reliability.no_shows > 0 },
                  { label: 'Late cancellations', value: reliability.late_cancellations },
                  { label: 'Early withdrawals', value: reliability.early_withdrawals },
                  { label: 'Dispute involvement', value: reliability.dispute_involvement_count },
                ].map(({ label, value, danger }) => (
                  <PanelRow key={label} label={label} value={value} tone={danger ? 'danger' : undefined} />
                ))}
              </div>
              {/* A SIBLING of the counter stack, not a row inside it. Tailwind's
                  `divide-y` is a `> :not([hidden]) ~ :not([hidden])` rule, which
                  outranks this box's own border-color class and would repaint its
                  top edge grey — a red call-out with one grey side. It is also
                  the truer structure: this is the conclusion the counters lead
                  to, not another counter. */}
              {reliability.walkover_flag && (
                <div className="mt-4 flex items-center gap-2 border border-[var(--red-border)] bg-[var(--red-wash)] p-3">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--color-danger)]" />
                  <span className="text-sm font-medium text-[var(--color-danger)]">Flagged for no-shows</span>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-[var(--text-muted)]">No reliability data</p>
          )}

          {/* Walkovers and tournament no-shows kept INSIDE this panel rather
              than promoted to a table of their own: they are the events behind
              the counters directly above, and separating them from the numbers
              they explain is what made the old layout hard to read. */}
          {events.length > 0 && (
            <div className="mt-5 border-t border-[var(--border)] pt-4">
              <PanelLabel>Events this season</PanelLabel>
              <div className="divide-y divide-[var(--border)]">
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
                    <div key={w.id} className="py-3">
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-sm text-[var(--text-primary)]">
                          {label}
                          {w.notice_hours !== null && ` (${w.notice_hours}h notice)`}
                          {challenge && ` · ${challenge.type}`}
                        </span>
                        <Badge variant={w.status === 'pending' ? 'warning' : w.status === 'confirmed' ? 'success' : 'danger'}>
                          {w.status}
                        </Badge>
                      </div>
                      <p className="mt-1 font-mono text-[11px] text-[var(--text-muted)]">
                        {day(w.reported_at)}
                        {reporter && ` · reported by ${reporter.full_name}`}
                      </p>
                      {w.admin_notes && (
                        <p className="mt-1 text-xs text-[var(--text-secondary)]">{w.admin_notes}</p>
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
                    <div key={tp.id} className="flex items-start justify-between gap-2 py-3">
                      <span className="text-sm text-[var(--text-primary)]">
                        Tournament no-show{tournament && ` — ${tournament.name}`}{eventLabel && ` · ${eventLabel}`}
                      </span>
                      <Badge variant="danger">no_show</Badge>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </Panel>
        )}

        {/* Varsity Notes. The coaching log, not the roster: a holder of the note
            write keeps it with no players.read at all, which is the state a
            trainer would be in if the read were ever taken off their level. */}
        {showNotes && (
        <Panel title="Varsity notes" icon={<FileText className="h-4 w-4 text-[var(--text-muted)]" />}>
          <VarsityNotes playerId={player.id} notes={varsityNotes ?? []} />
        </Panel>
        )}
      </div>

      {/* The standing membership facts, as opposed to the season's numbers
          above. Behind players.read with everything else that describes this
          member: the header carries only what the page already showed without
          the read.

          DELIBERATELY ONLY THE TWO FACTS THAT ARE NEW. Handle and member number
          belong to the header, which draws them without players.read because the
          member row is the one query that runs regardless — repeating them here
          would show a reader the same value twice and, worse, show it gated in
          one place and ungated in the other. */}
      {canRead && (
        <Panel title="Membership" icon={<Shield className="h-4 w-4 text-[var(--text-muted)]" />}>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
            {[
              { label: 'Type', value: membershipLabel },
              { label: 'Joined', value: day(player.joined_at) },
            ].map((f) => (
              <div key={f.label} className="min-w-0">
                <dt className="dialog-group-label !mb-1">{f.label}</dt>
                <dd className="font-mono text-sm text-[var(--text-primary)]">{f.value}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      )}

      {/* Recent Matches. Through ResponsiveTable so the console works from the
          door on a phone: the desktop <table> is untouched below md, and the
          TableCard stack replaces it above. */}
      {canRead && (
      <Panel title="Recent matches" icon={<Trophy className="h-4 w-4 text-[var(--text-muted)]" />} padded={false}>
        {recentMatches && recentMatches.length > 0 ? (
          <ResponsiveTable
            cards={recentMatches.map((mp) => {
              const m = mp.match as Record<string, unknown> | null;
              if (!m) return null;
              return (
                <TableCard
                  key={mp.id}
                  title={mp.win_flag ? 'Win' : 'Loss'}
                  // Atomic keeps "21-18, 21-15" from breaking after a hyphen —
                  // the exact wrap this component was built to stop.
                  value={<Atomic separator=",">{(m.score_summary as string) || '—'}</Atomic>}
                  badges={
                    <>
                      <Badge variant={mp.win_flag ? 'success' : 'danger'}>{mp.win_flag ? 'W' : 'L'}</Badge>
                      <Badge variant="neutral">
                        {MATCH_FORMAT_LABELS[(m.format as string) as keyof typeof MATCH_FORMAT_LABELS] || (m.format as string)}
                      </Badge>
                    </>
                  }
                  fields={[
                    { label: 'Rating', value: <RatingDelta delta={mp.rating_delta as number | null} /> },
                    { label: 'Played', value: day(m.played_at as string | null) },
                  ]}
                />
              );
            })}
          >
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="px-5 py-3 text-left text-xs font-medium uppercase text-[var(--text-muted)]">Result</th>
                  <th className="px-5 py-3 text-left text-xs font-medium uppercase text-[var(--text-muted)]">Score</th>
                  <th className="px-5 py-3 text-left text-xs font-medium uppercase text-[var(--text-muted)]">Format</th>
                  <th className="px-5 py-3 text-right text-xs font-medium uppercase text-[var(--text-muted)]">Rating</th>
                  <th className="px-5 py-3 text-right text-xs font-medium uppercase text-[var(--text-muted)]">Played</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {recentMatches.map((mp) => {
                  const m = mp.match as Record<string, unknown> | null;
                  if (!m) return null;
                  return (
                    <tr key={mp.id} className="transition-colors hover:bg-[var(--bg-elevated)]">
                      <td className="px-5 py-3">
                        <Badge variant={mp.win_flag ? 'success' : 'danger'}>{mp.win_flag ? 'W' : 'L'}</Badge>
                      </td>
                      <td className="px-5 py-3 font-mono text-sm text-[var(--text-secondary)]">
                        <Atomic separator=",">{(m.score_summary as string) || '—'}</Atomic>
                      </td>
                      <td className="px-5 py-3 text-sm text-[var(--text-secondary)]">
                        {MATCH_FORMAT_LABELS[(m.format as string) as keyof typeof MATCH_FORMAT_LABELS] || (m.format as string)}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <RatingDelta delta={mp.rating_delta as number | null} />
                      </td>
                      <td className="px-5 py-3 text-right font-mono text-xs text-[var(--text-muted)]">
                        {day(m.played_at as string | null)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ResponsiveTable>
        ) : (
          <EmptyState
            title="No matches this season"
            description="Nothing has been recorded for this member in the season shown above."
          />
        )}
      </Panel>
      )}
    </div>
  );
}

/**
 * The Elo movement one match caused. Null is a real state — a friendly, or a
 * result recorded before the engine rated it — and reads as a dash rather than
 * as a zero, which would claim the rating held steady.
 */
function RatingDelta({ delta }: { delta: number | null | undefined }) {
  if (delta === null || delta === undefined) {
    return <span className="font-mono text-sm text-[var(--text-muted)]">—</span>;
  }
  const up = delta >= 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 font-mono text-sm ${
        up ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'
      }`}
    >
      {up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
      {up ? '+' : ''}{delta}
    </span>
  );
}
