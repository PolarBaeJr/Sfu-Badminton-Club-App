import { describe, expect, it } from 'vitest';
import {
  isVisibleOnLadder,
  pastLeaderboardEntries,
  type SnapshotPlayer,
  type SnapshotRow,
} from '../past-leaderboard';

/**
 * The finished season's ladder, checked where it can be: the pure reshape.
 *
 * Two properties matter here and both are about what the list does NOT contain.
 * The archive is the roster of record for a term, so a present-day member with no
 * row in it must be absent rather than present on a zero; and the service role
 * has no database backstop, so the three visibility predicates are enforced here
 * as well as in the query.
 */
const member = (id: string, over: Partial<SnapshotPlayer> = {}): SnapshotRow => ({
  singles_elo: 1500,
  doubles_elo: 1400,
  archived_at: '2027-01-02T01:00:00Z',
  player: {
    id,
    full_name: `Member ${id}`,
    handle: id.toLowerCase(),
    avatar_url: null,
    status: 'competitive',
    active_flag: true,
    hide_from_leaderboard: false,
    ...over,
  },
});

describe('a past season is the archive and not the roster', () => {
  it('lists exactly the members who have an archived row', () => {
    const entries = pastLeaderboardEntries([member('A'), member('B')]);
    expect(entries.map((e) => e.id)).toEqual(['A', 'B']);
  });

  // THE BACKFILL TEST. C is a member of the club today and was not on the ladder
  // when this term was closed off, so C has no row in season_final_ratings. The
  // rejected implementation drives from `players` and left-joins the archive,
  // which puts C in the final standings of a season they were never in, on a null
  // or a zero that renders as a rating.
  it('does not invent a row for a member who was not in the season', () => {
    const entries = pastLeaderboardEntries([member('A'), member('B')]);

    expect(entries.some((e) => e.id === 'C')).toBe(false);
    expect(entries.every((e) => e.ratings !== null)).toBe(true);
    expect(entries.some((e) => e.ratings?.singles_elo === 0)).toBe(false);
    expect(entries.some((e) => e.ratings?.doubles_elo === 0)).toBe(false);
  });
});

describe('the visibility predicates get_leaderboard() applies', () => {
  // A survivor in every case, so an implementation that returns [] fails these
  // rather than passing them.
  const control = member('KEEP');

  it('drops a deactivated member', () => {
    const entries = pastLeaderboardEntries([control, member('GONE', { active_flag: false })]);
    expect(entries.map((e) => e.id)).toEqual(['KEEP']);
  });

  it('drops a member who opted out of the leaderboard', () => {
    const entries = pastLeaderboardEntries([
      control,
      member('HIDDEN', { hide_from_leaderboard: true }),
    ]);
    expect(entries.map((e) => e.id)).toEqual(['KEEP']);
  });

  it('drops a member awaiting approval', () => {
    const entries = pastLeaderboardEntries([
      control,
      member('PENDING', { status: 'pending_approval' }),
    ]);
    expect(entries.map((e) => e.id)).toEqual(['KEEP']);
  });

  it('drops a suspended member', () => {
    const entries = pastLeaderboardEntries([
      control,
      member('SUSPENDED', { status: 'suspended' }),
    ]);
    expect(entries.map((e) => e.id)).toEqual(['KEEP']);
  });

  // FAILING CLOSED is the whole reason the predicates are `=== true` and
  // `=== false` rather than truthiness tests. A select that forgets to ask for
  // `active_flag` hands every player an `undefined`, and the permissive spelling
  // turns that query bug into a public page listing members who opted out.
  it('drops a row whose player is missing or whose flags did not come back', () => {
    const noEmbed = { ...member('X'), player: null } as SnapshotRow;
    const noFlag = member('Y');
    delete (noFlag.player as SnapshotPlayer).active_flag;

    const entries = pastLeaderboardEntries([control, noEmbed, noFlag]);
    expect(entries.map((e) => e.id)).toEqual(['KEEP']);
    expect(isVisibleOnLadder({ status: 'competitive', hide_from_leaderboard: false })).toBe(false);
  });
});

describe('an archived entry carries the Elo and nothing else', () => {
  // Nothing stores a per-season record, streak or points total, so the fields are
  // ABSENT rather than zeroed: a zero record renders as "0-0 · 0%", which is a
  // claim about the member's term and not a gap in the data.
  it('has no record, streak, provisional flag or tournament points', () => {
    const entry = pastLeaderboardEntries([member('A')])[0];
    const ratings = entry?.ratings;

    expect(ratings).toEqual({ singles_elo: 1500, doubles_elo: 1400 });
    expect(ratings && 'singles_wins' in ratings).toBe(false);
    expect(ratings && 'doubles_losses' in ratings).toBe(false);
    expect(ratings && 'singles_provisional' in ratings).toBe(false);
    expect(ratings && 'current_singles_streak' in ratings).toBe(false);
    expect(entry?._tournamentPoints).toBeUndefined();
  });
});
