import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  baselineCapabilityRefusal,
  isBuiltinPermissionRole,
  resolvePermissions,
  shippedDefaultFor,
  BUILTIN_BASELINE_IDS,
  BUILTIN_PERMISSION_ROLES,
  CAPABILITIES,
  EDITOR_OFFERABLE,
  EXEC_ASSIGNABLE,
  EXEC_BASELINE,
  PERMISSION_ROLES,
  PERMISSION_ROLE_LABELS,
  ROLE_DEFAULTS,
  type Capability,
} from '../access-level';

// EDITABLE BUILT-IN ROLES.
//
// The club owner asked to "edit the permissions of each preassigned role
// beforehand", and the case that prompted it was Finance seeing money IN as well
// as out. 00104 makes the four VP jobs SEEDED ROWS in permission_baselines, so
// the answer lives in the database and ROLE_DEFAULTS becomes the seed.
//
// WHAT THIS FILE PINS, and it is three separate things:
//
//   1. THE RESOLVER DID NOT MOVE. A built-in role is COPIED onto a person, the
//      same shape 00093 chose, so resolvePermissions() is untouched. Asserted
//      rather than asserted-about: the seeded sets are resolved and compared.
//
//   2. THE SEED AND THE CONSTANT AGREE. The migration is read as TEXT and
//      checked against ROLE_DEFAULTS and BUILTIN_BASELINE_IDS. Without this the
//      two drift and "reset to shipped default" restores something that was
//      never shipped — a silent, permanent lie in the one action whose whole
//      value is being trustworthy.
//
//   3. THE CEILING IS STILL A CEILING. EDITOR_OFFERABLE stopped being an alias
//      of the historic exec set so the owner's request is expressible at all;
//      this pins exactly how far it moved and, more importantly, what it still
//      refuses.
//
// The two invariants in capabilities.test.ts — every role inside the historic
// exec set, and the four partitioning it exactly — are NOT touched by this
// feature and are NOT relaxed. They survive because ROLE_DEFAULTS stopped being
// edited. The last describe() below says so in a form that fails if anybody
// edits it anyway.
//
// EVERY ASSERTION IN THIS FILE THAT NAMED EXEC_BASELINE NOW NAMES
// EXEC_ASSIGNABLE, AND NOT ONE OF THEM CHANGED WHAT IT CLAIMS. This file was
// written when EXEC_BASELINE was the historic 73 and EDITOR_OFFERABLE spread it;
// the baseline has since narrowed to twelve reads and the 73 moved, verbatim and
// in order, to EXEC_ASSIGNABLE, which is what EDITOR_OFFERABLE spreads now. So
// "the exec baseline" in each comment below meant "what an exec could already
// do", and that is the constant the assertions follow. Left pointing at the
// twelve, every one of them would have been a different and much weaker claim:
// "the ceiling adds 66 things" instead of "the ceiling adds five, named".

const MIGRATION = readFileSync(
  join(__dirname, '../../../../../supabase/migrations/00104_editable_builtin_roles.sql'),
  'utf8',
);

// ---------------------------------------------------------------------------
// THE CEILING
// ---------------------------------------------------------------------------
describe('EDITOR_OFFERABLE, now that it is not the exec baseline', () => {
  // The exec transcription must not move, and this is the local half of the
  // guard — capability-equivalence.test.ts derives the same list independently
  // from the call sites, which is the half that cannot be fooled by editing a
  // constant and its test together.
  //
  // 73 IS STILL 73; ONLY THE CONSTANT HOLDING IT IS NAMED DIFFERENTLY. Asserting
  // `EXEC_BASELINE.length === 12` here would have pinned the floor while
  // claiming to guard the transcription, which is the exact substitution this
  // assertion exists to catch.
  it('leaves the assignable set exactly where it was', () => {
    expect(EXEC_ASSIGNABLE.length).toBe(73);
  });

  // AND THE FLOOR, WHICH IS THE THING THAT DID MOVE, pinned next to it so the
  // two are read together. Nobody should be able to change one and have the
  // other's assertion cover for them.
  it('leaves the exec baseline a read-only floor of twelve', () => {
    expect(EXEC_BASELINE.length).toBe(12);
    expect(EXEC_BASELINE.filter((c) => c.endsWith('.write'))).toEqual([]);
  });

  it('contains the whole assignable set, so nothing composable was withdrawn', () => {
    const offerable = new Set<Capability>(EDITOR_OFFERABLE);
    for (const capability of EXEC_ASSIGNABLE) {
      expect(offerable.has(capability), capability).toBe(true);
    }
  });

  // THE WIDENING, NAMED. Four reads on /fees — the club's books, which is what
  // the owner asked Finance to be able to see — and, since 00105, one write. If
  // this list grows, this assertion is the diff somebody has to read.
  it('adds exactly the four finance reads and the console-access write', () => {
    // AGAINST EXEC_ASSIGNABLE, because "added" means "beyond what an exec could
    // already do". Measured against the narrowed floor instead, this list would
    // be 66 entries long and would stop being the reviewable diff it exists to
    // be — the five below would be lost among sixty-one writes that are not
    // widenings at all, merely capabilities that now arrive by assignment.
    const exec = new Set<Capability>(EXEC_ASSIGNABLE);
    const added = [...EDITOR_OFFERABLE].filter((capability) => !exec.has(capability));
    expect(added.sort()).toEqual([
      'fees.clubfees.read',
      'fees.netposition.read',
      'fees.otherincome.read',
      'fees.reinstatements.read',
      'players.consoleaccess.write',
    ]);
  });

  // THE MONEY WIDENING IS STILL READ-ONLY, which is the claim that assertion
  // used to make about the whole list and can no longer make about the whole
  // list. Seeing the books is not moving the money, and every `fees.*.write`
  // stayed out — so it is asserted where it is actually true, over the `fees`
  // half, rather than weakened into nothing.
  it('adds no fees WRITE, so seeing the books is not moving the money', () => {
    // EXEC_ASSIGNABLE for the same reason as above: `fees.expenses.add.write` is
    // historic exec work, not a widening, and against the floor it would fail
    // this assertion while nothing had actually been opened up.
    const exec = new Set<Capability>(EXEC_ASSIGNABLE);
    for (const capability of EDITOR_OFFERABLE) {
      if (exec.has(capability)) continue;
      if (!capability.startsWith('fees.')) continue;
      expect(capability.endsWith('.read'), capability).toBe(true);
    }
  });

  // THE ONE WRITE, AND IT IS ALONE. 00105 — "also make role change a
  // permission". A second write arriving on this list is the diff this pins:
  // the ceiling is what bounds an ADMIN, whom grant closure cannot bound, so
  // every write on it is a thing an admin may hand to somebody who is not one.
  it('adds exactly one write, and it is the console-access one', () => {
    // EXEC_ASSIGNABLE: "one write" counts writes the CEILING added, and all
    // sixty-one writes an exec used to hold by default are still inside it.
    const exec = new Set<Capability>(EXEC_ASSIGNABLE);
    const writes = [...EDITOR_OFFERABLE].filter(
      (capability) => !exec.has(capability) && capability.endsWith('.write'),
    );
    expect(writes).toEqual(['players.consoleaccess.write']);
  });

  // THE ONES THAT STAY OUT, each named so opening it is deliberate. These are
  // the reason the ceiling was not simply deleted when it got in the way.
  it('still withholds permissions.write and the edge of the hard floor', () => {
    const offerable = new Set<Capability>(EDITOR_OFFERABLE);
    for (const capability of [
      // Editing a role to contain this would make "pick Finance from a
      // dropdown" hand over the ability to hand out permissions.
      'permissions.write',
      'permissions.page',
      // The grantable EDGE of the hard floor. The floor itself is unreachable
      // by construction; this is the nearest thing and stays per-person.
      'players.privilegedfields.write',
      // Destructive or identity-altering roster work.
      'players.remove.write',
      'players.merge.write',
      'players.deletion.cancel.write',
      'players.reliability.write',
      // Setting or moving money, as opposed to seeing it.
      'seasons.fees.write',
      'fees.clubfees.markpaid.write',
      'fees.clubfees.waive.write',
      'fees.otherincome.add.write',
      'fees.reinstatements.write',
      'fees.playerflags.write',
      'tournaments.fees.read',
      'tournaments.fees.markpaid.write',
      // Everything else that was admin work and was not asked for.
      'audit.page',
      'ratings.page',
      'accounts.page',
      'platform.page',
      'platform.settings.write',
      'legal.documents.write',
      'legal.waivertemplate.write',
      'challenges.page',
      'walkovers.page',
      'disputes.page',
    ] as Capability[]) {
      expect(offerable.has(capability), `${capability} became offerable`).toBe(false);
    }
  });

  it('is inside the vocabulary, with no duplicates', () => {
    expect(new Set(EDITOR_OFFERABLE).size).toBe(EDITOR_OFFERABLE.length);
    const all = new Set<string>(CAPABILITIES);
    for (const capability of EDITOR_OFFERABLE) expect(all.has(capability), capability).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE MOTIVATING EDIT
// ---------------------------------------------------------------------------
// The whole feature is worth nothing if the thing that prompted it is still
// refused, so it is asserted end to end through the real refusal function.
describe('teaching Finance to see money in as well as out', () => {
  const MONEY_IN: Capability[] = [
    'fees.page',
    'fees.expenses.read',
    'fees.expenses.add.write',
    'fees.clubfees.read',
    'fees.otherincome.read',
    'fees.netposition.read',
  ];

  it('is accepted for an admin, who holds everything', () => {
    const held = new Set<Capability>(CAPABILITIES);
    expect(baselineCapabilityRefusal(MONEY_IN, held)).toBeNull();
  });

  it('was refused before the ceiling moved, and the refusal is what moved', () => {
    // The old ceiling, reconstructed rather than remembered: EXEC_ASSIGNABLE is
    // what EDITOR_OFFERABLE used to be, and three of the six are outside it.
    //
    // IT IS THE ASSIGNABLE SET AND NOT THE FLOOR. The ceiling before 00104 was
    // the historic 73 — which is now EXEC_ASSIGNABLE and was then called
    // EXEC_BASELINE. Reconstructing it from today's twelve would put
    // `fees.expenses.add.write` in the refused list, and that capability was
    // never refused by the old ceiling: it is the one money write execs had.
    const oldCeiling = new Set<Capability>(EXEC_ASSIGNABLE);
    const wouldHaveBeenRefused = MONEY_IN.filter((c) => !oldCeiling.has(c));
    expect(wouldHaveBeenRefused.sort()).toEqual([
      'fees.clubfees.read',
      'fees.netposition.read',
      'fees.otherincome.read',
    ]);
  });

  // CLOSURE STILL BINDS, and it is the only thing binding a non-admin. An
  // officer who cannot see the club's books cannot write a role that shows them
  // to somebody else, however editable the role now is.
  it('is refused for an officer who does not hold the reads themselves', () => {
    const held = new Set<Capability>([
      'fees.page',
      'fees.expenses.read',
      'fees.expenses.add.write',
      'permissions.page',
      'permissions.write',
    ]);
    const refusal = baselineCapabilityRefusal(MONEY_IN, held);
    expect(refusal).toMatch(/you do not hold/i);
    expect(refusal).toContain('fees.clubfees.read');
  });

  // AND THE CEILING BINDS THE ADMIN, whom closure cannot. This is the case the
  // constant exists for.
  it('refuses permissions.write even from an admin who holds it', () => {
    const held = new Set<Capability>(CAPABILITIES);
    const refusal = baselineCapabilityRefusal(
      ['permissions.page', 'permissions.write'],
      held,
    );
    expect(refusal).toMatch(/admin-only/);
  });
});

// ---------------------------------------------------------------------------
// THE SEED
// ---------------------------------------------------------------------------
// Reads the migration as TEXT. The alternative — trusting that somebody kept
// two lists in step — is exactly what this feature cannot afford, because the
// seed is what "reset to shipped default" restores.
describe('00104 seeds what ROLE_DEFAULTS says', () => {
  /** The ARRAY[...] literal of the INSERT carrying this builtin_role. */
  function seededCapabilities(role: string): string[] {
    const marker = `'${role}'\n)`;
    const end = MIGRATION.indexOf(marker);
    expect(end, `no INSERT for ${role}`).toBeGreaterThan(-1);
    const block = MIGRATION.slice(0, end);
    const open = block.lastIndexOf('ARRAY[');
    const close = block.indexOf(']::TEXT[]', open);
    // Group 1 is non-null by construction: matchAll only yields matches, and
    // the pattern cannot match without capturing. Asserted rather than guarded
    // so a genuinely empty capture would still fail the assertion below.
    return [...block.slice(open + 'ARRAY['.length, close).matchAll(/'([^']+)'/g)].map(
      (m) => m[1]!,
    );
  }

  /** The id literal of the INSERT carrying this builtin_role. */
  function seededId(role: string): string {
    const end = MIGRATION.indexOf(`'${role}'\n)`);
    const block = MIGRATION.slice(0, end);
    const open = block.lastIndexOf('VALUES (');
    return block.slice(open).match(/'([0-9a-f-]{36})'/)![1]!;
  }

  it.each([...BUILTIN_PERMISSION_ROLES])('seeds %s with its shipped default', (role) => {
    expect(seededCapabilities(role)).toEqual([...ROLE_DEFAULTS[role]].sort());
  });

  it.each([...BUILTIN_PERMISSION_ROLES])('seeds %s under its pinned id', (role) => {
    expect(seededId(role)).toBe(BUILTIN_BASELINE_IDS[role]);
  });

  it.each([...BUILTIN_PERMISSION_ROLES])('seeds %s under its shown label', (role) => {
    const end = MIGRATION.indexOf(`'${role}'\n)`);
    const block = MIGRATION.slice(MIGRATION.slice(0, end).lastIndexOf('VALUES ('), end);
    expect(block).toContain(`'${PERMISSION_ROLE_LABELS[role]}'`);
  });

  // Four ids, four rows, no collisions — the reason a rename cannot lose one.
  it('gives the four distinct ids', () => {
    const ids = Object.values(BUILTIN_BASELINE_IDS);
    expect(new Set(ids).size).toBe(4);
  });

  // ON CONFLICT DO NOTHING, so re-applying the migration never silently undoes
  // an edit the owner made.
  it('never overwrites an edited row on re-application', () => {
    const inserts = MIGRATION.match(/INSERT INTO public\.permission_baselines/g) ?? [];
    expect(inserts.length).toBe(4);
    // The semicolon is what distinguishes the four STATEMENTS from the header
    // prose that explains why they are written this way.
    expect((MIGRATION.match(/ON CONFLICT \(id\) DO NOTHING;/g) ?? []).length).toBe(4);
    expect(MIGRATION).not.toMatch(/ON CONFLICT[^\n]*DO UPDATE/);
  });

  // shippedDefaultFor() is what reset() calls, so it has to be the same thing
  // the seed wrote and not a second reading of it.
  it.each([...BUILTIN_PERMISSION_ROLES])('resets %s to that same set', (role) => {
    expect([...shippedDefaultFor(role)].sort()).toEqual(seededCapabilities(role));
  });
});

// ---------------------------------------------------------------------------
// THE RESOLVER
// ---------------------------------------------------------------------------
// The claim the whole design rests on: a built-in role is copied, not resolved
// through, so nothing about resolvePermissions() had to change. Asserted by
// running it.
describe('the resolver is untouched by this feature', () => {
  it.each([...BUILTIN_PERMISSION_ROLES])(
    'resolves a copied %s to exactly the set that was copied',
    (role) => {
      const copied = [...ROLE_DEFAULTS[role]].sort();
      const resolved = resolvePermissions('custom', copied, []);
      expect(resolved.kind).toBe('restricted');
      if (resolved.kind !== 'restricted') return;
      expect([...resolved.capabilities].sort()).toEqual(copied);
    },
  );

  // THE EQUIVALENCE 00104's DATA CONVERSION RESTS ON, run rather than asserted
  // in prose. 'custom' has an empty base, so unioning the role's defaults into
  // the grants reproduces exactly what the role would have formed — which is why
  // rewriting today's holders moves nobody's access by one capability.
  it.each([...BUILTIN_PERMISSION_ROLES])(
    'gives a converted %s holder the identical set, extra grants and revokes included',
    (role) => {
      const extra = ['legal.page', 'legal.reacceptance.write'];
      const revokes = [...ROLE_DEFAULTS[role]].slice(0, 1);

      const asRole = resolvePermissions(role, extra, revokes);
      const asCopy = resolvePermissions(
        'custom',
        [...new Set([...ROLE_DEFAULTS[role], ...extra])].sort(),
        revokes,
      );

      expect(asRole.kind).toBe('restricted');
      expect(asCopy.kind).toBe('restricted');
      if (asRole.kind !== 'restricted' || asCopy.kind !== 'restricted') return;
      expect([...asCopy.capabilities].sort()).toEqual([...asRole.capabilities].sort());
    },
  );

  // The widened ceiling did not teach the resolver a new rule either: a money
  // read still needs its area page, exactly like everything else.
  it('still prunes a widened capability whose area page is absent', () => {
    const resolved = resolvePermissions('custom', ['fees.netposition.read'], []);
    expect(resolved.kind).toBe('restricted');
    if (resolved.kind !== 'restricted') return;
    expect([...resolved.capabilities]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// WHAT THE BUILT-INS ARE
// ---------------------------------------------------------------------------
describe('the four built-in roles', () => {
  it('are every permission role except the empty base', () => {
    expect([...BUILTIN_PERMISSION_ROLES].sort()).toEqual(
      PERMISSION_ROLES.filter((role) => role !== 'custom').sort(),
    );
  });

  it('narrows only those four, and refuses anything else', () => {
    for (const role of BUILTIN_PERMISSION_ROLES) {
      expect(isBuiltinPermissionRole(role), role).toBe(true);
    }
    for (const value of ['custom', '', null, undefined, 'admin', 'Finance']) {
      expect(isBuiltinPermissionRole(value), String(value)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// THE TWO INVARIANTS THAT WERE EXPECTED TO DIE
// ---------------------------------------------------------------------------
// The brief for this feature assumed a literal partition test could not survive
// roles becoming editable. It does, and the reason is the strongest evidence
// this design is the right shape: ROLE_DEFAULTS stopped being the runtime answer
// and became a frozen SEED, so the club's edits land in the table and the
// constant never moves.
//
// Both assertions live in capabilities.test.ts and are unchanged. They are
// restated here for one reason only: to fail loudly if somebody ever goes back
// to hand-editing the constant, because at that point the seed and the rows
// disagree and "reset to shipped default" starts lying.
describe('ROLE_DEFAULTS is a frozen seed, so its invariants still hold literally', () => {
  // BOTH RESTATEMENTS FOLLOW THE ORIGINALS TO EXEC_ASSIGNABLE. They exist to
  // fail if somebody hand-edits ROLE_DEFAULTS, and that job is unchanged; the
  // set they compare against is the same 73 under a new name. Pointing them at
  // the twelve would have made them assert that the four VP jobs hand out
  // nothing but reads, which is the opposite of what the roles are for.
  it('keeps every role inside what an exec may be assigned', () => {
    const assignable = new Set<Capability>(EXEC_ASSIGNABLE);
    for (const role of PERMISSION_ROLES) {
      for (const capability of ROLE_DEFAULTS[role]) {
        expect(
          assignable.has(capability),
          `${role} seeds ${capability}, which no exec ever held`,
        ).toBe(true);
      }
    }
  });

  it('still partitions the assignable set exactly', () => {
    const fromRoles = PERMISSION_ROLES.flatMap((role) => [...ROLE_DEFAULTS[role]]);
    expect(new Set(fromRoles).size, 'two roles claim the same capability').toBe(fromRoles.length);
    expect([...fromRoles].sort()).toEqual([...EXEC_ASSIGNABLE].sort());
  });

  // AND THE PART THAT IS GENUINELY NEW. The security property those tests
  // carried — "picking a role from a dropdown cannot hand out something nobody
  // reviewed" — is no longer a property of a constant, because the club edits
  // the rows. It is enforced at WRITE TIME instead, and this is that enforcement
  // reached through the same function every write path calls.
  it('bounds an EDIT the way the constant used to bound a deploy', () => {
    const held = new Set<Capability>(CAPABILITIES);
    // An admin editing Finance to reach beyond the ceiling: refused.
    expect(
      baselineCapabilityRefusal(
        ['fees.page', 'fees.expenses.read', 'fees.playerflags.write'],
        held,
      ),
    ).toMatch(/admin-only/);
    // ...and to reach inside it: allowed, which is the feature.
    expect(
      baselineCapabilityRefusal(
        ['fees.page', 'fees.expenses.read', 'fees.netposition.read'],
        held,
      ),
    ).toBeNull();
  });
});
