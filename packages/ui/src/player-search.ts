/**
 * Searching people by name — the matching, not the control.
 *
 * This lives in a plain .ts module with no React import and no JSX on purpose.
 * It began inside PlayerPicker.tsx, whose comment already promised it was
 * "pure and React-free"; sitting in a `'use client'` component file made that
 * true only in spirit, and meant it could not be imported by anything that was
 * not already rendering — a unit test, most obviously. Every caller still
 * reaches it through `@badminton/ui`, which re-exports both functions, so the
 * move is invisible to them.
 *
 * One implementation, three callers: the challenge picker (PlayerPicker), the
 * admin roster, and the two-sided lists (challenges, matches). They cannot
 * drift, which is the whole point — an admin who learns that typing "chen"
 * finds Chen in one place should not have to relearn it in the next.
 */

const norm = (s: string) => s.toLowerCase().trim();

/**
 * The query, with a leading `@` removed. A handle is WRITTEN `@kiera` and
 * STORED `kiera`, so requiring the `@` would mean the club's own notation
 * matched nothing — and demanding it would be worse, because then the obvious
 * thing to type finds nobody. Both spellings are the same search.
 */
export const normalizeSearchQuery = (query: string) => norm(query).replace(/^@+/, '');

/** Prefix > word-prefix > substring, so typing "ma" surfaces "Matthew" ahead of
 *  "Roman". Ties keep the caller's order (usually alphabetical). */
function rankOfText(text: string, q: string): number {
  const t = norm(text);
  if (t.startsWith(q)) return 0;
  if (t.split(/\s+/).some((w) => w.startsWith(q))) return 1;
  if (t.includes(q)) return 2;
  return 3;
}

/**
 * The best rank across the two things a person is CALLED.
 *
 * The handle is ranked exactly like the name, deliberately, and not folded into
 * `meta` where it would have been a one-line change. A meta match keeps rank 3
 * and sorts below every name match, including a bare substring — so `kiera`
 * would have put @kiera underneath "Akierabayashi". For the field whose entire
 * job is to be the searchable identifier, that is backwards.
 */
function rankOf(option: { name: string; handle?: string | null }, q: string): number {
  const byName = rankOfText(option.name, q);
  if (!option.handle) return byName;
  return Math.min(byName, rankOfText(option.handle, q));
}

/**
 * Rank and filter a list of people: same ranking, same handle matching, same
 * email fallback, same "empty query means everyone" wherever it is used.
 * Generic over the row type because a roster row carries a rendered table row
 * alongside its name; only `name`, `handle` and `meta` are read.
 */
export function filterPlayerOptions<T extends { name: string; handle?: string | null; meta?: string | null }>(
  options: T[],
  query: string,
): T[] {
  const q = normalizeSearchQuery(query);
  if (!q) return options;
  return options
    .map((p, i) => ({ p, i, rank: rankOf(p, q) }))
    .filter(({ p, rank }) => rank < 3 || norm(p.meta ?? '').includes(q))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ p }) => p);
}

/**
 * The same matching, for a row that is about SEVERAL people rather than one —
 * a challenge, a match, anything with two sides. A row matches when ANY name on
 * it matches: either side, your partner or your opponent. That is the question
 * an admin actually asks ("show me Chen's games"), and narrowing to one side or
 * to an exact pairing would answer a question nobody asked while hiding half
 * the rows that mention the person typed.
 *
 * Two deliberate differences from filterPlayerOptions:
 *
 *  - Names are joined with spaces and NOTHING else. The "&" and "vs" a row
 *    displays are not part of the search key, or typing "vs" would match every
 *    doubles row on the page.
 *  - The caller's order is preserved. filterPlayerOptions re-ranks, which is
 *    right for a picker and wrong here: these lists are newest-first, and that
 *    ordering is information. So the shared function decides only WHICH rows
 *    match; the page keeps deciding what order they come in.
 */
export function filterRowsByPlayers<T extends { id: string; players: string[]; meta?: string | null }>(
  rows: T[],
  query: string,
): T[] {
  if (!normalizeSearchQuery(query)) return rows;
  const matched = new Set(
    filterPlayerOptions(
      rows.map((r) => ({
        id: r.id,
        name: r.players.filter(Boolean).join(' '),
        meta: r.meta,
      })),
      query,
    ).map((k) => k.id),
  );
  return rows.filter((r) => matched.has(r.id));
}
