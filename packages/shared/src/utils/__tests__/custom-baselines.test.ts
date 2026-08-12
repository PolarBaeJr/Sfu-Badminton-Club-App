import { describe, it, expect } from 'vitest';
import {
  baselineCapabilityRefusal,
  baselineNameRefusal,
  effectiveCapabilities,
  normaliseBaselineCapabilities,
  resolvePermissions,
  BASELINE_NAME_MAX,
  CAPABILITIES,
  EDITOR_OFFERABLE,
  EXEC_BASELINE,
  TRAINER_BASELINE,
  UNRESTRICTED,
  type Capability,
} from '../access-level';

// THE RULES A STORED BASELINE HAS TO SATISFY.
//
// A custom baseline is COPIED onto a row rather than resolved through, so every
// property this file pins is a property of the array as it is written down.
// That is the whole reason these checks can exist at all: on a player row the
// same questions are about the RESOLVED set, after revokes, and no check on the
// stored columns can see them.

const held = (...capabilities: Capability[]) => new Set<Capability>(capabilities);
const ALL = new Set<Capability>(CAPABILITIES);
const EXEC = new Set<Capability>(EXEC_BASELINE);

describe('naming a baseline', () => {
  it('refuses an empty name, and a name of nothing but space', () => {
    expect(baselineNameRefusal('')).toMatch(/needs a name/);
    expect(baselineNameRefusal('   ')).toMatch(/needs a name/);
  });

  it('refuses a name longer than the column allows', () => {
    expect(baselineNameRefusal('x'.repeat(BASELINE_NAME_MAX))).toBeNull();
    expect(baselineNameRefusal('x'.repeat(BASELINE_NAME_MAX + 1))).toMatch(/at most/);
  });

  // Measured on the TRIMMED name, because that is what the unique index is
  // built on and what the row will hold.
  it('measures the trimmed name', () => {
    expect(baselineNameRefusal(`  ${'x'.repeat(BASELINE_NAME_MAX)}  `)).toBeNull();
  });

  it('accepts an ordinary club job', () => {
    expect(baselineNameRefusal('Socials VP')).toBeNull();
  });
});

describe('what may go in a baseline', () => {
  it('accepts a set an admin holds', () => {
    expect(baselineCapabilityRefusal(['fees.page', 'fees.expenses.add.write'], ALL)).toBeNull();
  });

  it('refuses a string the vocabulary does not have', () => {
    expect(baselineCapabilityRefusal(['fees.page', 'fees.everything'], ALL))
      .toMatch(/fees\.everything/);
  });

  it('refuses an empty baseline — a name that does nothing', () => {
    expect(baselineCapabilityRefusal([], ALL)).toMatch(/at least one capability/);
  });

  // ------------------------------------------------------------------
  // GRANT CLOSURE, at authoring time
  // ------------------------------------------------------------------
  it('refuses a capability the author does not hold', () => {
    const author = held('players.page', 'players.read');
    const refusal = baselineCapabilityRefusal(
      ['players.page', 'players.read', 'players.ban.write'],
      author,
    );
    expect(refusal).toMatch(/players\.ban\.write/);
    expect(refusal).toMatch(/do not hold it/);
  });

  it('lets an author write down exactly what they hold', () => {
    const author = held('players.page', 'players.read', 'players.ban.write');
    expect(baselineCapabilityRefusal([...author], author)).toBeNull();
  });

  // The property in general rather than on one example: for every capability an
  // exec baseline holder lacks, a baseline containing it is refused.
  it('refuses every capability outside the author, one at a time', () => {
    for (const capability of CAPABILITIES) {
      if (EXEC.has(capability)) continue;
      const refusal = baselineCapabilityRefusal(
        ['players.page', capability],
        EXEC,
      );
      expect(refusal, `${capability} was allowed into an exec's baseline`).not.toBeNull();
    }
  });

  // ------------------------------------------------------------------
  // THE CEILING, which closure cannot supply
  // ------------------------------------------------------------------
  // An admin holds everything by level, so closure never bites for them. Without
  // the EDITOR_OFFERABLE cap an admin could author a baseline containing
  // permissions.write, which setPlayerPermissions would then refuse to assign —
  // an authorable, unassignable baseline with no explanation on either screen.
  it('caps an admin at the exec baseline', () => {
    expect(baselineCapabilityRefusal(['permissions.page', 'permissions.write'], ALL))
      .toMatch(/admin-only/);
    expect(baselineCapabilityRefusal(['audit.page'], ALL)).toMatch(/admin-only/);
  });

  it('accepts anything inside the exec baseline for an admin', () => {
    expect(baselineCapabilityRefusal([...EDITOR_OFFERABLE], ALL)).toBeNull();
  });

  // ------------------------------------------------------------------
  // THE PAGE INVARIANT
  // ------------------------------------------------------------------
  // The quiet failure this exists to prevent: a baseline that saves, assigns and
  // audits, and hands out nothing.
  it('refuses a capability whose area page is missing', () => {
    expect(baselineCapabilityRefusal(['fees.expenses.add.write'], ALL))
      .toMatch(/fees\.page/);
  });

  it('names every missing page once', () => {
    const refusal = baselineCapabilityRefusal(
      ['fees.expenses.add.write', 'fees.expenses.read', 'sessions.create.write'],
      ALL,
    );
    expect(refusal).toMatch(/fees\.page/);
    expect(refusal).toMatch(/sessions\.page/);
    expect(refusal!.match(/fees\.page/g)!.length).toBe(1);
  });

  // The invariant stated as the thing it is FOR: anything this function accepts
  // survives the resolver intact. A baseline is copied into permission_grants
  // against the empty 'custom' base, so the resolved set must equal the array.
  it('everything it accepts resolves to exactly itself', () => {
    const cases: Capability[][] = [
      ['fees.page', 'fees.expenses.read', 'fees.expenses.add.write'],
      ['players.page', 'players.read', 'players.approve.write'],
      ['sessions.page', 'sessions.attendance.write', 'legal.page', 'legal.reacceptance.write'],
      [...EDITOR_OFFERABLE],
    ];
    for (const capabilities of cases) {
      expect(baselineCapabilityRefusal(capabilities, ALL)).toBeNull();
      const resolved = resolvePermissions('custom', capabilities, []);
      expect(resolved.kind).toBe('restricted');
      const set = resolved.kind === 'restricted' ? resolved.capabilities : new Set();
      expect([...set].sort()).toEqual([...new Set(capabilities)].sort());
    }
  });

  // ------------------------------------------------------------------
  // THE HARD FLOOR
  // ------------------------------------------------------------------
  // role, is_exec, is_trainer and the three permission_* columns are refused
  // below admin under all circumstances and are reachable by NO capability —
  // see player-field-access.ts. A baseline is a set of capabilities, so it
  // cannot name a column at all; this is that fact as an assertion, in the file
  // where somebody adding a capability for "granting exec" would look.
  it('no capability in the vocabulary names a hard-floor column', () => {
    const floor = [
      'role',
      'is_exec',
      'is_trainer',
      'permission_role',
      'permission_grants',
      'permission_revokes',
      'permission_baseline_id',
    ];
    for (const capability of CAPABILITIES) {
      for (const column of floor) {
        expect(
          capability.includes(column),
          `${capability} reads as a grant of ${column}`,
        ).toBe(false);
      }
    }
  });

  // And the floor stated the other way: a baseline holding EVERY capability the
  // ceiling allows still resolves to a set that changes nobody's level. The two
  // markers that decide a level are not in the vocabulary, so the widest
  // possible baseline leaves accessLevelFor() with nothing to read.
  //
  // THE CEILING STOPPED BEING THE EXEC BASELINE when the four VP jobs became
  // editable (00104): the club owner wanted a treasurer who can see the club's
  // books, which no exec can. So the widest baseline is now the exec baseline
  // PLUS four finance reads — asserted as a derivation from EDITOR_OFFERABLE
  // rather than a fresh list, so this test says "the ceiling is the ceiling"
  // instead of pinning the same numbers twice.
  it('the widest baseline the ceiling allows is the ceiling, and no more', () => {
    const widest = normaliseBaselineCapabilities([...EDITOR_OFFERABLE]);
    expect(baselineCapabilityRefusal(widest, ALL)).toBeNull();

    // A trainer composed with it holds exactly the ceiling — a widening,
    // deliberately, and bounded by it. Never more.
    const composed = effectiveCapabilities('trainer', resolvePermissions('custom', widest, []));
    expect([...composed].sort()).toEqual([...EDITOR_OFFERABLE].sort());

    // AND STILL BOUNDED BY SOMETHING NAMED. The point of the old assertion was
    // that the widest composition is a set somebody enumerated, not "everything"
    // — so it is restated as the gap, which is the four reads and nothing else.
    const beyond = [...composed].filter(
      (capability) => !(EXEC_BASELINE as readonly Capability[]).includes(capability),
    );
    expect(beyond.sort()).toEqual([
      'fees.clubfees.read',
      'fees.netposition.read',
      'fees.otherincome.read',
      'fees.reinstatements.read',
    ]);

    // ...and an uncomposed trainer is untouched by any of this.
    expect([...effectiveCapabilities('trainer', UNRESTRICTED)].sort())
      .toEqual([...TRAINER_BASELINE].sort());
  });
});

describe('storing a baseline', () => {
  it('de-duplicates and sorts', () => {
    expect(normaliseBaselineCapabilities([
      'fees.page',
      'fees.expenses.read',
      'fees.page',
    ])).toEqual(['fees.expenses.read', 'fees.page']);
  });
});
