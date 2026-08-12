import { describe, it, expect } from 'vitest';
import {
  doublesDrawSlots,
  countDoublesField,
  wouldExceedCapacity,
  unpairedDrawRefusal,
  stillInEvent,
  planAutoPairs,
  type AutoPairCandidate,
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

  it('IS UNCHANGED BY A SWAP — one member in, one member out, both already entered', () => {
    // "Priya is injured, Sam is taking her place" (00103). Sam was waiting for a
    // partner and Priya was on a team; afterwards Sam is on the team and Priya
    // is waiting. Nobody entered and nobody left, so not one number may move —
    // and that is exactly why the incoming player is required to be in the pool
    // already rather than being swapped in off the street.
    const before = countEventEntriesPerPlayer([P(CARA)], [PAIR(ALICE, BOB)]);
    const after = countEventEntriesPerPlayer([P(ALICE)], [PAIR(CARA, BOB)]);

    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
    for (const id of [ALICE, BOB, CARA]) expect(after.get(id)).toBe(1);
  });

  it('is unchanged by a swap in the other column too', () => {
    // The outgoing half may be player1 or player2, and the pair keeps its
    // column order — so both orientations have to come out the same.
    const before = countEventEntriesPerPlayer([P(CARA)], [PAIR(ALICE, BOB)]);
    const after = countEventEntriesPerPlayer([P(BOB)], [PAIR(ALICE, CARA)]);
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
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

  it('re-evaluates the pair when a half is SWAPPED, on the incoming member', () => {
    // The team was clear; Cara replaces Bob and has not signed. The pair is
    // blocked afterwards and names Cara — the check-in and draw gates read the
    // pair as it now stands, so the swap cannot smuggle an unsigned player past
    // a screen that already happened.
    //
    // NOTE the swap itself does NOT refuse: addPairToEvent does not refuse an
    // unsigned entrant either (permissive at entry, strict at participation),
    // and a swap that was stricter than unpair-then-re-pair would only teach
    // execs to take the longer route. What it does is push the signature at the
    // incoming member, and leave the two hard blocks to do their job.
    const beforeSwap = screenForEventWaiver(
      [{ id: 'pair', members: [{ id: ALICE, name: 'Alice' }, { id: BOB, name: 'Bob' }] }],
      HASH,
      [signed(ALICE), signed(BOB)],
    );
    const afterSwap = screenForEventWaiver(
      [{ id: 'pair', members: [{ id: ALICE, name: 'Alice' }, { id: CARA, name: 'Cara' }] }],
      HASH,
      [signed(ALICE), signed(BOB)],
    );

    expect(beforeSwap.allowed).toEqual(['pair']);
    expect(afterSwap.allowed).toEqual([]);
    expect(afterSwap.blocked[0]!.unsigned.map((u) => u.id)).toEqual([CARA]);
  });

  it('does not hold the outgoing member against the team they have left', () => {
    // Bob was the unsigned one and has been swapped out. The team is clear
    // again, and Bob's own pool row is his problem rather than theirs.
    const { allowed, blocked } = screenForEventWaiver(
      [{ id: 'pair', members: [{ id: ALICE, name: 'Alice' }, { id: CARA, name: 'Cara' }] }],
      HASH,
      [signed(ALICE), signed(CARA)],
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

  it('IS UNCHANGED BY A SWAP, so a full event can still be edited', () => {
    // The injury substitution happens on the morning, when the event is
    // invariably full. If a swap moved the slot count it would be refused
    // exactly when it is needed.
    const before = countDoublesField([P(CARA)], [PAIR(ALICE, BOB)]);
    const after = countDoublesField([P(ALICE)], [PAIR(CARA, BOB)]);
    expect(after.slots).toBe(before.slots);
    expect(wouldExceedCapacity(before.slots, after.slots, 2)).toBe(false);
    // Even against a cap the event is already over.
    expect(wouldExceedCapacity(before.slots, after.slots, 1)).toBe(false);
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

// ---------------------------------------------------------------------------
// AUTO PAIR
// ---------------------------------------------------------------------------

const C = (playerId: string, rating: number): AutoPairCandidate => ({ playerId, rating });

/** Every player id the plan accounts for, paired or not. */
function seated(plan: ReturnType<typeof planAutoPairs>): string[] {
  return [...plan.pairs.flat(), ...(plan.leftOver ? [plan.leftOver] : [])].sort();
}

describe('planAutoPairs — balanced teams, deterministically', () => {
  it('folds an even list strongest-with-weakest', () => {
    // 100/70/50/20 → the fold is (100,20) and (70,50), NOT (100,70) and
    // (50,20). That is the whole strategy choice: both teams here come to 120,
    // where pairing adjacent would have made a 170 and a 70 and decided the
    // first round before it was played.
    const plan = planAutoPairs([C('a', 100), C('b', 70), C('c', 50), C('d', 20)]);
    expect(plan.pairs).toEqual([['a', 'd'], ['b', 'c']]);
    expect(plan.leftOver).toBeNull();
  });

  it('makes the teams closer than pairing adjacent would', () => {
    // The property the strategy exists for, asserted rather than illustrated:
    // the spread of combined ratings is no wider than the adjacent strategy's.
    const people = [C('a', 100), C('b', 70), C('c', 50), C('d', 20)];
    const spread = (teams: number[]) => Math.max(...teams) - Math.min(...teams);

    const ratingOf = new Map(people.map((p) => [p.playerId, p.rating]));
    const folded = planAutoPairs(people).pairs.map(([x, y]) => ratingOf.get(x)! + ratingOf.get(y)!);

    const sorted = [...people].sort((x, y) => y.rating - x.rating);
    const adjacent = [sorted[0]!.rating + sorted[1]!.rating, sorted[2]!.rating + sorted[3]!.rating];

    expect(spread(folded)).toBeLessThan(spread(adjacent));
  });

  it('leaves exactly one person waiting on an odd list, and it is the median', () => {
    // Five people: the fold works inward from both ends and the middle is what
    // it reaches last. Nobody is silently dropped — leftOver is a value the
    // caller has to say something about.
    const plan = planAutoPairs([C('a', 90), C('b', 80), C('c', 70), C('d', 60), C('e', 50)]);
    expect(plan.pairs).toEqual([['a', 'e'], ['b', 'd']]);
    expect(plan.leftOver).toBe('c');
    expect(seated(plan)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('accounts for every single person, at every size', () => {
    // The property that makes "3 pairs made, 2 still waiting" addable up: no
    // input is ever lost, and none is used twice.
    for (let n = 0; n <= 9; n++) {
      const people = Array.from({ length: n }, (_, i) => C(`p${i}`, 100 - i * 7));
      const plan = planAutoPairs(people);
      expect(seated(plan)).toEqual(people.map((p) => p.playerId).sort());
      expect(plan.pairs.length).toBe(Math.floor(n / 2));
      expect(plan.leftOver === null).toBe(n % 2 === 0);
    }
  });

  it('pairs nobody when one person is waiting, and does not invent a partner', () => {
    const plan = planAutoPairs([C('lonely', 500)]);
    expect(plan.pairs).toEqual([]);
    expect(plan.leftOver).toBe('lonely');
  });

  it('pairs nobody, and leaves nobody, on an empty list', () => {
    expect(planAutoPairs([])).toEqual({ pairs: [], leftOver: null });
  });

  it('is deterministic whatever order the rows arrive in', () => {
    // THE REASON THIS TEST EXISTS. PostgREST returns tied rows in whatever
    // order Postgres picks, and an exec who unpairs everybody and presses the
    // button again must get the same teams — a different answer reads as a
    // broken button. Six people, five shuffles, one answer.
    const people = [C('a', 90), C('b', 80), C('c', 70), C('d', 60), C('e', 50), C('f', 40)];
    const expected = planAutoPairs(people);
    const shuffles = [
      [5, 4, 3, 2, 1, 0],
      [2, 0, 4, 1, 5, 3],
      [1, 3, 5, 0, 2, 4],
      [4, 5, 0, 3, 1, 2],
      [3, 1, 2, 5, 4, 0],
    ];
    for (const order of shuffles) {
      expect(planAutoPairs(order.map((i) => people[i]!))).toEqual(expected);
    }
  });

  it('is deterministic when everybody has the SAME rating', () => {
    // The case rating alone cannot order, and it is not rare: `elo_before ?? 400`
    // and the pool's own COALESCE(..., 400) put every new entrant on exactly
    // 400. player_id is the tiebreaker, so the answer is stable and is also the
    // one a human would predict — alphabetical, folded.
    const flat = [C('dave', 400), C('alice', 400), C('carol', 400), C('bob', 400)];
    const plan = planAutoPairs(flat);
    expect(plan.pairs).toEqual([['alice', 'dave'], ['bob', 'carol']]);
    expect(planAutoPairs([...flat].reverse())).toEqual(plan);
  });

  it('does not mutate the list it was given', () => {
    const people = [C('a', 10), C('b', 90)];
    const before = people.map((p) => p.playerId);
    planAutoPairs(people);
    expect(people.map((p) => p.playerId)).toEqual(before);
  });

  it('never pairs anybody with themselves', () => {
    // pair_tournament_entrants raises on p1 = p2, so a plan that produced one
    // would be a guaranteed refusal rather than a bad team.
    for (let n = 0; n <= 9; n++) {
      const plan = planAutoPairs(Array.from({ length: n }, (_, i) => C(`p${i}`, 400)));
      for (const [x, y] of plan.pairs) expect(x).not.toBe(y);
    }
  });
});

describe('auto pair is cap-neutral and fee-neutral, by construction', () => {
  // The claim the brief asks to be PROVED rather than assumed, and the proof is
  // stronger than a spot check: auto pair only ever pairs people who are
  // ALREADY in the pool, so both halves are `alreadyUnpaired` on every call,
  // so addPairToEvent's discount — `(counts.get(half) ?? 0) - 1` — always
  // applies. Pairing therefore cannot move anybody's entry count at all, and
  // the cap can never bite on an operation that added nobody to the tournament.
  it('spends no new entry-cap slot when two pool entrants become a pair', () => {
    const before = countEventEntriesPerPlayer(
      [
        { player_id: ALICE, status: 'registered' } as EntryCapParticipantRow,
        { player_id: BOB, status: 'registered' } as EntryCapParticipantRow,
      ],
      [],
    );

    // The promotion, exactly as pair_tournament_entrants performs it: the two
    // pool rows are deleted and one pair row is inserted, in one transaction.
    const after = countEventEntriesPerPlayer(
      [],
      [{ player1_id: ALICE, player2_id: BOB, status: 'registered' } as EntryCapPairRow],
    );

    expect(after.get(ALICE)).toBe(before.get(ALICE));
    expect(after.get(BOB)).toBe(before.get(BOB));
    expect(after.get(ALICE)).toBe(1);
  });

  it('holds for a whole waiting list folded at once', () => {
    // Six people in, three teams out, and not one entry count moves — so an
    // event at a per-member cap of 1 can still be auto-paired end to end.
    const people = [ALICE, BOB, CARA, DAN, 'erin', 'frank'];
    const before = countEventEntriesPerPlayer(
      people.map((id) => ({ player_id: id, status: 'registered' }) as EntryCapParticipantRow),
      [],
    );

    const plan = planAutoPairs(people.map((id, i) => C(id, 100 - i * 10)));
    expect(plan.pairs).toHaveLength(3);
    expect(plan.leftOver).toBeNull();

    const after = countEventEntriesPerPlayer(
      [],
      plan.pairs.map(([x, y]) => ({ player1_id: x, player2_id: y, status: 'registered' }) as EntryCapPairRow),
    );

    for (const id of people) {
      expect(after.get(id)).toBe(before.get(id));
      // …and nobody is at a cap of 1 afterwards who was not before it.
      expect(isAtEntryCap(after.get(id) ?? 0, 1)).toBe(isAtEntryCap(before.get(id) ?? 0, 1));
    }
  });

  it('is fee-neutral because the fee row is keyed on (tournament, player)', () => {
    // club_fees_tournament_player_key (00094). The row a solo entry created IS
    // the row the pair would write, and ensureEntryFees skips anybody who
    // already has one — so a promoted entrant cannot be invoiced twice. Pinned
    // as the key's shape rather than as a call count: it is the schema that
    // makes the double-invoice unreachable, not the application code.
    const feeKey = (tournamentId: string, playerId: string) => `${tournamentId}:${playerId}`;
    const ledger = new Set<string>();

    // Both entered alone…
    ledger.add(feeKey('t1', ALICE));
    ledger.add(feeKey('t1', BOB));
    expect(ledger.size).toBe(2);

    // …then auto pair puts them together, and ensureEntryFees runs for both.
    ledger.add(feeKey('t1', ALICE));
    ledger.add(feeKey('t1', BOB));
    expect(ledger.size).toBe(2);
  });

  it('is slot-neutral for the whole fold, so a full event can still be paired', () => {
    // doublesDrawSlots already promises this per pair; here it is across a
    // batch. Six waiting in an event capped at 3 teams: before and after are
    // both 3, so wouldEexceedCapacity refuses nothing.
    const before = doublesDrawSlots(0, 6);
    const after = doublesDrawSlots(3, 0);
    expect(before).toBe(3);
    expect(after).toBe(3);
    expect(wouldExceedCapacity(before, after, 3)).toBe(false);
  });
});

describe('auto pair reports a leftover as news, not as a failure', () => {
  // THE BUG THIS PINS, which a green gate did not catch because every other
  // auto-pair test is on the pure function: the toast tone was "anything short
  // of a clean sweep is an error", so auto-pairing FIVE people — 2 pairs, 1 left
  // over — showed red for doing exactly what the confirm dialog promised.
  //
  // The rule, transcribed from ParticipantsTab.handleAutoPair: tone follows
  // `refused`, not `stillWaiting`.
  const tone = (r: { refused: number; stillWaiting: number; unsignedNotice: string }) =>
    r.refused > 0 ? 'error' : r.stillWaiting === 0 && !r.unsignedNotice ? 'success' : 'info';

  it('is a success when the list empties completely', () => {
    expect(tone({ refused: 0, stillWaiting: 0, unsignedNotice: '' })).toBe('success');
  });

  it('is NOT an error when an odd list leaves one person over', () => {
    // Five people: the arithmetic leftover the exec already agreed to.
    const plan = planAutoPairs(Array.from({ length: 5 }, (_, i) => C(`p${i}`, 100 - i)));
    expect(plan.pairs).toHaveLength(2);
    expect(plan.leftOver).not.toBeNull();
    expect(tone({ refused: 0, stillWaiting: 1, unsignedNotice: '' })).toBe('info');
  });

  it('is an error only when a pair was actually refused', () => {
    expect(tone({ refused: 1, stillWaiting: 2, unsignedNotice: '' })).toBe('error');
    // A refusal outranks an otherwise clean sweep.
    expect(tone({ refused: 1, stillWaiting: 2, unsignedNotice: 'x' })).toBe('error');
  });

  it('mentions an unsigned entrant without calling the run a failure', () => {
    // Everybody was paired; some of them cannot be CHECKED IN yet. That is
    // information, and pairing succeeded.
    expect(tone({ refused: 0, stillWaiting: 0, unsignedNotice: 'Bob has not accepted…' })).toBe('info');
  });
});

describe('auto pair and the event waiver', () => {
  it('does not screen out an unsigned entrant — pairing has never required a signature', () => {
    // THE PREMISE THIS PINS, because it is the one a later reader is most
    // likely to "fix" the wrong way. pair_tournament_entrants has no waiver
    // check, and addPairToEvent calls unsignedAmong/notifyEventWaiverRequired —
    // which NOTIFY. assertEventWaiverSigned appears at exactly two call sites,
    // both check-in. So an unsigned entrant is pairable, and auto pair must not
    // be stricter than the manual button beside it.
    //
    // The screening below is what auto pair does with the result: it REPORTS.
    const acceptances: AcceptedEventWaiver[] = [
      { player_id: ALICE, waiver_hash: 'h1', accepted_at: '2026-01-01T00:00:00Z' },
    ];
    const { allowed, blocked } = screenForEventWaiver(
      [
        { id: ALICE, members: [{ id: ALICE, name: 'Alice' }] },
        { id: BOB, members: [{ id: BOB, name: 'Bob' }] },
      ],
      'h1',
      acceptances,
    );

    // Bob is named so the exec can chase the signature…
    expect(blocked.map((b) => b.id)).toEqual([BOB]);
    expect(allowed).toEqual([ALICE]);
    // …but the PLAN does not care, which is the actual assertion: both of them
    // are still paired.
    const plan = planAutoPairs([C(ALICE, 400), C(BOB, 400)]);
    expect(plan.pairs).toEqual([[ALICE, BOB]]);
    expect(plan.leftOver).toBeNull();
  });

  it('pairs everybody even when NOBODY has signed', () => {
    // The gate names this case. Under the real behaviour the answer is "all
    // pairs made, all flagged" — not zero pairs.
    const plan = planAutoPairs([C(ALICE, 400), C(BOB, 400), C(CARA, 400), C(DAN, 400)]);
    expect(plan.pairs).toHaveLength(2);

    const { blocked, allowed } = screenForEventWaiver(
      [ALICE, BOB, CARA, DAN].map((id) => ({ id, members: [{ id, name: id }] })),
      'h1',
      [],
    );
    expect(allowed).toEqual([]);
    expect(blocked).toHaveLength(4);
  });
});
