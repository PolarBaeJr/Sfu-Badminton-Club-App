export const dynamic = 'force-dynamic';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { PageHeader } from '@badminton/ui';
import { selectInChunks, clubToday, wallClockToUtc } from '@badminton/shared';
import Link from 'next/link';
import { AuditList, type AuditLogRow } from './audit-list';
import { AuditActivityChart } from './activity-chart';
import { countDegraded } from '@/lib/audit-log-view';
import { SeasonSelect } from '@/components/season-select';
import { resolveSeasonScope } from '@/components/season-scope';

/**
 * Club-local midnight opening `date`, as a UTC instant.
 *
 * BOTH ENDS OF THIS FILTER WERE IN THE WRONG ZONE (F-022). The season's
 * start_date and end_date are DATE columns and mean club-local calendar days,
 * but created_at is a timestamptz: the start bound was pinned to UTC midnight
 * and the end bound was `new Date('YYYY-MM-DDT00:00:00')`, which parses in
 * whatever timezone the container happens to run in — UTC in production. Both
 * therefore sat 7 hours ahead of the club's own midnight, so every season's
 * window opened and closed at 17:00 the previous afternoon. Actions taken on
 * the last evening of a season were filed under the next one.
 *
 * `offset` shifts by whole calendar days before the conversion, which is what
 * makes the end bound half-open: end_date means "this day inclusive", so the
 * filter runs up to (but not including) club-local midnight the morning after.
 */
function clubDayStart(date: string, offset = 0): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return wallClockToUtc(y, m, d + offset, 0, 0).toISOString();
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; season?: string }>;
}) {
  const { range, season } = await searchParams;
  const fullHistory = range === 'all';
  // Same capability middleware resolves for '/audit', re-asked at the fetch. An
  // audit trail names who did what to whom, so it is the last page that should
  // rely on a route match having happened upstream.
  await requireCapability('audit.page');
  const supabase = createAdminClient();

  // The seasons themselves are the navigation. An audit trail is read to answer
  // "what happened during X" — a term, a tournament, a season somebody is
  // querying — and a rolling 30-day window cannot answer that question at all:
  // it silently ends mid-season and has no relationship to anything the club
  // recognises.
  const { data: seasons } = await supabase
    .from('seasons')
    .select('id, name, start_date, end_date, active_flag')
    .order('start_date', { ascending: false });

  // Same resolution as /sessions, /fees and /tournaments — one shared helper, so
  // `?season=` means the same thing on every scoped page and a link between them
  // keeps its scope.
  const { seasons: allSeasons, selected: scopeSeason } = resolveSeasonScope(seasons, season);

  // Two overrides on top of the shared answer, both specific to a log.
  //
  // `?range=all` is the escape hatch: an audit trail is the one page where
  // "before any season we still have" is a real question, so no season at all is
  // a legitimate scope here in a way it is not on a fee ledger.
  //
  // And a club activates the NEXT season before it starts — that is the normal
  // way to line one up. Defaulting to it would show an empty page: the window
  // opens in the future, so nothing that has already happened is inside it. An
  // explicit ?season= is still honoured either way. Picking a season that has
  // not started and being shown nothing is a correct answer to a question
  // somebody asked; being shown nothing on arrival is not.
  // The club's today — toLocaleDateString with no timeZone reads the HOST
  // zone, and the containers run UTC. On a club evening it would call a
  // season that starts tomorrow 'already started' and stop defaulting to
  // full history.
  const today = clubToday();
  const impliedAndUnstarted =
    !season && !!scopeSeason?.start_date && scopeSeason.start_date > today;
  const selectedSeason = fullHistory || impliedAndUnstarted ? null : scopeSeason;

  // Caps keep the payload bounded either way.
  let query = supabase
    .from('audit_logs')
    .select('*, actor:players!audit_logs_actor_id_fkey(full_name)')
    .order('created_at', { ascending: false })
    .limit(fullHistory ? 1000 : 500);

  let scopeLabel: string;
  if (fullHistory) {
    scopeLabel = 'Full history';
  } else if (selectedSeason) {
    // start_date is nullable, and the string-template form this replaced hid
    // that: a null interpolated to the literal `nullT00:00:00Z`, which
    // PostgREST rejects — so the filter silently became "no rows" rather than
    // "no lower bound". A season without a start simply has no lower bound.
    if (selectedSeason.start_date) {
      query = query.gte('created_at', clubDayStart(selectedSeason.start_date));
    }
    // An unfinished season has no end: everything since it started, up to now.
    if (selectedSeason.end_date) {
      query = query.lt('created_at', clubDayStart(selectedSeason.end_date, 1));
    }
    scopeLabel = selectedSeason.name;
  } else {
    // No season to scope by: none active, or the active one has not started.
    // Falling back to a window keeps the page useful instead of empty, and the
    // label says which one so it cannot be mistaken for a season.
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    query = query.gte('created_at', since);
    scopeLabel = 'Last 30 days';
  }

  const { data: logs } = await query;
  const rows = (logs ?? []) as AuditLogRow[];

  // Put a NAME on the rows that are about a person.
  //
  // `target_id` is a bare uuid against a table named only by `target_type`, so
  // there is no join that resolves all of them — but `player` is by far the
  // commonest target and the one where the uuid is least use: "PLAYER BANNED /
  // 4b1c2d3e" answers nothing anybody opens this page to ask. Only that one
  // type is resolved; every other target keeps its type and short reference,
  // which is all the schema actually knows.
  //
  // Chunked because this fetch is capped at 500-1000 rows and PostgREST puts
  // `in=(…)` in the QUERY STRING: a few hundred uuids is a URL long enough to
  // be truncated or refused by a proxy, and the failure is silent — missing
  // names rather than an error.
  //
  // This page diagnosed that and chunked by hand at 100. It is now the shared
  // helper, derived from the measured 8 KB request-line limit — the same defect
  // was live at a dozen other call sites, including the one that kills push for
  // the whole club.
  const subjectIds = [
    ...new Set(
      rows
        .filter((log) => log.target_type === 'player' && log.target_id)
        .map((log) => log.target_id as string)
    ),
  ];
  // The error is deliberately dropped HERE, at the call site, and only here:
  // an unresolved name degrades to "PLAYER BANNED / 4b1c2d3e", which is the
  // same thing this page already renders for a member who has since been
  // removed. Refusing to draw the accountability log because one name lookup
  // failed would be the wrong trade.
  const { data: fetched } = await selectInChunks<{
    id: string;
    full_name: string;
    avatar_url: string | null;
  }>(subjectIds, (ids) =>
    supabase.from('players').select('id, full_name, avatar_url').in('id', ids) as never
  );
  const subjects = new Map<string, { full_name: string; avatar_url: string | null }>();
  for (const player of fetched ?? []) {
    subjects.set(player.id, { full_name: player.full_name, avatar_url: player.avatar_url });
  }
  // A player who has since been removed or merged away has no row to resolve.
  // The entry stays exactly as it is, subject-less — deleting the person does
  // not delete the record of what was done to them.
  const withSubjects = rows.map((log) => ({
    ...log,
    subject: (log.target_id && subjects.get(log.target_id)) || null,
  }));

  const degraded = countDegraded(rows);

  return (
    <div className="space-y-6">
      {/* ACCOUNTABILITY, not "audit": the eyebrow says what the page is FOR.
          Every other console screen is a place to do something; this one exists
          so that what was done can be read back. */}
      <PageHeader
        eyebrow="Accountability"
        title="Audit log"
        sub="Who did what, when, and the reason they typed."
        watermark="A"
      />

      {/* AUDIT HEALTH, stated on the page rather than only in a policy document.
          This trail is best effort: a write that the database refuses is
          reported to Sentry and retried without its payload, never thrown,
          because throwing after the mutation has already landed makes an
          officer repeat an action that in fact succeeded. The club accepted
          that trade on 2026-08-29 — see docs/ops/audit-policy.md.

          What the reader is owed in exchange is knowing when it has bitten. A
          degraded entry is a real fact with its detail missing, and it is
          counted here and badged in the list.

          The honest limit, which is why this line is unconditional: an entry
          lost ENTIRELY leaves no row, so no screen can count it. Zero degraded
          entries means none were degraded, not that none were lost. */}
      <p className="text-xs leading-relaxed text-[var(--text-muted)]">
        This log is best effort. A refused write is retried without its detail
        rather than blocking the action it records, so an entry can be real and
        incomplete at once
        {degraded > 0 ? (
          <>
            {' — '}
            <strong className="text-[var(--color-warning)]">
              {degraded} {degraded === 1 ? 'entry' : 'entries'}
            </strong>{' '}
            in this view {degraded === 1 ? 'is' : 'are'} marked{' '}
            <span className="whitespace-nowrap">&ldquo;Detail lost&rdquo;</span>
          </>
        ) : null}
        . An entry lost outright leaves no row at all, so it cannot appear here.
      </p>

      {/* Above the list and outside it: the shape of the whole scope is what
          makes it navigation, and a chart sitting UNDER the tab filter while
          ignoring it would read as a bug. Folds the rows already fetched — no
          query of its own. See ./activity-chart.tsx. */}
      <AuditActivityChart logs={rows} scopeLabel={scopeLabel} />

      <AuditList
        logs={withSubjects}
        scopeLabel={scopeLabel}
        controls={
          // Rendered here and passed down so the whole control band is one row:
          // the season picker is driven by the URL (it re-queries on the server),
          // while the tab, search and sort are client state over the rows it
          // returned. Two different mechanisms, one line of controls.
          <>
            <SeasonSelect seasons={allSeasons} selected={selectedSeason} basePath="/audit" />
            <Link
              href={fullHistory ? '/audit' : '/audit?range=all'}
              className={`whitespace-nowrap rounded-full border px-2.5 py-1 text-xs transition-colors ${
                fullHistory
                  ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                  : 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-hover)] hover:text-[var(--text-primary)]'
              }`}
            >
              {fullHistory ? 'Back to season' : 'Full history →'}
            </Link>
          </>
        }
      />
    </div>
  );
}
