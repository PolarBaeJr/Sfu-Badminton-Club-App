/**
 * Searching a member's match list.
 *
 * Deliberately NOT `filterPlayerOptions` (the roster search) or
 * `filterRowsByPlayers` (the /challenges and /matches search). Both of those
 * rank PEOPLE, and every row here belongs to the same person — ranking by name
 * would sort a member's own history by their own name and return it unchanged.
 * What distinguishes one row from another is the result, the score, the format
 * and the date, so those are what this searches.
 */

export interface MatchSearchRow<T> {
  id: string;
  /** Everything about the row a person might type, already lower-cased. */
  keys: string;
  value: T;
}

/**
 * Build the haystack for one match row.
 *
 * `win`/`loss` AND the bare `w`/`l` are both included so either reflex works —
 * the table draws a W/L badge, but "wins" is what someone says out loud.
 * Nulls become an empty string rather than the text "null", which would
 * otherwise make every unscored match findable by typing `null`.
 */
export function matchSearchKeys(parts: {
  win: boolean;
  score: string | null;
  format: string | null;
  playedAt: string | null;
}): string {
  const result = parts.win ? 'win w' : 'loss l';
  return [result, parts.score ?? '', parts.format ?? '', parts.playedAt ?? '']
    .join(' ')
    .toLowerCase();
}

/**
 * Every term must match, in any order and anywhere in the row — so "win 21"
 * finds a won match with a 21 in the score, and "21 win" finds the same one.
 * An all-whitespace query is not a filter; it returns everything rather than
 * matching nothing, which is what splitting on spaces would otherwise do.
 */
export function filterMatchRows<T>(rows: MatchSearchRow<T>[], query: string): MatchSearchRow<T>[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return rows;
  return rows.filter((row) => terms.every((term) => row.keys.includes(term)));
}
