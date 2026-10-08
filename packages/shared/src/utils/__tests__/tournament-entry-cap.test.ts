import { describe, it, expect } from 'vitest';
import {
  countEventEntriesPerPlayer,
  isAtEntryCap,
  entryCapRefusal,
  ENTRY_CAP_RELEASING_STATUSES,
  type EntryCapParticipantRow,
  type EntryCapPairRow,
} from '../tournament-entry-cap';

// THE WHOLE POINT OF THIS FILE is the doubles case. A cap counted over
// tournament_participants alone is a cap that silently does not apply to
// doubles entrants — they have no participant row at all — so the tests that
// matter most here are the ones where the only entries are pairs.

const P = (player_id: string, status?: string): EntryCapParticipantRow => ({ player_id, status });
const PAIR = (player1_id: string, player2_id: string, status?: string): EntryCapPairRow =>
  ({ player1_id, player2_id, status });

const ALICE = 'alice';
const BOB = 'bob';
const CARA = 'cara';

describe('countEventEntriesPerPlayer', () => {
  it('counts nothing when there is nothing', () => {
    expect(countEventEntriesPerPlayer([], []).size).toBe(0);
  });

  it('is absent rather than zero for somebody who has entered nothing', () => {
    const counts = countEventEntriesPerPlayer([P(ALICE)], []);
    expect(counts.get(BOB)).toBeUndefined();
    expect(counts.get(BOB) ?? 0).toBe(0);
  });

  // ---- singles only ----------------------------------------------------
  it('counts singles entries per player', () => {
    const counts = countEventEntriesPerPlayer([P(ALICE), P(ALICE), P(BOB)], []);
    expect(counts.get(ALICE)).toBe(2);
    expect(counts.get(BOB)).toBe(1);
  });

  // ---- doubles only ----------------------------------------------------
  // The bug this feature exists to avoid: three doubles entries under a cap of
  // two, with not a single tournament_participants row to show for them.
  it('counts doubles entries even though they create no participant row', () => {
    const counts = countEventEntriesPerPlayer([], [
      PAIR(ALICE, BOB),
      PAIR(ALICE, CARA),
      PAIR(ALICE, BOB),
    ]);
    expect(counts.get(ALICE)).toBe(3);
    expect(isAtEntryCap(counts.get(ALICE) ?? 0, 2)).toBe(true);
  });

  it('counts BOTH halves of a pair, one each', () => {
    const counts = countEventEntriesPerPlayer([], [PAIR(ALICE, BOB)]);
    expect(counts.get(ALICE)).toBe(1);
    expect(counts.get(BOB)).toBe(1);
  });

  // THE HALF THAT IS EASY TO MISS. A query written only against player1_id
  // makes this player invisible to the cap.
  it('counts a player who appears only as player2_id', () => {
    const counts = countEventEntriesPerPlayer([], [
      PAIR(ALICE, BOB),
      PAIR(CARA, BOB),
    ]);
    expect(counts.get(BOB)).toBe(2);
    expect(counts.get(ALICE)).toBe(1);
    expect(counts.get(CARA)).toBe(1);
  });

  it('counts a player across both sides of different pairs as one each', () => {
    const counts = countEventEntriesPerPlayer([], [
      PAIR(BOB, ALICE),
      PAIR(ALICE, CARA),
    ]);
    expect(counts.get(ALICE)).toBe(2);
  });

  // ---- mixed ------------------------------------------------------------
  it('adds singles and doubles together for the same player', () => {
    const counts = countEventEntriesPerPlayer(
      [P(ALICE), P(BOB)],
      [PAIR(ALICE, CARA), PAIR(BOB, ALICE)],
    );
    expect(counts.get(ALICE)).toBe(3); // one singles, two pairs
    expect(counts.get(BOB)).toBe(2);   // one singles, one pair
    expect(counts.get(CARA)).toBe(1);  // one pair
  });

  // ---- withdrawal frees the slot ---------------------------------------
  it('excludes a withdrawn singles entry', () => {
    const counts = countEventEntriesPerPlayer([P(ALICE, 'withdrawn'), P(ALICE, 'registered')], []);
    expect(counts.get(ALICE)).toBe(1);
  });

  it('excludes a disqualified singles entry', () => {
    const counts = countEventEntriesPerPlayer([P(ALICE, 'disqualified'), P(ALICE, 'registered')], []);
    expect(counts.get(ALICE)).toBe(1);
  });

  // A withdrawn PAIR releases the slot for BOTH halves — the pair is the entry.
  it('excludes a withdrawn pair for both halves', () => {
    const counts = countEventEntriesPerPlayer([], [
      PAIR(ALICE, BOB, 'withdrawn'),
      PAIR(ALICE, CARA, 'registered'),
    ]);
    expect(counts.get(ALICE)).toBe(1);
    expect(counts.get(BOB)).toBeUndefined();
    expect(counts.get(CARA)).toBe(1);
  });

  it('excludes a disqualified pair for both halves', () => {
    const counts = countEventEntriesPerPlayer([], [PAIR(ALICE, BOB, 'disqualified')]);
    expect(counts.size).toBe(0);
  });

  // A member at the cap who withdraws must be able to enter something else —
  // otherwise changing your mind locks you out of a tournament you are still
  // entitled to be in.
  it('lets a withdrawal put a capped member back under the cap', () => {
    const before = countEventEntriesPerPlayer([P(ALICE, 'registered')], [PAIR(ALICE, BOB, 'registered')]);
    expect(isAtEntryCap(before.get(ALICE) ?? 0, 2)).toBe(true);

    const after = countEventEntriesPerPlayer([P(ALICE, 'withdrawn')], [PAIR(ALICE, BOB, 'registered')]);
    expect(isAtEntryCap(after.get(ALICE) ?? 0, 2)).toBe(false);
  });

  // ---- statuses that still occupy a slot -------------------------------
  it('still counts checked_in and no_show', () => {
    const counts = countEventEntriesPerPlayer(
      [P(ALICE, 'checked_in'), P(ALICE, 'no_show')],
      [],
    );
    expect(counts.get(ALICE)).toBe(2);
  });

  it('counts a row with no status at all', () => {
    const counts = countEventEntriesPerPlayer([{ player_id: ALICE }], [
      { player1_id: ALICE, player2_id: BOB },
    ]);
    expect(counts.get(ALICE)).toBe(2);
  });

  it('counts a row whose status is null', () => {
    const counts = countEventEntriesPerPlayer([P(ALICE, undefined)], []);
    expect(counts.get(ALICE)).toBe(1);
  });

  // ---- degenerate data --------------------------------------------------
  it('charges one slot, not two, for a pair whose halves are the same player', () => {
    const counts = countEventEntriesPerPlayer([], [PAIR(ALICE, ALICE)]);
    expect(counts.get(ALICE)).toBe(1);
  });

  it('releases exactly the statuses it says it does', () => {
    expect([...ENTRY_CAP_RELEASING_STATUSES].sort()).toEqual(['disqualified', 'withdrawn']);
  });
});

describe('isAtEntryCap', () => {
  it('never refuses when the tournament is uncapped', () => {
    expect(isAtEntryCap(99, null)).toBe(false);
    expect(isAtEntryCap(99, undefined)).toBe(false);
  });

  it('refuses at the cap, not one past it', () => {
    expect(isAtEntryCap(1, 2)).toBe(false);
    expect(isAtEntryCap(2, 2)).toBe(true);
    expect(isAtEntryCap(3, 2)).toBe(true);
  });

  it('lets a member with nothing enter under any cap', () => {
    expect(isAtEntryCap(0, 1)).toBe(false);
  });

  // A cap of zero or less cannot reach the column (its CHECK refuses it), so
  // reaching it here means corrupt data — and barring every entry in the
  // tournament is a worse answer than ignoring a value that should not exist.
  it('treats a non-positive cap as uncapped rather than as barring everyone', () => {
    expect(isAtEntryCap(0, 0)).toBe(false);
    expect(isAtEntryCap(5, -1)).toBe(false);
  });
});

describe('entryCapRefusal', () => {
  it('names the person and the number', () => {
    expect(entryCapRefusal('Alice Chen', 2)).toBe(
      'Alice Chen is already entered in 2 events at this tournament, which is the limit.',
    );
  });

  it('says "event" when the cap is one', () => {
    expect(entryCapRefusal('Alice Chen', 1)).toContain('1 event at this tournament');
  });
});
