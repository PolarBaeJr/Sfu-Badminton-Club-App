// Ordering rules for a round-robin table.
//
// The tallying itself lives server-side (computeRoundRobinStandings) because it
// needs the matches out of the database; only the ORDER lives here, because it
// is pure, it decides who goes into a bracket, and it is the part worth testing
// without a database. Both the leaderboard and pool-to-bracket seeding call
// through this one comparator so a pool table can never disagree with the draw
// it produced.

/** How to rank a pool. NULL in the database behaves as 'wins'. */
export type SeedBy = 'wins' | 'points';

/** The tallied figures an ordering needs. Extra fields on the row are kept. */
export interface StandingEntry {
  id: string;
  wins: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
  gamesFor: number;
  gamesAgainst: number;
  /** Wins against each other entry, keyed by that entry's id. */
  h2h: Record<string, number>;
}

/**
 * Sort a tallied pool, highest finisher first.
 *
 * 'wins' is what a pool table is normally read by. 'points' suits a short pool
 * format where one game decides a match and margins say more about form than
 * the win column does — but only the FIRST key changes; everything below it is
 * the same chain, so the two orders differ only where they genuinely disagree.
 *
 * Head-to-head only breaks ties between the two entries being compared — it is
 * not transitive, so a multi-way tie falls through to the differentials.
 *
 * Sorts a copy: callers hold onto the tallied array for other purposes and an
 * in-place sort would reorder it underneath them.
 */
export function sortStandings<T extends StandingEntry>(
  entries: T[],
  seedBy: SeedBy | null | undefined = 'wins',
): T[] {
  const byPoints = seedBy === 'points';
  return [...entries].sort((a, b) => {
    const primary = byPoints ? b.pointsFor - a.pointsFor : b.wins - a.wins;
    if (primary !== 0) return primary;
    const h2h = (b.h2h[a.id] ?? 0) - (a.h2h[b.id] ?? 0);
    if (h2h !== 0) return h2h;
    const gameDiff = (b.gamesFor - b.gamesAgainst) - (a.gamesFor - a.gamesAgainst);
    if (gameDiff !== 0) return gameDiff;
    const pointDiff = (b.pointsFor - b.pointsAgainst) - (a.pointsFor - a.pointsAgainst);
    if (pointDiff !== 0) return pointDiff;
    return b.pointsFor - a.pointsFor;
  });
}
