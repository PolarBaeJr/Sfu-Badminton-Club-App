/**
 * "Show me this season's <thing>" — the filter, in one place.
 *
 * Sessions, tournaments and anything else season-scoped should list the season
 * the club is actually playing, not everything ever recorded. Written once
 * because the rule has two edges that are easy to get wrong differently in each
 * copy, and by the fourth copy they had started to.
 *
 * NULL season_id is INCLUDED. A row without a season is unassigned, not "in
 * some other season" — filtering it out strands it on no page at all, with
 * nothing to reveal it exists. Both apps agree on this; a session that vanishes
 * from the console and the members' app equally is a support ticket nobody can
 * diagnose.
 *
 * NO ACTIVE SEASON means no filter. Hiding an entire schedule because nobody
 * pressed "activate" reads to a member as a cancelled club, and to an exec as a
 * broken page. Showing too much degrades gracefully; showing nothing does not.
 */
export function activeSeasonOrFilter(activeSeasonId: string | null | undefined): string | null {
  if (!activeSeasonId) return null;
  return `season_id.eq.${activeSeasonId},season_id.is.null`;
}

/** Minimal shape of a PostgREST builder, so this stays testable without one. */
interface OrFilterable<T> {
  or(filter: string): T;
}

/**
 * Applies the filter when there is a season to filter by, and returns the query
 * untouched when there is not. Callers read as one expression rather than an
 * if/else that each site could get subtly different.
 */
export function scopeToActiveSeason<T extends OrFilterable<T>>(
  query: T,
  activeSeasonId: string | null | undefined,
): T {
  const filter = activeSeasonOrFilter(activeSeasonId);
  return filter ? query.or(filter) : query;
}
