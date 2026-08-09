import Link from 'next/link';

export interface ScopeSeason {
  id: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  active_flag: boolean;
}

/**
 * Which season a season-scoped page is showing, resolved once.
 *
 * Every scoped page had the same three lines — read the active season, filter by
 * it, show nothing else — and no way to look at a season the club is not
 * currently in. After a rollover that made last term's schedule, tournaments and
 * whole fee ledger unreachable from the console: the rows were still there and
 * still correctly stamped, but nothing in the UI could name a different season.
 *
 * `?season=<id>` overrides, so a particular term is a shareable link.
 */
export function resolveSeasonScope(
  seasons: ScopeSeason[] | null | undefined,
  seasonParam: string | undefined,
): { seasons: ScopeSeason[]; selected: ScopeSeason | null; isPast: boolean } {
  const all = seasons ?? [];
  const selected =
    (seasonParam ? all.find((s) => s.id === seasonParam) : null)
    ?? all.find((s) => s.active_flag)
    ?? null;

  // "Past" drives the read-only framing below, and is about the DATES rather
  // than the flag — a term whose last day has gone is history even if nobody
  // has activated the next one yet.
  const today = new Date().toLocaleDateString('en-CA');
  const isPast = !!selected && !!selected.end_date && selected.end_date < today;

  return { seasons: all, selected, isPast };
}

/**
 * The season switcher: one chip per season, newest first.
 *
 * Links rather than a dropdown so the current view is in the URL — readable,
 * shareable, and back/forward works. Same component on every scoped page so the
 * control does not have to be re-learned per page.
 */
export function SeasonScopeChips({
  seasons,
  selected,
  basePath,
}: {
  seasons: ScopeSeason[];
  selected: ScopeSeason | null;
  /** e.g. "/sessions" — the active season is the bare path, others carry ?season= */
  basePath: string;
}) {
  if (seasons.length < 2) return null;

  const base =
    'text-xs px-2.5 py-1 rounded-full border transition-colors whitespace-nowrap';
  const on = 'border-[var(--color-accent)] text-[var(--color-accent)]';
  const off =
    'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--border-hover)]';

  return (
    <div className="flex flex-wrap items-center gap-2">
      {seasons.map((s) => (
        <Link
          key={s.id}
          href={s.active_flag ? basePath : `${basePath}?season=${s.id}`}
          className={`${base} ${selected?.id === s.id ? on : off}`}
        >
          {s.name}
          {s.active_flag && ' ·  now'}
        </Link>
      ))}
    </div>
  );
}

/**
 * Says, once, that what is on screen is a finished term.
 *
 * Without it the only difference between this term and one from two years ago
 * is a chip somewhere above — and every page here has buttons that still look
 * live. Nothing is disabled: correcting an old record is legitimate and the
 * server actions already police what may change.
 */
export function PastSeasonNotice({ season }: { season: ScopeSeason }) {
  return (
    <p className="text-xs text-[var(--text-muted)]">
      Showing <span className="text-[var(--text-secondary)]">{season.name}</span>, a season that has ended.
      Anything created here would still be recorded against the current season.
    </p>
  );
}
