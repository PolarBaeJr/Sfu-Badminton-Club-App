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
        logs={(logs ?? []) as AuditLogRow[]}
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
