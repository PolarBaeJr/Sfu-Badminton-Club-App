import { describe, it, expect, vi } from 'vitest';

// TWENTY SECONDS, FOR CPU TIME AND NOT FOR LOGIC.
//
// Nothing in this file waits on anything — there is no I/O, no timer and no
// database. The cases below run the draw two thousand times over, and the tier
// separation invariant runs forty draws for every bracket size and every field
// on top of that, because a statistical property is only asserted by a lot of
// samples. In isolation that is about a second.
//
// The 5s default is not a statement about this file, it is a statement about a
// machine with a free core. Under `turbo run test` several suites compete for
// cores at once and a purely CPU-bound test stretches with the contention; three
// separate agents have now lost time to this file timing out on a busy laptop
// while passing on its own. Twenty is chosen to be far outside that spread and
// still far inside "this test is hung" — the global default deliberately stays
// at 5s so a genuinely wedged test elsewhere is still caught quickly.
//
// FEWER DRAWS WAS THE OTHER OPTION AND IT IS THE WRONG ONE. The iteration count
// IS the assertion here: a tier that leaks across a boundary once in a thousand
// shuffles is exactly the bug these cases exist to catch, and it is invisible to
// a hundred. Making the test cheap would make it stop testing.
//
// Per-FILE rather than per-suite: there are six describes below and any of them
// can be the one that pays, so a suite option would have to be repeated six
// times and remembered a seventh when the next one is added.
vi.setConfig({ testTimeout: 20_000 });

// _internal pulls the admin Supabase client and next/cache in at module load.
// Neither is used by anything under test here — these are pure functions — but
// the imports still have to resolve.
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('../supabase-server', () => ({ createAdminClient: () => ({}) }));

import {
  getStandardSeedPositions,
  seedTierBands,
  seedTierBandsReserving,
  drawWithinTiers,
  makeDrawRng,
  newDrawSeed,
} from '../tournament-actions/_internal';

// ============================================================
// The model of what the generator does with a drawn field
// ============================================================
//
// generateSingleEliminationBracketImpl draws the field, then walks the standard
// positions and puts `drawn[rank - 1]` into each slot. That is three lines, and
// reproducing them here is what lets the invariants below be asserted over
// thousands of draws without a database anywhere near them. The integration
// tests in tournament-write-integrity.test.ts prove the real generator does
// this; these prove that what it does is correct.

/** An entrant, carrying the SEEDING rank it arrived with. */
type Entrant = { rank: number };

function place(n: number, bracketSize: number, rng: () => number) {
  const seeded: Entrant[] = Array.from({ length: n }, (_, i) => ({ rank: i + 1 }));
  const drawn = drawWithinTiers(seeded, rng);
  const positions = getStandardSeedPositions(bracketSize);
  // slots[bracketPosition] = the entrant standing there, or null for an empty
  // rank (a field of N in a bracket of B has B - N of them).
  return positions.map((rank) => drawn[rank - 1] ?? null);
}

function nextPow2(n: number) {
  let s = 2;
  while (s < n) s *= 2;
  return s;
}

/** Which seeding tier a rank belongs to: 1, 2, {3,4}, {5..8}, ... */
function tierOf(rank: number): number {
  return seedTierBands(rank).findIndex(([lo, hi]) => rank >= lo && rank <= hi);
}

describe('standard seed positions', () => {
  /**
   * PINNED HERE, and deliberately not in a test that goes through the
   * generator. Exact placement is a property of getStandardSeedPositions, so
   * asserting it against a fixed array keeps it nailed down whatever the draw
   * does on top of it — and keeps the regression test for the rank-vs-seed
   * placement fix from quietly becoming a test of seeding_method instead.
   */
  it('is the textbook 8-draw', () => {
    // 1v8, 4v5 | 2v7, 3v6 — read as consecutive pairs.
    expect(getStandardSeedPositions(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });

  it('puts every rank in exactly once, at every size', () => {
    for (const size of [2, 4, 8, 16, 32, 64]) {
      const positions = getStandardSeedPositions(size);
      expect(positions).toHaveLength(size);
      expect([...positions].sort((a, b) => a - b)).toEqual(
        Array.from({ length: size }, (_, i) => i + 1),
      );
      // Every first-round pairing sums to size + 1: the top seed meets the
      // bottom one. The draw is built on this holding.
      for (let i = 0; i < size; i += 2) {
        expect(positions[i]! + positions[i + 1]!).toBe(size + 1);
      }
    }
  });
});

describe('seeding tiers', () => {
  it('bands the ranks in powers of two, seeds 1 and 2 alone', () => {
    expect(seedTierBands(16)).toEqual([[1, 1], [2, 2], [3, 4], [5, 8], [9, 16]]);
    // The last band is clipped to the field: a 6-entry field has two people in
    // the 5-8 band and they are drawn between themselves.
    expect(seedTierBands(6)).toEqual([[1, 1], [2, 2], [3, 4], [5, 6]]);
    expect(seedTierBands(1)).toEqual([[1, 1]]);
    expect(seedTierBands(0)).toEqual([]);
  });
});

describe('drawing within tiers', () => {
  const ITERATIONS = 2000;

  it('never moves an entrant out of its own tier, over many draws', () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const n = 2 + (i % 31); // 2..32
      const seeded: Entrant[] = Array.from({ length: n }, (_, k) => ({ rank: k + 1 }));
      const drawn = drawWithinTiers(seeded, makeDrawRng(i));
      drawn.forEach((entrant, idx) => {
        // idx + 1 is the rank the entrant was DRAWN to. Same tier, always.
        expect(tierOf(idx + 1)).toBe(tierOf(entrant.rank));
      });
    }
  });

  it('is a permutation — everyone drawn exactly once, nobody twice', () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const n = 2 + (i % 31);
      const seeded: Entrant[] = Array.from({ length: n }, (_, k) => ({ rank: k + 1 }));
      const drawn = drawWithinTiers(seeded, makeDrawRng(i * 7919));
      expect(drawn).toHaveLength(n);
      expect(drawn.map((e) => e.rank).sort((a, b) => a - b))
        .toEqual(Array.from({ length: n }, (_, k) => k + 1));
    }
  });

  it('leaves seeds 1 and 2 alone, always', () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const seeded: Entrant[] = Array.from({ length: 32 }, (_, k) => ({ rank: k + 1 }));
      const drawn = drawWithinTiers(seeded, makeDrawRng(i));
      expect(drawn[0]!.rank).toBe(1);
      expect(drawn[1]!.rank).toBe(2);
    }
  });

  it('does not mutate the field it was handed', () => {
    const seeded: Entrant[] = Array.from({ length: 16 }, (_, k) => ({ rank: k + 1 }));
    const before = seeded.map((e) => e.rank);
    drawWithinTiers(seeded, makeDrawRng(12345));
    expect(seeded.map((e) => e.rank)).toEqual(before);
  });
});

describe('the tier separation invariant', () => {
  /**
   * THE PROPERTY THE WHOLE FEATURE IS CONSTRAINED BY, and the reason the draw
   * is randomised within tiers rather than over the field: two entrants of the
   * same tier can never meet before the round their tier implies. Seeds 1 and 2
   * not before the final, 1-4 not before the semis, 1-8 not before the
   * quarter-finals.
   *
   * Stated positionally, which is the only way to state it without simulating
   * matches: for every m, the top 2^m seeds must sit in 2^m DIFFERENT
   * sub-brackets of size B / 2^m. Two entrants in the same sub-bracket of size
   * s must meet within log2(s) rounds; in different ones they cannot.
   */
  it('holds for every bracket size and every field, over many draws', () => {
    let draws = 0;
    for (const bracketSize of [2, 4, 8, 16, 32]) {
      for (let n = 2; n <= bracketSize; n++) {
        for (let iter = 0; iter < 40; iter++) {
          const slots = place(n, bracketSize, makeDrawRng(n * 1000 + iter + bracketSize));
          draws++;

          const slotOfRank = new Map<number, number>();
          slots.forEach((e, idx) => { if (e) slotOfRank.set(e.rank, idx); });

          for (let m = 1; Math.pow(2, m) <= bracketSize; m++) {
            const top = Math.pow(2, m);
            const subBracketSize = bracketSize / top;
            const occupied = new Set<number>();
            for (let rank = 1; rank <= Math.min(top, n); rank++) {
              const slot = slotOfRank.get(rank)!;
              const subBracket = Math.floor(slot / subBracketSize);
              // Two of the top 2^m in the same sub-bracket would meet early.
              expect(occupied.has(subBracket)).toBe(false);
              occupied.add(subBracket);
            }
          }
        }
      }
    }
    // Named so a refactor that silently stops iterating is visible.
    expect(draws).toBe(2280);
  });
});

// ============================================================
// The promised prefix (00124)
// ============================================================
//
// seed_skip_count promises SEEDS a bye, and the byes fall on RANKS. Those are
// the same set only when the promise ends on a tier boundary, so a non-zero
// promise is handed to the draw and cuts the band it lands in. These cases are
// about the cut being a real constraint AND a harmless one: the separation
// invariant above is the thing it must not cost, and the argument that it
// cannot is that shuffling within two contiguous halves of a band is a subset
// of shuffling within the band.
describe('reserving the seeds that were promised a skip', () => {
  it('cuts exactly the band the promise lands inside, and no other', () => {
    // Mid-band: [3,4] becomes [3,3] and [4,4].
    expect(seedTierBandsReserving(16, 3)).toEqual([[1, 1], [2, 2], [3, 3], [4, 4], [5, 8], [9, 16]]);
    // On a boundary: nothing to cut, so the bands are untouched.
    expect(seedTierBandsReserving(16, 4)).toEqual(seedTierBands(16));
    expect(seedTierBandsReserving(16, 8)).toEqual(seedTierBands(16));
    // Deep inside the big band, which is the 20-entrant case: [9,16] splits at
    // the promise and everything below it is left whole.
    expect(seedTierBandsReserving(20, 9))
      .toEqual([[1, 1], [2, 2], [3, 4], [5, 8], [9, 9], [10, 16], [17, 20]]);
    // Zero is the default every event that made no promise passes, and it must
    // return the bands unchanged or the draw is not byte-identical.
    expect(seedTierBandsReserving(20, 0)).toEqual(seedTierBands(20));
  });

  it('is total — a nonsense reserve cuts nothing rather than throwing', () => {
    for (const reserve of [-1, 0, 99, Number.NaN, 3.7]) {
      const bands = seedTierBandsReserving(8, reserve);
      // Whatever it did, the bands still cover 1..8 exactly once.
      const covered = bands.flatMap(([lo, hi]) =>
        Array.from({ length: hi - lo + 1 }, (_, k) => lo + k));
      expect(covered).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    }
  });

  it('puts the promised seeds on the top ranks, at every promise and every size', () => {
    for (let n = 2; n <= 32; n++) {
      for (let reserve = 1; reserve <= n; reserve++) {
        for (let iter = 0; iter < 8; iter++) {
          const seeded: Entrant[] = Array.from({ length: n }, (_, k) => ({ rank: k + 1 }));
          const drawn = drawWithinTiers(seeded, makeDrawRng(n * 977 + reserve * 31 + iter), reserve);
          // Ranks 1..reserve hold seeds 1..reserve — which is the whole promise,
          // since the byes fall on a prefix of the ranks.
          for (let r = 1; r <= reserve; r++) expect(drawn[r - 1]!.rank).toBeLessThanOrEqual(reserve);
          // And it is still a permutation of the field.
          expect(drawn.map((e) => e.rank).sort((a, b) => a - b))
            .toEqual(Array.from({ length: n }, (_, k) => k + 1));
        }
      }
    }
  });

  it('costs the separation invariant nothing, at every promise', () => {
    // The one property the cut could plausibly break. It cannot — cutting a
    // band into two contiguous halves still permutes the band's own set onto
    // itself, so the sub-bracket argument above is untouched — and this is what
    // says so rather than the comment saying so.
    for (const bracketSize of [4, 8, 16, 32]) {
      for (let n = 2; n <= bracketSize; n++) {
        for (let reserve = 0; reserve <= n; reserve++) {
          const seeded: Entrant[] = Array.from({ length: n }, (_, k) => ({ rank: k + 1 }));
          const drawn = drawWithinTiers(
            seeded, makeDrawRng(bracketSize * 7919 + n * 97 + reserve), reserve,
          );
          const slots = getStandardSeedPositions(bracketSize).map((rank) => drawn[rank - 1] ?? null);
          const slotOfRank = new Map<number, number>();
          slots.forEach((e, idx) => { if (e) slotOfRank.set(e.rank, idx); });

          for (let m = 1; Math.pow(2, m) <= bracketSize; m++) {
            const top = Math.pow(2, m);
            const subBracketSize = bracketSize / top;
            const occupied = new Set<number>();
            for (let rank = 1; rank <= Math.min(top, n); rank++) {
              const subBracket = Math.floor(slotOfRank.get(rank)! / subBracketSize);
              expect(occupied.has(subBracket)).toBe(false);
              occupied.add(subBracket);
            }
          }
        }
      }
    }
  });

  it('does not freeze the ranks below the promise', () => {
    // A "fix" that simply stopped shuffling would satisfy every assertion
    // above. 20 entrants promising 9 leaves ranks 10-16 to be drawn between
    // themselves, and they must still move.
    const seen = new Set<string>();
    for (let seed = 0; seed < 60; seed++) {
      const seeded: Entrant[] = Array.from({ length: 20 }, (_, k) => ({ rank: k + 1 }));
      seen.add(drawWithinTiers(seeded, makeDrawRng(seed), 9).map((e) => e.rank).join(','));
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('byes', () => {
  /**
   * BYES STAY WITH THE TOP OF THE FIELD, which is what the shuffle being over
   * the ENTRANT ARRAY rather than over rank slots buys. A field of N in a
   * bracket of B leaves ranks N+1..B empty, and because the shuffle only ever
   * permutes entrants inside a band it can never move an empty rank up into a
   * band that still has people in it. Permuting slots instead would let a
   * 5-entry draw hand seed 4 a bye while seed 1 played.
   *
   * WITHIN A TIER, WHO GETS THE BYE IS DRAWN, and that is correct rather than
   * sloppy: a tier is by definition a set of entrants the draw treats as
   * interchangeable. A 5-entry draw gives byes to seeds 1 and 2 and to ONE of
   * seeds 3 and 4 — which one is the draw's business. What must never happen is
   * a bye going to a lower tier than someone who has to play.
   */
  it('gives a bye to nobody from a lower tier than someone who plays', () => {
    for (const n of [3, 5, 6, 7, 9, 11, 12, 13, 17, 23, 30]) {
      const bracketSize = nextPow2(n);
      for (let iter = 0; iter < 200; iter++) {
        const slots = place(n, bracketSize, makeDrawRng(n * 97 + iter));
        const withBye: number[] = [];
        const playing: number[] = [];
        for (let i = 0; i < bracketSize; i += 2) {
          const a = slots[i];
          const b = slots[i + 1];
          if (a && !b) withBye.push(a.rank);
          else if (b && !a) withBye.push(b.rank);
          else if (a && b) { playing.push(a.rank, b.rank); }
        }
        // The count is fixed by the field, never by the draw.
        expect(withBye).toHaveLength(bracketSize - n);
        expect(withBye.length + playing.length).toBe(n);
        const worstBye = Math.max(...withBye.map(tierOf));
        const bestPlaying = Math.min(...playing.map(tierOf));
        expect(worstBye).toBeLessThanOrEqual(bestPlaying);
        // Seed 1 always has a bye when there is one to give.
        expect(withBye).toContain(1);
      }
    }
  });

  it('hands out exactly the byes each tier is owed, never more', () => {
    // Stronger than the ordering above: the number of byes falling in each tier
    // is a function of the field alone, so a draw that moved one across a tier
    // boundary would show up here even if the ordering still happened to hold.
    for (const n of [5, 6, 9, 11, 20, 23]) {
      const bracketSize = nextPow2(n);
      const byeCount = bracketSize - n;
      const expected = new Map<number, number>();
      for (let rank = 1; rank <= byeCount; rank++) {
        expected.set(tierOf(rank), (expected.get(tierOf(rank)) ?? 0) + 1);
      }
      for (let iter = 0; iter < 200; iter++) {
        const slots = place(n, bracketSize, makeDrawRng(n * 31 + iter));
        const actual = new Map<number, number>();
        for (let i = 0; i < bracketSize; i += 2) {
          const a = slots[i];
          const b = slots[i + 1];
          const solo = a && !b ? a : (b && !a ? b : null);
          if (solo) actual.set(tierOf(solo.rank), (actual.get(tierOf(solo.rank)) ?? 0) + 1);
        }
        expect([...actual.entries()].sort()).toEqual([...expected.entries()].sort());
      }
    }
  });
});

describe('the draw actually varies', () => {
  /**
   * THE CLUB OWNER'S BUG REPORT AS A TEST: "regenerate draw doesnt change
   * anything". It was true, and it followed from placement being a pure
   * function of the seeds. If this ever goes back to one arrangement, the
   * button is a no-op again.
   */
  it('produces many different brackets from one unchanged field', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const slots = place(8, 8, makeDrawRng(newDrawSeed()));
      seen.add(slots.map((e) => e!.rank).join(','));
    }
    // An 8-draw has 2 (seeds 3-4) x 24 (seeds 5-8) = 48 possible draws. Over
    // 200 tries a handful is proof of life; the exact number is the draw's
    // business.
    expect(seen.size).toBeGreaterThan(5);
  });

  it('varies even a 4-entry draw, where only seeds 3 and 4 can move', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(place(4, 4, makeDrawRng(newDrawSeed())).map((e) => e!.rank).join(','));
    }
    expect(seen.size).toBe(2);
  });

  it('cannot vary a 2-entry draw, and does not pretend to', () => {
    for (let i = 0; i < 50; i++) {
      expect(place(2, 2, makeDrawRng(newDrawSeed())).map((e) => e!.rank)).toEqual([1, 2]);
    }
  });
});

describe('a draw can be reproduced from its seed', () => {
  /**
   * WHY THE SEED IS RECORDED. An exec who is asked why a player landed in that
   * half has to be able to answer, and "it was random" is not an answer. The
   * bracket_generated audit row carries draw_seed, and re-running the draw with
   * it gives the identical bracket back off the identical field.
   */
  it('gives the same bracket back for the same seed, and a different one otherwise', () => {
    const layout = (seed: number) =>
      place(16, 16, makeDrawRng(seed)).map((e) => e!.rank).join(',');

    for (const seed of [0, 1, 42, 999_999, 4294967295]) {
      expect(layout(seed)).toBe(layout(seed));
    }
    // Distinct seeds give distinct draws — not guaranteed for any single pair,
    // but a 16-draw has 2 x 24 x 8! = 1,935,360 arrangements, so a hundred
    // seeds colliding into fewer than ninety would mean the seed is barely
    // reaching the shuffle.
    const layouts = new Set(Array.from({ length: 100 }, (_, i) => layout(i)));
    expect(layouts.size).toBeGreaterThan(90);
  });

  it('draws a fresh seed each time it is asked', () => {
    const seeds = new Set(Array.from({ length: 500 }, () => newDrawSeed()));
    expect(seeds.size).toBeGreaterThan(490);
    for (const s of seeds) {
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(4294967296);
    }
  });

  it('produces a usable spread from the PRNG itself', () => {
    // A shuffle is only as fair as its source. Ten buckets over 10,000 draws
    // should each hold roughly a thousand; a generator stuck in a corner of its
    // state space would show up as an empty or overflowing bucket.
    const rng = makeDrawRng(20260812);
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 10000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      buckets[Math.floor(v * 10)]++;
    }
    for (const b of buckets) {
      expect(b).toBeGreaterThan(800);
      expect(b).toBeLessThan(1200);
    }
  });
});
