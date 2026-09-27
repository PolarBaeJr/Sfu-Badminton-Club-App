// The ladder, from get_leaderboard(). Mirrors the web's tab filter and Elo sort
// (apps/player/src/app/leaderboard/leaderboard-client.tsx). The tournament
// points tab and the win-rate sort are not here yet.

export type LeaderboardTab = 'open_singles' | 'open_doubles' | 'comp_singles' | 'comp_doubles';

export const LEADERBOARD_TABS: { id: LeaderboardTab; label: string }[] = [
  { id: 'open_singles', label: 'Open S.' },
  { id: 'open_doubles', label: 'Open D.' },
  { id: 'comp_singles', label: 'Comp S.' },
  { id: 'comp_doubles', label: 'Comp D.' },
];

/** One get_leaderboard() row, narrowed to what the list draws. */
export interface LadderRow {
  id: string;
  name: string;
  handle: string | null;
  status: string;
  singles_elo: number | null;
  doubles_elo: number | null;
}

export interface RankedRow {
  row: LadderRow;
  /** Position in the list, 1-based. */
  rank: number;
  elo: number;
}

export function isDoublesTab(tab: LeaderboardTab): boolean {
  return tab.endsWith('doubles');
}

/**
 * The tab's ladder, ordered and numbered.
 *
 * Numbered by POSITION, as the web list is: tied members get consecutive
 * numbers in the order the (stable) sort leaves them. The My stats readout
 * uses ladderPosition() below instead, which is RANK() and lets ties share.
 */
export function rankLadder(rows: readonly LadderRow[], tab: LeaderboardTab): RankedRow[] {
  const doubles = isDoublesTab(tab);
  const eloOf = (r: LadderRow) => (doubles ? r.doubles_elo : r.singles_elo) ?? 0;
  const filtered = tab.startsWith('comp_') ? rows.filter((r) => r.status === 'competitive') : [...rows];
  return filtered
    .sort((a, b) => eloOf(b) - eloOf(a))
    .map((row, i) => ({ row, rank: i + 1, elo: eloOf(row) }));
}

/**
 * The member's place on the Open Singles ladder, as the web's My stats counts
 * it: 1 + the members strictly above, so tied members share a place.
 *
 * Null, never last place, when the member is not in the RPC's rows at all:
 * get_leaderboard leaves out pending, suspended, deactivated and hidden
 * members, and none of them has a ladder position.
 */
export function ladderPosition(
  rows: readonly { id: string; singles_elo: number | null }[],
  playerId: string,
  mySinglesElo: number | null,
): number | null {
  if (mySinglesElo === null) return null;
  if (!rows.some((r) => r.id === playerId)) return null;
  return 1 + rows.filter((r) => (r.singles_elo ?? 0) > mySinglesElo).length;
}
