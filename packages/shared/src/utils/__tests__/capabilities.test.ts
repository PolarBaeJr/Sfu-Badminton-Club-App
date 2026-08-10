import { describe, it, expect } from 'vitest';
import {
  AREAS,
  CAPABILITIES,
  EXEC_BASELINE,
  TRAINER_BASELINE,
  PERMISSION_ROLES,
  ROLE_DEFAULTS,
  UNRESTRICTED,
  effectiveCapabilities,
  isCapability,
  permits,
  permissionsOf,
  resolvePermissions,
  type Capability,
} from '../access-level';
import { CAPABILITY_GATES, ENFORCEMENT_POINTS } from '../capability-gates';

// 113 capabilities is 113 promises that something is enforced. This suite is
// what keeps the vocabulary closed: it pins the list literally, refuses the
// shapes that would let one capability quietly imply another, and asserts that
// every one of them names a place in the app that reads it.

const resourceOf = (capability: string) => capability.split('.').slice(0, -1);
const modeOf = (capability: string) => capability.split('.').at(-1)!;

describe('the capability vocabulary', () => {
  it('is exactly 113 entries, with no duplicates', () => {
    expect(CAPABILITIES.length).toBe(113);
    expect(new Set(CAPABILITIES).size).toBe(113);
  });

  it('has 16 areas, every one of them used', () => {
    expect(AREAS.length).toBe(16);
    expect(new Set(AREAS).size).toBe(16);
    for (const area of AREAS) {
      expect(
        CAPABILITIES.some((c) => c.split('.')[0] === area),
        `area ${area} has no capabilities`,
      ).toBe(true);
    }
  });

  it('starts every capability with a declared area', () => {
    const areas = new Set<string>(AREAS);
    for (const capability of CAPABILITIES) {
      expect(areas.has(capability.split('.')[0]!), `${capability} names no area`).toBe(true);
    }
  });

  it('ends every capability in read or write, at depth 2 to 5', () => {
    for (const capability of CAPABILITIES) {
      const segments = capability.split('.');
      expect(['read', 'write']).toContain(segments.at(-1));
      expect(segments.length, `${capability} depth`).toBeGreaterThanOrEqual(2);
      expect(segments.length, `${capability} depth`).toBeLessThanOrEqual(5);
      for (const segment of segments) {
        expect(segment, `${capability} segment`).toMatch(/^[a-z0-9]+$/);
      }
    }
  });

  // NO PREFIX IMPLICATION. Resolve-time implication is how permission systems
  // grant things nobody reviewed: a coarse `players.write` sitting above
  // `players.editor.medicalhistory.write` would reach every holder of it with
  // no diff and no audit row. permits() is plain set membership, so no such
  // implication exists — and this refuses the SHAPE as well, so nobody can
  // reintroduce it by naming a capability that reads like a parent of another.
  //
  // Compared within a mode: `fees.expenses.read` and `fees.expenses.add.write`
  // are a read and a write, which is the ordinary read/write pairing, not a
  // coarse capability over a fine one.
  it('never lets one capability be a prefix of another at the same mode', () => {
    for (const mode of ['read', 'write']) {
      const paths = CAPABILITIES.filter((c) => modeOf(c) === mode).map(resourceOf);
      for (const a of paths) {
        for (const b of paths) {
          if (a === b) continue;
          const isPrefix = a.length < b.length && a.every((seg, i) => seg === b[i]);
          expect(isPrefix, `${a.join('.')}.${mode} prefixes ${b.join('.')}.${mode}`).toBe(false);
        }
      }
    }
  });

  it('narrows only strings the vocabulary actually has', () => {
    expect(isCapability('players.read')).toBe(true);
    expect(isCapability('players.write')).toBe(false);
    expect(isCapability('')).toBe(false);
    expect(isCapability(null)).toBe(false);
    expect(isCapability(42)).toBe(false);
  });
});

describe('CAPABILITY_GATES', () => {
  it('covers every capability and nothing else', () => {
    expect(Object.keys(CAPABILITY_GATES).sort()).toEqual([...CAPABILITIES].sort());
  });

  it('agrees with each capability about its area and mode', () => {
    for (const capability of CAPABILITIES) {
      const entry = CAPABILITY_GATES[capability];
      expect(entry.area, capability).toBe(capability.split('.')[0]);
      expect(entry.mode, capability).toBe(modeOf(capability));
      expect(entry.label.length, `${capability} has no label`).toBeGreaterThan(0);
      // A group, where there is one, is the capability's own second segment —
      // it is a real interior node of the path, never a category invented for
      // the editor.
      if (entry.group !== null) expect(entry.group, capability).toBe(capability.split('.')[1]);
    }
  });

  // The count assertion. At one capability per gate this is near one-to-one, so
  // it is a real check rather than documentation: deleting a gate without
  // deleting its capability leaves the editor offering a tick box nothing
  // reads, and that is what this fails on.
  it('names 126 distinct enforcement points, none of them claimed twice', () => {
    const sites: string[] = [];
    for (const capability of CAPABILITIES) {
      const entry = CAPABILITY_GATES[capability];
      if (entry.gate !== null) sites.push(entry.gate);
      sites.push(...(entry.also ?? []));
    }
    expect(sites.length).toBe(126);
    expect(new Set(sites).size).toBe(126);
    expect(ENFORCEMENT_POINTS).toBe(126);
  });

  // Merging two call sites into one capability is a decision, so it has to be
  // argued at the point it is made. Merge only where two sites are literally
  // the same act reached twice.
  it('makes every merge declare its reason', () => {
    for (const capability of CAPABILITIES) {
      const entry = CAPABILITY_GATES[capability];
      const merged = (entry.also?.length ?? 0) > 0;
      expect(merged, capability).toBe(typeof entry.merged === 'string');
      if (merged) expect(entry.merged!.length).toBeGreaterThan(20);
    }
  });

  // Exactly ONE capability is allowed to have nothing behind it, and it is
  // named here so that the second one cannot arrive quietly.
  it('leaves only permissions.write unwired, with a stated reason', () => {
    const unwired = CAPABILITIES.filter((c) => CAPABILITY_GATES[c].gate === null);
    expect(unwired).toEqual(['permissions.write']);
    expect(CAPABILITY_GATES['permissions.write'].unwired!.length).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// The baselines
// ---------------------------------------------------------------------------
// Pinned LITERALLY, because these two lists are the deploy-day guarantee. They
// are a transcription of what an exec and a trainer could do the day before
// capabilities existed, and the only way to notice one drifting is to have
// written it down twice.

describe('baselines', () => {
  it('gives a trainer exactly the roster read and varsity notes', () => {
    expect([...TRAINER_BASELINE]).toEqual([
      'players.read',
      'players.editor.varsitynotes.write',
    ]);
  });

  it('gives an exec exactly 69 capabilities, pinned one by one', () => {
    expect([...EXEC_BASELINE]).toEqual([
      'players.read',
      'players.approve.write',
      'players.create.write',
      'players.update.write',
      'players.waiver.resign.write',
      'players.ban.write',
      'players.reinstate.write',
      'players.editor.varsitynotes.write',
      'seasons.read',
      'seasons.create.write',
      'seasons.activate.write',
      'seasons.end.write',
      'sessions.read',
      'sessions.reminders.write',
      'sessions.create.write',
      'sessions.update.write',
      'sessions.archive.write',
      'sessions.checkin.token.write',
      'sessions.attendance.write',
      'sessions.delete.write',
      'matches.read',
      'matches.void.write',
      'matches.convert.write',
      'matches.create.write',
      'announcements.read',
      'announcements.create.write',
      'announcements.update.write',
      'announcements.delete.write',
      'tournaments.manage.read',
      'tournaments.manage.create.write',
      'tournaments.manage.update.write',
      'tournaments.manage.status.write',
      'tournaments.manage.suspend.write',
      'tournaments.manage.resume.write',
      'tournaments.manage.archive.write',
      'tournaments.manage.delete.write',
      'tournaments.manage.event.create.write',
      'tournaments.manage.event.update.write',
      'tournaments.manage.event.delete.write',
      'tournaments.manage.event.status.write',
      'tournaments.draw.participants.add.write',
      'tournaments.draw.participants.remove.write',
      'tournaments.draw.checkin.token.write',
      'tournaments.draw.checkin.mark.write',
      'tournaments.draw.noshow.write',
      'tournaments.draw.exit.write',
      'tournaments.draw.pairs.add.write',
      'tournaments.draw.pairs.remove.write',
      'tournaments.draw.seed.set.write',
      'tournaments.draw.seed.auto.write',
      'tournaments.draw.seed.clear.write',
      'tournaments.draw.generate.write',
      'tournaments.draw.lock.write',
      'tournaments.draw.unlock.write',
      'tournaments.results.enter.write',
      'tournaments.results.walkover.write',
      'tournaments.results.void.write',
      'tournaments.results.unvoid.write',
      'tournaments.results.undo.write',
      'tournaments.results.edit.write',
      'tournaments.results.entry.write',
      'tournaments.results.doublenoshow.write',
      'tournaments.results.bonuses.write',
      'tournaments.results.standings.write',
      'tournaments.results.finalize.write',
      'fees.expenses.read',
      'fees.expenses.add.write',
      'legal.read',
      'legal.reacceptance.write',
    ]);
    expect(EXEC_BASELINE.length).toBe(69);
  });

  it('keeps both baselines inside the vocabulary, with no duplicates', () => {
    for (const list of [EXEC_BASELINE, TRAINER_BASELINE]) {
      expect(new Set(list).size).toBe(list.length);
      for (const capability of list) expect(isCapability(capability)).toBe(true);
    }
  });

  // A trainer's level is a strict subset of an exec's — that was true of the
  // rungs and it has to stay true of the sets, or "exec" would stop meaning
  // "everything a trainer has, and more".
  it('keeps the trainer baseline inside the exec baseline', () => {
    const exec = new Set<Capability>(EXEC_BASELINE);
    for (const capability of TRAINER_BASELINE) expect(exec.has(capability)).toBe(true);
  });

  // Written down so that filling them in is a visible diff rather than a
  // discovery. Role contents ship with the storage migration; until then an
  // unassignable role with an empty base is the fail-closed reading.
  it('has no role defaults yet, and every role listed', () => {
    expect([...PERMISSION_ROLES]).toEqual(['finance', 'tournaments', 'internal', 'external']);
    for (const role of PERMISSION_ROLES) expect(ROLE_DEFAULTS[role]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// permits / effectiveCapabilities
// ---------------------------------------------------------------------------

describe('permits', () => {
  it('makes an admin a superuser BY LEVEL, holding all 113', () => {
    for (const capability of CAPABILITIES) {
      expect(permits('admin', UNRESTRICTED, capability), capability).toBe(true);
    }
    expect(effectiveCapabilities('admin', UNRESTRICTED).size).toBe(113);
  });

  it('gives an unrestricted person their level baseline and nothing more', () => {
    expect(effectiveCapabilities('exec', UNRESTRICTED).size).toBe(EXEC_BASELINE.length);
    expect(effectiveCapabilities('trainer', UNRESTRICTED).size).toBe(TRAINER_BASELINE.length);
    expect(permits('exec', UNRESTRICTED, 'fees.clubfees.read')).toBe(false);
    expect(permits('trainer', UNRESTRICTED, 'players.update.write')).toBe(false);
  });

  it('gives somebody with no level nothing at all', () => {
    expect(effectiveCapabilities(null, UNRESTRICTED).size).toBe(0);
    expect(permits(null, UNRESTRICTED, 'players.read')).toBe(false);
    expect(permits(undefined, UNRESTRICTED, 'players.read')).toBe(false);
  });

  it('reads a restricted set literally, with no implication', () => {
    const permissions = {
      kind: 'restricted' as const,
      capabilities: new Set<Capability>(['players.read', 'players.update.write']),
    };
    expect(permits('exec', permissions, 'players.update.write')).toBe(true);
    // Holding the coarse-looking roster write does NOT reach a leaf beneath it.
    expect(permits('exec', permissions, 'players.editor.varsitynotes.write')).toBe(false);
    expect(permits('exec', permissions, 'players.approve.write')).toBe(false);
    // ...and an admin is still unaffected by anything stored.
    expect(permits('admin', permissions, 'players.approve.write')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolvePermissions
// ---------------------------------------------------------------------------

const RESTRICTED = (permissions: ReturnType<typeof resolvePermissions>) => {
  if (permissions.kind !== 'restricted') throw new Error('expected a restricted set');
  return [...permissions.capabilities].sort();
};

describe('resolvePermissions', () => {
  it('treats an absent role as unrestricted, DELTAS AND ALL', () => {
    // The decisive case: if an absent role meant an empty base, adding the
    // first grant to an unrestricted exec would flip their base from the whole
    // exec baseline to zero — a grant that removes fifty-odd capabilities, one
    // click, silent.
    expect(resolvePermissions(null, [], [])).toEqual(UNRESTRICTED);
    expect(resolvePermissions(null, ['audit.read'], [])).toEqual(UNRESTRICTED);
    // And a revoke stored while the role is NULL stays dormant rather than
    // biting — it must not remove anything now, nor wake up later without
    // somebody choosing a role.
    expect(resolvePermissions(null, [], ['players.read'])).toEqual(UNRESTRICTED);
    expect(resolvePermissions('', [], [])).toEqual(UNRESTRICTED);
  });

  it('gives an unrecognised role no defaults, but still applies the deltas', () => {
    const resolved = resolvePermissions('treasurer', ['audit.read'], []);
    expect(RESTRICTED(resolved)).toEqual(['audit.read']);
  });

  it('lets a revoke beat a grant of the same capability', () => {
    const resolved = resolvePermissions('finance', ['audit.read'], ['audit.read']);
    expect(RESTRICTED(resolved)).toEqual([]);
  });

  it('drops an element the vocabulary no longer has, without throwing', () => {
    const resolved = resolvePermissions('finance', ['players.write', 'audit.read'], ['nonsense']);
    expect(RESTRICTED(resolved)).toEqual(['audit.read']);
  });

  // write ⊆ read, applied AFTER subtraction. Taking away somebody's view of a
  // ledger has to take away their ability to write to it, or they keep a
  // control whose consequences they cannot see. Order is load-bearing: pruning
  // first would leave the write behind.
  it('takes the write with the read when the read is revoked', () => {
    const resolved = resolvePermissions(
      'finance',
      ['fees.reinstatements.read', 'fees.reinstatements.write'],
      ['fees.reinstatements.read'],
    );
    expect(RESTRICTED(resolved)).toEqual([]);
  });

  it('leaves a write alone when its resource has no read in the vocabulary', () => {
    const resolved = resolvePermissions('finance', ['players.approve.write'], []);
    expect(RESTRICTED(resolved)).toEqual(['players.approve.write']);
  });

  it('is pure — the same inputs give the same answer and nothing is mutated', () => {
    const grants = ['audit.read'];
    const revokes: string[] = [];
    const first = RESTRICTED(resolvePermissions('finance', grants, revokes));
    const second = RESTRICTED(resolvePermissions('finance', grants, revokes));
    expect(first).toEqual(second);
    expect(grants).toEqual(['audit.read']);
    expect(revokes).toEqual([]);
  });
});

describe('permissionsOf', () => {
  // The heir of the old portfolioOf({}) === null. This is what makes the code
  // safe to deploy before the storage migration is applied: a missing column
  // must read as "not narrowed", because the alternative locks every exec out
  // of the console the moment the app ships.
  it('reads a row with none of the columns as unrestricted', () => {
    expect(permissionsOf({})).toEqual(UNRESTRICTED);
    expect(permissionsOf(null)).toEqual(UNRESTRICTED);
    expect(permissionsOf(undefined)).toEqual(UNRESTRICTED);
  });

  it('reads a null role as unrestricted', () => {
    expect(permissionsOf({ permission_role: null, permission_grants: [], permission_revokes: [] }))
      .toEqual(UNRESTRICTED);
  });

  // The columns are NOT NULL, so a role with a missing array can only come from
  // a narrowed SELECT — a programming error, not a state. The obvious `?? []`
  // would silently discard revokes, and a discarded revoke can leave somebody
  // holding permissions.write.
  it('THROWS on a role with a missing delta column', () => {
    expect(() => permissionsOf({ permission_role: 'finance' })).toThrow(/narrow the SELECT less/);
    expect(() => permissionsOf({ permission_role: 'finance', permission_grants: [] }))
      .toThrow(/narrow the SELECT less/);
  });

  it('resolves a complete row', () => {
    const resolved = permissionsOf({
      permission_role: 'finance',
      permission_grants: ['audit.read'],
      permission_revokes: [],
    });
    expect(RESTRICTED(resolved)).toEqual(['audit.read']);
  });
});
