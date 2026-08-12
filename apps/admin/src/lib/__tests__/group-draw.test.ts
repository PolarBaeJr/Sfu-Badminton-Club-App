import { describe, it, expect, vi } from 'vitest';

// Same shims draw-randomisation.test.ts uses: _internal pulls the admin
// Supabase client and next/cache in at module load, and nothing under test here
// touches either — these are pure functions.
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('../supabase-server', () => ({ createAdminClient: () => ({}) }));

import {
  getStandardSeedPositions,
  seedTierBands,
  drawWithinQualificationTiers,
  sameGroupRound1Conflicts,
  drawAvoidingSameGroupRound1,
  planGroupAssignment,
  seedingOrderForGroups,
  makeDrawRng,
  type GroupCandidate,
} from '../tournament-actions/_internal';

/** A qualifier: which group it came out of, and where it finished there. */
type Q = { id: string; group: number; groupRank: number };

/**
 * The qualification order a group stage of G groups x P qualifiers produces:
 * all the winners, then all the runners-up, and so on.
 */
function qualifiers(groups: number, perGroup: number): Q[] {
  const out: Q[] = [];
  for (let rank = 1; rank <= perGroup; rank++) {
    for (let g = 1; g <= groups; g++) {
      out.push({ id: `${String.fromCharCode(64 + g)}${rank}`, group: g, groupRank: rank });
    }
  }
  return out;
}

function nextPow2(n: number) {
  let s = 2;
  while (s < n) s *= 2;
  return s;
}

describe('why a group-seeded draw cannot use the seeding tiers', () => {
  /**
   * THE BUG THIS FEATURE WOULD HAVE SHIPPED WITH, pinned as a test rather than
   * described in a comment.
   *
   * drawWithinTiers shuffles inside the powers-of-two bands. With 4 groups the
   * bands happen to line up with the winner/runner-up boundary and everything
   * looks fine. With 3 groups they do not: winners hold ranks 1-3, runners-up
   * 4-6, and the band [3,4] straddles the boundary — so shuffling it can seed a
   * runner-up above a group winner.
   */
  it('the power-of-two bands straddle the winner boundary at 3 groups', () => {
    const bands = seedTierBands(6);
    expect(bands).toContainEqual([3, 4]);
    // Ranks 1-3 are the winners; the band spans 3 and 4, i.e. both sides of it.
    const straddles = bands.some(([lo, hi]) => lo <= 3 && hi > 3);
    expect(straddles).toBe(true);
  });

  it('and does not at 4 groups, which is why the aligned case hides it', () => {
    const bands = seedTierBands(8);
    expect(bands.some(([lo, hi]) => lo <= 4 && hi > 4)).toBe(false);
  });
});

describe('drawWithinQualificationTiers', () => {
  it('never moves an entrant out of its tier, over many draws', () => {
    for (const [groups, perGroup] of [[3, 2], [4, 2], [5, 3], [6, 2], [2, 3]] as const) {
      const field = qualifiers(groups, perGroup);
      for (let seed = 0; seed < 200; seed++) {
        const drawn = drawWithinQualificationTiers(field, (e) => e.groupRank, makeDrawRng(seed));
        expect(drawn.length).toBe(field.length);
        drawn.forEach((e, i) => {
          // Index i holds draw rank i+1; the tier that rank belongs to is fixed
          // by the tier sizes, so an entrant here must have that groupRank.
          expect(e.groupRank).toBe(field[i]!.groupRank);
        });
      }
    }
  });

  it('actually shuffles — a redraw is not a no-op', () => {
    const field = qualifiers(4, 2);
    const seen = new Set<string>();
    for (let seed = 0; seed < 50; seed++) {
      seen.add(drawWithinQualificationTiers(field, (e) => e.groupRank, makeDrawRng(seed)).map(e => e.id).join(''));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('leaves a one-member tier alone', () => {
    // Group A has three finishers and group B has two, so tier 3 has one
    // occupant and nothing to swap it with.
    const field: Q[] = [
      { id: 'A1', group: 1, groupRank: 1 }, { id: 'B1', group: 2, groupRank: 1 },
      { id: 'A2', group: 1, groupRank: 2 }, { id: 'B2', group: 2, groupRank: 2 },
      { id: 'A3', group: 1, groupRank: 3 },
    ];
    for (let seed = 0; seed < 20; seed++) {
      const drawn = drawWithinQualificationTiers(field, (e) => e.groupRank, makeDrawRng(seed));
      expect(drawn[4]!.id).toBe('A3');
    }
  });
});

describe('sameGroupRound1Conflicts', () => {
  it('reads the BRACKET, not the array — ranks 1 and 2 are never paired', () => {
    // Adjacent in the array, opposite ends of an 8-draw. A conflict counter
    // that looked at neighbouring indices would report one here.
    const field: Q[] = [
      { id: 'A1', group: 1, groupRank: 1 },
      { id: 'A2', group: 1, groupRank: 1 },
      { id: 'B1', group: 2, groupRank: 2 },
      { id: 'B2', group: 2, groupRank: 2 },
    ];
    // getStandardSeedPositions(4) is [1,4,2,3]: matches are (1,4) and (2,3).
    expect(getStandardSeedPositions(4)).toEqual([1, 4, 2, 3]);
    // rank1=A1 vs rank4=B2, rank2=A2 vs rank3=B1 — no group meets itself.
    expect(sameGroupRound1Conflicts(field, 4, (e) => e.group)).toBe(0);
  });

  it('counts a real clash', () => {
    const field: Q[] = [
      { id: 'A1', group: 1, groupRank: 1 },
      { id: 'B1', group: 2, groupRank: 1 },
      { id: 'B2', group: 2, groupRank: 2 },
      { id: 'A2', group: 1, groupRank: 2 },
    ];
    // (rank1,rank4) = A1 vs A2, (rank2,rank3) = B1 vs B2. Both clash.
    expect(sameGroupRound1Conflicts(field, 4, (e) => e.group)).toBe(2);
  });

  it('does not count a bye as a clash', () => {
    // 3 entrants in a 4-draw: rank 4 is empty, so one match has one entrant.
    const field: Q[] = [
      { id: 'A1', group: 1, groupRank: 1 },
      { id: 'A2', group: 1, groupRank: 2 },
      { id: 'B1', group: 2, groupRank: 1 },
    ];
    // (1,4) = A1 vs nobody, (2,3) = A2 vs B1.
    expect(sameGroupRound1Conflicts(field, 4, (e) => e.group)).toBe(0);
  });
});

describe('drawAvoidingSameGroupRound1', () => {
  const run = (groups: number, perGroup: number, seed: number) => {
    const field = qualifiers(groups, perGroup);
    return drawAvoidingSameGroupRound1(field, {
      bracketSize: nextPow2(field.length),
      tierOf: (e) => e.groupRank,
      groupOf: (e) => e.group,
      seed,
    });
  };

  it('separates group-mates in round one across every ordinary shape', () => {
    for (const [groups, perGroup] of [[2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [8, 2], [4, 3], [3, 4]] as const) {
      for (let seed = 0; seed < 40; seed++) {
        const out = run(groups, perGroup, seed);
        expect(out.feasible).toBe(true);
        expect(out.conflicts).toBe(0);
      }
    }
  });

  it('keeps the tiers intact while it does it', () => {
    const field = qualifiers(5, 3);
    for (let seed = 0; seed < 50; seed++) {
      const out = drawAvoidingSameGroupRound1(field, {
        bracketSize: nextPow2(field.length),
        tierOf: (e) => e.groupRank,
        groupOf: (e) => e.group,
        seed,
      });
      out.entries.forEach((e, i) => expect(e.groupRank).toBe(field[i]!.groupRank));
    }
  });

  it('reproduces the same bracket from the same seed', () => {
    // The property the recorded draw_seed exists for: the audit row has to be
    // able to explain the bracket months later.
    const a = run(4, 2, 12345);
    const b = run(4, 2, 12345);
    expect(b.entries.map(e => e.id)).toEqual(a.entries.map(e => e.id));
  });

  it('THE BRIEF SAID THIS WAS UNSATISFIABLE, AND IT IS NOT', () => {
    // Two groups of two, four qualifiers, a bracket of four — the brief's
    // example of a shape to detect and degrade on. It is satisfiable.
    //
    // The 4-draw pairs (rank1,rank4) and (rank2,rank3); winners hold ranks 1-2
    // and runners-up 3-4. A1,B1,A2,B2 gives (A1 v B2) and (B1 v A2) — clean.
    // A1,B1,B2,A2 gives (A1 v A2) — a clash. So HALF the draws clash and half
    // do not, which is exactly the case the retry exists for: a solution
    // exists, so it is found, and the pigeonhole check correctly does not
    // declare this infeasible.
    for (let seed = 0; seed < 100; seed++) {
      const out = run(2, 2, seed);
      expect(out.feasible).toBe(true);
      expect(out.conflicts).toBe(0);
      // A handful of attempts, never the cap.
      expect(out.attempts).toBeLessThan(10);
    }
  });

  it('detects a genuinely impossible field instead of looping', () => {
    // Withdrawals have left a bracket whose whole field came out of one group.
    // Four entrants, two round-one matches, four from group A: pigeonhole.
    const field: Q[] = [1, 2, 3, 4].map((r) => ({ id: `A${r}`, group: 1, groupRank: r }));
    const out = drawAvoidingSameGroupRound1(field, {
      bracketSize: 4,
      tierOf: (e) => e.groupRank,
      groupOf: (e) => e.group,
      seed: 7,
    });
    expect(out.feasible).toBe(false);
    // One draw, not sixty-four attempts at an arrangement that cannot exist —
    // and it still returns a playable bracket rather than refusing.
    expect(out.attempts).toBe(1);
    expect(out.conflicts).toBeGreaterThan(0);
    expect(out.entries.length).toBe(4);
    expect(new Set(out.entries.map(e => e.id)).size).toBe(4);
  });

  it('never loses or duplicates an entrant, whatever it decides', () => {
    for (const [groups, perGroup] of [[2, 2], [3, 3], [5, 2], [7, 2]] as const) {
      const field = qualifiers(groups, perGroup);
      for (let seed = 0; seed < 30; seed++) {
        const out = drawAvoidingSameGroupRound1(field, {
          bracketSize: nextPow2(field.length),
          tierOf: (e) => e.groupRank,
          groupOf: (e) => e.group,
          seed,
        });
        expect(new Set(out.entries.map(e => e.id))).toEqual(new Set(field.map(e => e.id)));
      }
    }
  });
});

describe('planGroupAssignment', () => {
  const field = (n: number, over: (i: number) => Partial<GroupCandidate> = () => ({})): GroupCandidate[] =>
    Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, seed: i + 1, elo: 2000 - i, group: null, ...over(i) }));

  it('deals a fresh field serpentine by seed', () => {
    const plan = planGroupAssignment(field(8), 4);
    expect([...plan.values()]).toEqual([1, 2, 3, 4, 4, 3, 2, 1]);
  });

  it('falls back to rating when nobody has been seeded', () => {
    // THE SILENT DEGENERATION THE BRIEF WARNED ABOUT. The round-robin generator
    // never auto-seeds, so an unseeded field would otherwise be dealt in
    // whatever order the database returned it — which is not balanced at all.
    const unseeded: GroupCandidate[] = [
      { id: 'weak', seed: null, elo: 1000, group: null },
      { id: 'strong', seed: null, elo: 2000, group: null },
      { id: 'mid', seed: null, elo: 1500, group: null },
      { id: 'weakest', seed: null, elo: 900, group: null },
    ];
    const plan = planGroupAssignment(unseeded, 2);
    // strong and mid are the top two, so they must be in different groups.
    expect(plan.get('strong')).not.toBe(plan.get('mid'));
    expect(plan.get('strong')).toBe(plan.get('weakest'));
  });

  it('puts a partially seeded field seeds-first, then by rating', () => {
    const mixed: GroupCandidate[] = [
      { id: 'a', seed: 2, elo: 1000, group: null },
      { id: 'b', seed: null, elo: 1900, group: null },
      { id: 'c', seed: 1, elo: 1100, group: null },
      { id: 'd', seed: null, elo: 1800, group: null },
    ];
    expect(seedingOrderForGroups(mixed).map(e => e.id)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('keeps a hand-placed entry and fills only the gaps', () => {
    // THE OVERRIDE HAS TO SURVIVE PRESSING GENERATE. An exec moved p1 into
    // group 3; a late entrant arrives with no group at all.
    const entries = field(5, (i) => (i === 0 ? { group: 3 } : i < 4 ? { group: 1 } : {}));
    const plan = planGroupAssignment(entries, 3);
    expect(plan.get('p1')).toBe(3);
    expect(plan.get('p2')).toBe(1);
    // p5 is the only unplaced one and group 2 is empty, so it goes there.
    expect(plan.get('p5')).toBe(2);
  });

  it('re-deals everything when asked to', () => {
    const entries = field(8, () => ({ group: 1 }));
    const plan = planGroupAssignment(entries, 4, { reassignAll: true });
    expect([...plan.values()]).toEqual([1, 2, 3, 4, 4, 3, 2, 1]);
  });

  it('treats a group above the count as unassigned', () => {
    // group_count was lowered after the fact; group 4 no longer exists.
    const entries = field(4, (i) => ({ group: i === 0 ? 4 : 1 }));
    const plan = planGroupAssignment(entries, 2);
    expect(plan.get('p1')).toBeLessThanOrEqual(2);
    expect(plan.get('p1')).toBeGreaterThanOrEqual(1);
  });

  it('names every entry, so the write-back is idempotent', () => {
    const entries = field(6, () => ({ group: 1 }));
    const plan = planGroupAssignment(entries, 2);
    expect(plan.size).toBe(6);
  });

  it('is one group when the event is not a group stage', () => {
    expect([...planGroupAssignment(field(3), 1).values()]).toEqual([1, 1, 1]);
  });
});
