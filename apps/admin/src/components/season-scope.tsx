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
