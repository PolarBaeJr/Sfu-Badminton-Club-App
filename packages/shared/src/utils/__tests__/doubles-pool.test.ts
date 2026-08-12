import { describe, it, expect } from 'vitest';
import {
  doublesDrawSlots,
  countDoublesField,
  wouldExceedCapacity,
  unpairedDrawRefusal,
  stillInEvent,
} from '../doubles-pool';
import {
  countEventEntriesPerPlayer,
  isAtEntryCap,
  type EntryCapParticipantRow,
  type EntryCapPairRow,
} from '../tournament-entry-cap';
import { screenForEventWaiver, type AcceptedEventWaiver } from '../event-waiver-eligibility';

// A DOUBLES EVENT IS A POOL: some entrants arrive already paired, some arrive
// alone and are paired later (migration 00102). An unpaired entrant is a
// tournament_participants row; pairing PROMOTES two of them into one
// tournament_pairs row.
//
// Four things that landed the same week have to keep working across that
// promotion, and every one of them is a way to charge somebody twice or leave
// somebody out. They are the four `describe` blocks at the bottom of this file,
// and they are the reason it exists.

const ALICE = 'alice';
const BOB = 'bob';
const CARA = 'cara';
const DAN = 'dan';

const P = (player_id: string, status?: string): EntryCapParticipantRow => ({ player_id, status });
const PAIR = (player1_id: string, player2_id: string, status?: string): EntryCapPairRow =>
  ({ player1_id, player2_id, status });

describe('doublesDrawSlots', () => {
  it('is exactly the pair count when nobody is waiting', () => {
    // THE PROPERTY THAT MAKES THIS SAFE TO SHIP. max_participants has always
    // been compared against a count of tournament_pairs rows, so every doubles
    // event that exists today must come out at the number it comes out at now.
    for (const pairs of [0, 1, 7, 64]) {
      expect(doublesDrawSlots(pairs, 0)).toBe(pairs);
    }
  });

  it('counts two people waiting as one prospective team', () => {
    expect(doublesDrawSlots(0, 2)).toBe(1);
    expect(doublesDrawSlots(3, 4)).toBe(5);
  });

  it('rounds a lone waiting person UP to a whole slot', () => {
    // They still need a partner, so they still need somewhere to play.
    expect(doublesDrawSlots(0, 1)).toBe(1);
    expect(doublesDrawSlots(3, 1)).toBe(4);
    expect(doublesDrawSlots(3, 5)).toBe(6);
  });

  it('PAIRING IS SLOT-NEUTRAL, for every field it could be applied to', () => {
    // The invariant the whole capacity story rests on. Promotion turns two
    // waiting people into one team and must not move the number, or an exec
    // would be told the event is full by an operation that added nobody to it —
    // in an event that is full BECAUSE those two are in it.
    for (let pairs = 0; pairs <= 12; pairs++) {
      for (let unpaired = 2; unpaired <= 12; unpaired++) {
        expect(doublesDrawSlots(pairs + 1, unpaired - 2)).toBe(doublesDrawSlots(pairs, unpaired));
      }
    }
  });

  it('UNPAIRING IS SLOT-NEUTRAL TOO, which is the same identity read backwards', () => {
    for (let pairs = 1; pairs <= 12; pairs++) {
      for (let unpaired = 0; unpaired <= 12; unpaired++) {
        expect(doublesDrawSlots(pairs - 1, unpaired + 2)).toBe(doublesDrawSlots(pairs, unpaired));
      }
    }
  });

  it('treats nonsense as zero rather than as a negative slot count', () => {
    expect(doublesDrawSlots(-3, -3)).toBe(0);
  });
});

describe('countDoublesField', () => {
  it('ignores entries that have left, on both sides', () => {
    // Same rule the entry cap applies, and for the same reason: a withdrawn
    // entry is not occupying a place in the draw.
    const field = countDoublesField(
      [P(ALICE), P(BOB, 'withdrawn'), P(CARA, 'disqualified')],
      [PAIR(DAN, 'eve'), PAIR('fay', 'gus', 'withdrawn')],
    );
    expect(field).toEqual({ unpaired: 1, pairs: 1, slots: 2 });
  });

  it('counts no_show, because that is a place somebody took and did not use', () => {
    expect(stillInEvent('no_show')).toBe(true);
    expect(stillInEvent('checked_in')).toBe(true);
    expect(stillInEvent('withdrawn')).toBe(false);
  });
});

describe('wouldExceedCapacity', () => {
  it('allows anything when the event is uncapped', () => {
    for (const max of [null, undefined, 0, -1]) {
      expect(wouldExceedCapacity(0, 999, max)).toBe(false);
    }
  });

  it('refuses an operation that pushes the field over the line', () => {
    expect(wouldExceedCapacity(8, 9, 8)).toBe(true);
  });

  it('allows an operation that lands exactly on the line', () => {
    expect(wouldExceedCapacity(7, 8, 8)).toBe(false);
  });

  it('NEVER REFUSES A NEUTRAL OPERATION, even in an over-full event', () => {
    // The limit was lowered, or the rows predate it. Refusing the pairing that
    // does not move the number would leave the event exactly as over-full as it
    // was and take away the only tidying-up the exec can do.
    expect(wouldExceedCapacity(12, 12, 8)).toBe(false);
    // And a shrinking one is always fine.
    expect(wouldExceedCapacity(12, 11, 8)).toBe(false);
  });
});

describe('unpairedDrawRefusal', () => {
  it('says nothing when everybody is paired', () => {
    expect(unpairedDrawRefusal([])).toBe('');
  });

  it('NAMES them, and offers both remedies', () => {
    // A draw that stops without saying who is holding it up is a draw the exec
    // cannot un-stop. Both remedies are real, so both are offered.
    const message = unpairedDrawRefusal(['Alice Chen', 'Bob Ng']);
    expect(message).toContain('Alice Chen');
    expect(message).toContain('Bob Ng');
    expect(message).toContain('The draw was not generated');
    expect(message).toContain('pair them up');
    expect(message).toContain('take them out');
  });

  it('reads as English for one person', () => {
    expect(unpairedDrawRefusal(['Alice Chen'])).toContain('Alice Chen has entered');
    expect(unpairedDrawRefusal(['Alice Chen', 'Bob Ng'])).toContain('have entered');
  });
});

// ===========================================================================
// INTERACTION 1 — THE ENTRY CAP ACROSS A PROMOTION
// ===========================================================================
// countEventEntriesPerPlayer counts participants PLUS both halves of every
// pair. An unpaired entrant must count ONCE, and must not count twice the
// moment they are paired.

describe('the entry cap across a promotion', () => {
  it('counts an unpaired entrant exactly once', () => {
    const counts = countEventEntriesPerPlayer([P(ALICE), P(BOB)], []);
    expect(counts.get(ALICE)).toBe(1);
    expect(counts.get(BOB)).toBe(1);
  });

  it('COUNTS THE SAME AFTER PAIRING AS BEFORE — the whole promotion invariant', () => {
    // Before: two people loose in the pool. After: one pair, and their
    // participant rows GONE — which is what pair_tournament_entrants deletes in
    // the same transaction as the insert.
    const before = countEventEntriesPerPlayer([P(ALICE), P(BOB)], []);
    const after = countEventEntriesPerPlayer([], [PAIR(ALICE, BOB)]);

    expect(after.get(ALICE)).toBe(before.get(ALICE));
    expect(after.get(BOB)).toBe(before.get(BOB));
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
  });

  it('counts them TWICE if the pool rows survive the promotion — the failure 00102 exists to prevent', () => {
    // This is the state a non-atomic delete-then-insert can be interrupted in,
    // and it is why the promotion is a plpgsql function and not two PostgREST
    // round trips. Asserted rather than described, so that anyone tempted to
    // move the delete into TypeScript can see the number it produces.
    const broken = countEventEntriesPerPlayer([P(ALICE), P(BOB)], [PAIR(ALICE, BOB)]);
    expect(broken.get(ALICE)).toBe(2);
    expect(broken.get(BOB)).toBe(2);
  });

  it('does not lock a promoted entrant out of a tournament capped at one event', () => {
    // The subtraction in addPairToEvent, in the terms the cap sees it. At a cap
    // of 1, somebody who entered a doubles event alone is already AT the limit;
    // pairing them spends no new slot, so the check has to discount the pool row
    // the pair is about to consume.
    const cap = 1;
    const counts = countEventEntriesPerPlayer([P(ALICE), P(BOB)], []);

    expect(isAtEntryCap(counts.get(ALICE) ?? 0, cap)).toBe(true);
    const spent = (counts.get(ALICE) ?? 0) - 1; // they are in this event's pool
    expect(isAtEntryCap(spent, cap)).toBe(false);
  });

  it('still refuses somebody genuinely at their limit in ANOTHER event', () => {
    // The discount is only ever for a pool row in THIS event. Alice is in a
    // singles event elsewhere at this tournament and has no pool row here, so
    // nothing is subtracted and the cap holds.
    const cap = 1;
    const counts = countEventEntriesPerPlayer([P(ALICE)], []);
    const spent = (counts.get(ALICE) ?? 0) - 0;
    expect(isAtEntryCap(spent, cap)).toBe(true);
  });

  it('gives the slot back when one half of a pair withdraws', () => {
    // withdrawPairMember writes the leaver back as a 'withdrawn' participant
    // row and the partner as an ordinary one. The leaver releases their slot —
    // every withdrawal does — and the partner keeps theirs.
    const after = countEventEntriesPerPlayer([P(ALICE, 'withdrawn'), P(BOB)], []);
    expect(after.get(ALICE)).toBeUndefined();
    expect(after.get(BOB)).toBe(1);
  });
});

// ===========================================================================
// INTERACTION 2 — THE EVENT WAIVER
// ===========================================================================
// A pair is blocked if EITHER half is unsigned. A solo entrant needs the same
// push AT ENTRY, not at pairing — being paired is not the moment they agreed
// to anything.

describe('the event waiver across a promotion', () => {
  const HASH = 'sha-of-the-current-wording';
  const signed = (player_id: string): AcceptedEventWaiver =>
    ({ player_id, waiver_hash: HASH, accepted_at: '2026-08-01T00:00:00Z' });

  it('blocks an unpaired entrant who has not signed, exactly as it blocks a pair', () => {
    const { allowed, blocked } = screenForEventWaiver(
      [
        { id: 'pool-alice', members: [{ id: ALICE, name: 'Alice' }] },
        { id: 'pool-bob', members: [{ id: BOB, name: 'Bob' }] },
      ],
      HASH,
      [signed(ALICE)],
    );
    expect(allowed).toEqual(['pool-alice']);
    expect(blocked.map((b) => b.id)).toEqual(['pool-bob']);
  });

  it('carries an unsigned half straight through the promotion', () => {
    // The state the pool was in is the state the pair is in. Nothing about
    // pairing signs anything, and nothing about pairing un-signs anything —
    // an acceptance is per member per TOURNAMENT and was never a fact about
    // who they were playing with.
    const poolScreen = screenForEventWaiver(
      [
        { id: 'pool-alice', members: [{ id: ALICE, name: 'Alice' }] },
        { id: 'pool-bob', members: [{ id: BOB, name: 'Bob' }] },
      ],
      HASH,
      [signed(ALICE)],
    );
    const pairScreen = screenForEventWaiver(
      [{ id: 'pair', members: [{ id: ALICE, name: 'Alice' }, { id: BOB, name: 'Bob' }] }],
      HASH,
      [signed(ALICE)],
    );

    // Bob was blocked before pairing and the pair is blocked after it, naming
    // Bob and only Bob. Alice is not accused of anything either side.
    expect(poolScreen.blocked.flatMap((b) => b.unsigned.map((u) => u.id))).toEqual([BOB]);
    expect(pairScreen.allowed).toEqual([]);
    expect(pairScreen.blocked[0]!.unsigned.map((u) => u.id)).toEqual([BOB]);
  });

  it('lets the promoted pair through once both halves have signed', () => {
    const { allowed, blocked } = screenForEventWaiver(
      [{ id: 'pair', members: [{ id: ALICE, name: 'Alice' }, { id: BOB, name: 'Bob' }] }],
      HASH,
      [signed(ALICE), signed(BOB)],
    );
    expect(allowed).toEqual(['pair']);
    expect(blocked).toEqual([]);
  });

  it('leaves the partner signed when the other half withdraws', () => {
    // withdrawPairMember touches no acceptance. The partner returns to the pool
    // already eligible, which is one of the three things they keep.
    const { allowed } = screenForEventWaiver(
      [{ id: 'pool-bob', members: [{ id: BOB, name: 'Bob' }] }],
      HASH,
      [signed(ALICE), signed(BOB)],
    );
    expect(allowed).toEqual(['pool-bob']);
  });
});

// ===========================================================================
// INTERACTION 3 — FEES
// ===========================================================================
// See doubles-pool-fees.test.ts: ensureEntryFees is exercised against a real
// mock client there, because "does the second call write a second row" is a
// question about the query it issues and not about a pure function.

// ===========================================================================
// INTERACTION 4 — CAPACITY, AS THE ACTIONS APPLY IT
// ===========================================================================

describe('max_participants across the pool', () => {
  it('lets an event full of pairs still be paired up', () => {
    // Eight teams' worth of people, four of them still loose. The event is at
    // its limit either way, and pairing the loose four must not be refused.
    const max = 8;
    const field = countDoublesField(
      [P('a'), P('b'), P('c'), P('d')],
      Array.from({ length: 6 }, (_, i) => PAIR(`x${i}`, `y${i}`)),
    );
    expect(field.slots).toBe(8);
    const afterPairing = doublesDrawSlots(field.pairs + 1, field.unpaired - 2);
    expect(wouldExceedCapacity(field.slots, afterPairing, max)).toBe(false);
  });

  it('refuses a ninth prospective team in an event with room for eight', () => {
    const max = 8;
    const field = countDoublesField([], Array.from({ length: 8 }, (_, i) => PAIR(`x${i}`, `y${i}`)));
    const afterSoloAdd = doublesDrawSlots(field.pairs, field.unpaired + 1);
    expect(wouldExceedCapacity(field.slots, afterSoloAdd, max)).toBe(true);
  });

  it('lets a second person fill out a slot the first one already opened', () => {
    // Seven teams and one person waiting is already eight slots. The eighth
    // team's second member costs nothing.
    const max = 8;
    const field = countDoublesField([P('a')], Array.from({ length: 7 }, (_, i) => PAIR(`x${i}`, `y${i}`)));
    expect(field.slots).toBe(8);
    const afterSoloAdd = doublesDrawSlots(field.pairs, field.unpaired + 1);
    expect(wouldExceedCapacity(field.slots, afterSoloAdd, max)).toBe(false);
  });

  it('computes the batch room exactly — 2 * (max - pairs) - unpaired', () => {
    // The formula addParticipantsToEvent slices its candidate list with. Checked
    // against the slot function rather than against itself.
    const max = 8;
    for (const pairs of [0, 3, 7, 8, 9]) {
      for (const unpaired of [0, 1, 5]) {
        const room = Math.max(Math.max(max - pairs, 0) * 2 - unpaired, 0);
        // Everybody inside `room` fits…
        expect(doublesDrawSlots(pairs, unpaired + room)).toBeLessThanOrEqual(Math.max(max, doublesDrawSlots(pairs, unpaired)));
        // …and the next one does not, unless the event was already over.
        if (doublesDrawSlots(pairs, unpaired) <= max) {
          expect(doublesDrawSlots(pairs, unpaired + room + 1)).toBeGreaterThan(max);
        }
      }
    }
  });
});
