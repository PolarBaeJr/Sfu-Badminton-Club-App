export const dynamic = 'force-dynamic';
import { createAdminClient } from '@/lib/supabase-server';
import { PageHeader } from '@badminton/ui';
import Link from 'next/link';
import { AuditList, type AuditLogRow } from './audit-list';

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

  const allSeasons = seasons ?? [];
  const activeSeason = allSeasons.find((s) => s.active_flag) ?? null;

  // Today as a local calendar date, to compare against DATE columns.
  const today = new Date().toLocaleDateString('en-CA');

  // A club activates the NEXT season before it starts — that is the normal way
  // to line one up. Defaulting to it then shows an empty page: the window opens
  // in the future, so nothing that has already happened is inside it. So the
  // default only uses the active season once it has actually begun.
  //
  // An explicit ?season= is honoured either way. Picking a season that has not
  // started and being shown nothing is a correct answer to a question somebody
  // asked; being shown nothing on arrival is not.
  const activeHasStarted = !!activeSeason?.start_date && activeSeason.start_date <= today;
  const selectedSeason = fullHistory
    ? null
    : season
      ? allSeasons.find((s) => s.id === season) ?? null
      : activeHasStarted
        ? activeSeason
        : null;

  // Caps keep the payload bounded either way.
  let query = supabase
    .from('audit_logs')
    .select('*, actor:players!audit_logs_actor_id_fkey(full_name)')
    .order('created_at', { ascending: false })
    .limit(fullHistory ? 1000 : 500);

  let eyebrow: string;
  if (fullHistory) {
    eyebrow = 'FULL HISTORY';
  } else if (selectedSeason) {
    query = query.gte('created_at', `${selectedSeason.start_date}T00:00:00Z`);
    // An unfinished season has no end: everything since it started, up to now.
    if (selectedSeason.end_date) {
      query = query.lt('created_at', dayAfter(selectedSeason.end_date));
    }
    eyebrow = selectedSeason.name.toUpperCase();
  } else {
    // No season to scope by: none active, or the active one has not started.
    // Falling back to a window keeps the page useful instead of empty, and the
    // eyebrow says which one so it cannot be mistaken for a season.
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    query = query.gte('created_at', since);
    eyebrow = 'LAST 30 DAYS';
  }

  const { data: logs } = await query;

  const linkBase =
    'text-xs px-2.5 py-1 rounded-full border transition-colors whitespace-nowrap';
  const linkOn = 'border-[var(--color-accent)] text-[var(--color-accent)]';
  const linkOff =
    'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--border-hover)]';

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={eyebrow}
        title="Audit Log"
        sub="Track all administrative actions."
        watermark="A"
      />

      {/* One chip per season, newest first, then the escape hatch. Rendered as
          links rather than a dropdown so the current view is readable from the
          URL and can be shared or bookmarked. */}
      <div className="flex flex-wrap items-center gap-2">
        {allSeasons.map((s) => {
          const isOn = !fullHistory && selectedSeason?.id === s.id;
          return (
            <Link
              key={s.id}
              href={s.active_flag && activeHasStarted ? '/audit' : `/audit?season=${s.id}`}
              className={`${linkBase} ${isOn ? linkOn : linkOff}`}
            >
              {s.name}
              {s.active_flag && ' ·  now'}
            </Link>
          );
        })}
        <Link
          href="/audit?range=all"
          className={`${linkBase} ${fullHistory ? linkOn : linkOff}`}
        >
          Full history →
        </Link>
      </div>

      <AuditList logs={(logs ?? []) as AuditLogRow[]} />
    </div>
  );
}
