export const dynamic = 'force-dynamic';
import { createAdminClient } from '@/lib/supabase-server';
import { PageHeader } from '@badminton/ui';
import Link from 'next/link';
import { AuditList, type AuditLogRow } from './audit-list';
import { SeasonSelect } from '@/components/season-select';
import { resolveSeasonScope } from '@/components/season-scope';

/**
 * The day AFTER a season's last day, as a timestamp.
 *
 * end_date is a DATE and means "this day inclusive", but created_at is a
 * timestamptz — so filtering `<= end_date` compares against midnight and drops
 * everything that happened during the season's final day. Half-open interval
 * instead: >= start, < the next morning.
 */
function dayAfter(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; season?: string }>;
}) {
  const { range, season } = await searchParams;
  const fullHistory = range === 'all';
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
  const today = new Date().toLocaleDateString('en-CA');
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
    query = query.gte('created_at', `${selectedSeason.start_date}T00:00:00Z`);
    // An unfinished season has no end: everything since it started, up to now.
    if (selectedSeason.end_date) {
      query = query.lt('created_at', dayAfter(selectedSeason.end_date));
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
  const subjectIds = [
    ...new Set(
      rows
        .filter((log) => log.target_type === 'player' && log.target_id)
        .map((log) => log.target_id as string)
    ),
  ];
  const chunks: string[][] = [];
  for (let i = 0; i < subjectIds.length; i += 100) chunks.push(subjectIds.slice(i, i + 100));
  const fetched = await Promise.all(
    chunks.map((ids) => supabase.from('players').select('id, full_name, avatar_url').in('id', ids))
  );
  const subjects = new Map<string, { full_name: string; avatar_url: string | null }>();
  for (const { data } of fetched) {
    for (const player of data ?? []) {
      subjects.set(player.id, { full_name: player.full_name, avatar_url: player.avatar_url });
    }
  }
  // A player who has since been removed or merged away has no row to resolve.
  // The entry stays exactly as it is, subject-less — deleting the person does
  // not delete the record of what was done to them.
  const withSubjects = rows.map((log) => ({
    ...log,
    subject: (log.target_id && subjects.get(log.target_id)) || null,
  }));

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
