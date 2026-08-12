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

// ============================================================
// Group stage — several round-robin groups in one event (00106)
// ============================================================

/** A tallied row that also knows which group it was tallied in. */
export interface GroupedStandingEntry extends StandingEntry {
  /** 1-based group, or null for an entry that was never assigned one. */
  group: number | null;
}

/** A finished row, carrying where it came in its own group. */
export type QualificationEntry<T> = T & {
  /** 1-based finishing place WITHIN the entry's group. */
  groupRank: number;
};

/**
 * COMPARING ACROSS GROUPS IS NOT THE SAME QUESTION AS COMPARING INSIDE ONE.
 *
 * sortStandings' primary key is the raw win count, which is exactly right
 * within a group: everybody there played the same opponents the same number of
 * times, so 4 wins beats 3 wins and nothing else needs saying.
 *
 * It is wrong ACROSS groups, and unequal groups are the normal case — 24
 * entrants in 5 groups is 5,5,5,5,4. A 4-1 record and a 4-0 record are not the
 * same achievement, and raw wins calls them equal; worse, the entrant from the
 * larger group is FAVOURED by the extra fixture they were handed rather than
 * earned. So every key here is normalised by how much the entry actually
 * played, and the chain otherwise mirrors sortStandings key for key so the two
 * orders disagree only where they genuinely mean different things.
 *
 * Head-to-head is kept even though two entrants from different groups have by
 * definition never met: it costs nothing, reads 0 for them, and is the correct
 * tiebreak in the one case where it is not 0 — the same entrant pair appearing
 * in a re-run or a merged group.
 */
function compareAcrossGroups<T extends StandingEntry>(a: T, b: T, seedBy: SeedBy | null | undefined): number {
  // Matches, not games: a walkover has no scoreline but is still a result. Never
  // zero, so a group whose matches were all voided sorts by its zeros rather
  // than dividing by them.
  const playedA = Math.max(1, a.wins + a.losses);
  const playedB = Math.max(1, b.wins + b.losses);
  const gamesA = Math.max(1, a.gamesFor + a.gamesAgainst);
  const gamesB = Math.max(1, b.gamesFor + b.gamesAgainst);

  const primary = seedBy === 'points'
    ? b.pointsFor / gamesB - a.pointsFor / gamesA
    : b.wins / playedB - a.wins / playedA;
  if (primary !== 0) return primary;

  const h2h = (b.h2h[a.id] ?? 0) - (a.h2h[b.id] ?? 0);
  if (h2h !== 0) return h2h;

  const gameDiff = (b.gamesFor - b.gamesAgainst) / playedB - (a.gamesFor - a.gamesAgainst) / playedA;
  if (gameDiff !== 0) return gameDiff;

  const pointDiff = (b.pointsFor - b.pointsAgainst) / gamesB - (a.pointsFor - a.pointsAgainst) / gamesA;
  if (pointDiff !== 0) return pointDiff;

  return b.pointsFor / gamesB - a.pointsFor / gamesA;
}

/**
 * Read a group stage as ONE ordered list: winners, then runners-up, then thirds.
 *
 * THE ORDER IS THE WHOLE POINT AND IT IS NOT ARBITRARY. A knockout seeded off a
 * group stage wants every group WINNER in the top seeding tier and every
 * RUNNER-UP in the next one — that is what stops two group winners meeting in
 * round one, and it is the reason to run groups rather than one pool. So the
 * list is depth-major: all the 1st-placed finishers (best record first), then
 * all the 2nd-placed, then all the 3rd-placed, and so on until the deepest
 * group runs out. Slicing the first (qualifiers x groups) entries off the front
 * gives the qualifiers already in the tier order the draw wants.
 *
 * Within a group, sortStandings decides — same comparator the flat table and
 * pool-to-bracket seeding have always used, so a group's own table can never
 * disagree with the order its members enter the list in.
 *
 * Between groups at the same depth, compareAcrossGroups decides, because raw
 * wins are not comparable when the groups are different sizes. See above.
 *
 * Entries with a NULL group are treated as one extra group of their own rather
 * than dropped. They should not exist — assignment fills every entry before the
 * fixtures are made — but a standings function that silently loses somebody is
 * a worse failure than one that ranks them oddly.
 */
export function qualificationOrder<T extends GroupedStandingEntry>(
  entries: T[],
  seedBy: SeedBy | null | undefined = 'wins',
): Array<QualificationEntry<T>> {
  const byGroup = new Map<number, T[]>();
  for (const e of entries) {
    // 0 is the bucket for "no group", and cannot collide with a real one — the
    // CHECK constraint in 00106 makes group_number >= 1.
    const key = e.group ?? 0;
    const bucket = byGroup.get(key);
    if (bucket) bucket.push(e);
    else byGroup.set(key, [e]);
  }

  // Ascending group number, so the shape of the answer does not depend on the
  // order the rows came back from the database in.
  const groups = [...byGroup.keys()].sort((a, b) => a - b)
    .map((key) => sortStandings(byGroup.get(key)!, seedBy));

  const deepest = groups.reduce((max, g) => Math.max(max, g.length), 0);
  const out: Array<QualificationEntry<T>> = [];

  for (let depth = 0; depth < deepest; depth++) {
    const tier: Array<QualificationEntry<T>> = [];
    for (const group of groups) {
      const entry = group[depth];
      // A shallower group simply contributes nobody to this tier. It does NOT
      // shift its later finishers up: a 4-group stage where one group has five
      // members must still put all four group winners ahead of every runner-up.
      if (entry) tier.push({ ...entry, groupRank: depth + 1 });
    }
    tier.sort((a, b) => compareAcrossGroups(a, b, seedBy));
    out.push(...tier);
  }

  return out;
}

/**
 * Serpentine ("snake") assignment of a seeded field into `groupCount` groups.
 *
 * PUTTING SEEDS 1-4 IN GROUP A IS THE FAILURE MODE THAT MAKES THE WHOLE FORMAT
 * POINTLESS: three of the four best entrants are eliminated by each other
 * before the knockout, and group D qualifies two people who would not have made
 * the last sixteen. Straight dealing (1,2,3,4 then 5,6,7,8 all to A,B,C,D) is
 * already balanced for the top band but skews cumulatively — group A collects
 * seeds 1,5,9,13 and group D collects 4,8,12,16, so A is stronger at every
 * level. Serpentine reverses direction each pass, so A gets 1,8,9,16 and D gets
 * 4,5,12,13, and the total seed weight of every group is as close to equal as
 * an integer split allows.
 *
 * @param count how many entrants there are, in seeding order (best first)
 * @returns groupOfIndex[i] — the 1-based group for the i-th best entrant
 */
export function snakeGroupAssignment(count: number, groupCount: number): number[] {
  if (groupCount < 2) return new Array(Math.max(0, count)).fill(1);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const pass = Math.floor(i / groupCount);
    const within = i % groupCount;
    // Odd passes deal right-to-left. That single reversal is the entire
    // difference between snake and straight dealing.
    out.push((pass % 2 === 0 ? within : groupCount - 1 - within) + 1);
  }
  return out;
}
