import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Capability } from '../permissions';

// CUSTOM BASELINES, AND THE THREE THINGS THAT MAKE THEM SAFE.
//
// A baseline is a named capability set in the database that is COPIED onto a
// row — permission_role = 'custom' with the capabilities in permission_grants —
// rather than resolved through. So the resolver is untouched by the feature and
// none of the properties it guarantees can have moved. What CAN move is who is
// allowed to write one down and who is allowed to hand it over, and that is
// what this file is about:
//
//   1. GRANT CLOSURE AT AUTHORING. An author may only put capabilities in a
//      baseline that they themselves hold, and editing one down is bound by the
//      same rule because it is a revoke by another name.
//   2. GRANT CLOSURE AT ASSIGNMENT, unchanged. The five checks in
//      setPlayerPermissions still run per person, so "this baseline was legal to
//      write" never stands in for "this actor may hand it to this person".
//   3. THE HARD FLOOR. role, is_exec, is_trainer and the permission_* columns
//      are reachable by no capability, so no baseline can name one — asserted
//      here against every write this feature makes, not only against the
//      vocabulary.
//
// The harness is grant-closure.test.ts's, extended with DELETE and with an id
// generated on insert. The gate is the REAL one: requireCapability resolves the
// actor's row through the real baselines and the real resolver, which is what
// makes every closure assertion below mean something.

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  actor: {} as Row,
  nextId: 1,
}));

const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    let op: 'select' | 'update' | 'insert' | 'delete' = 'select';
    let payload: Row = {};

    const matching = () =>
      (store.db[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));

    const run = (): { data: Row[] | null; error: { message: string } | null } => {
      if (op === 'insert') {
        const rows = (store.db[table] ??= []);
        // The unique index on permission_baselines, case- and space-insensitive,
        // as the database would apply it.
        if (table === 'permission_baselines') {
          const key = String(payload.name ?? '').trim().toLowerCase();
          if (rows.some((r) => String(r.name ?? '').trim().toLowerCase() === key)) {
            return { data: null, error: { message: 'duplicate key value violates unique constraint "permission_baselines_name_key"' } };
          }
        }
        const written = { id: `bbbbbbbb-0000-4000-8000-00000000000${store.nextId++}`, ...payload };
        rows.push(written);
        return { data: [written], error: null };
      }
      if (op === 'update') {
        const hit = matching();
        for (const r of hit) Object.assign(r, payload);
        return { data: hit, error: null };
      }
      if (op === 'delete') {
        const hit = matching();
        store.db[table] = (store.db[table] ?? []).filter((r) => !hit.includes(r));
        return { data: hit, error: null };
      }
      return { data: matching(), error: null };
    };

    const api = {
      select() { return api; },
      insert(p: Row) { op = 'insert'; payload = p; return api; },
      update(p: Row) { op = 'update'; payload = p; return api; },
      delete() { op = 'delete'; return api; },
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      async maybeSingle() {
        const res = run();
        return { data: res.data?.[0] ?? null, error: res.error };
      },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(run()).then(resolve); },
    };
    return api;
  }
  return { from: (table: string) => query(table) };
});

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('../supabase-server', () => ({ createAdminClient: makeClient }));

vi.mock('../actions/_shared', async () => {
  const { accessLevelFor, permissionsOf, permits } = await import('../permissions');
  return {
    requireCapability: async (capability: Capability) => {
      const level = accessLevelFor(store.actor);
      if (!permits(level, permissionsOf(store.actor), capability)) {
        throw new Error('Admin access required');
      }
      return store.actor;
    },
  };
});

import {
  createPermissionBaseline,
  deletePermissionBaseline,
  updatePermissionBaseline,
} from '../actions/permission-baselines';
import { setPlayerPermissions } from '../actions/permissions';

const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const EXEC_A = 'eeeeeeee-0000-4000-8000-000000000001';
const EXEC_B = 'eeeeeeee-0000-4000-8000-000000000002';
const TRAINER = 'tttttttt-0000-4000-8000-000000000001';

const exec = (id: string, extra: Row = {}): Row => ({
  id,
  full_name: `Exec ${id.slice(-1)}`,
  email: null,
  role: 'player',
  is_exec: true,
  is_trainer: false,
  permission_role: null,
  permission_grants: [],
  permission_revokes: [],
  permission_baseline_id: null,
  ...extra,
});

const admin = (id: string): Row => ({
  id,
  full_name: 'An admin',
  email: null,
  role: 'admin',
  is_exec: false,
  is_trainer: false,
  permission_role: null,
  permission_grants: [],
  permission_revokes: [],
  permission_baseline_id: null,
});

const trainer = (id: string, extra: Row = {}): Row => ({
  id,
  full_name: 'A trainer',
  email: null,
  role: 'player',
  is_exec: false,
  is_trainer: true,
  permission_role: null,
  permission_grants: [],
  permission_revokes: [],
  permission_baseline_id: null,
  ...extra,
});

const rowFor = (id: string) => store.db.players!.find((p) => p.id === id)!;
const baselines = () => store.db.permission_baselines ?? [];
const audits = () => store.db.audit_logs ?? [];

/** An exec narrowed to exactly the finance job, with permissions.write on top. */
const TREASURER: Row = {
  permission_role: 'finance',
  permission_grants: ['permissions.page', 'permissions.write'],
  permission_revokes: [],
};

const SOCIALS: Capability[] = [
  'announcements.page',
  'announcements.create.write',
  'announcements.update.write',
];

beforeEach(() => {
  store.nextId = 1;
  store.db = {
    players: [admin(ADMIN), exec(EXEC_A), exec(EXEC_B), trainer(TRAINER)],
    permission_baselines: [],
    audit_logs: [],
  };
  store.actor = rowFor(ADMIN);
});

/** Create through the action, as an admin, and hand back the id. */
async function seedBaseline(name: string, capabilities: Capability[]): Promise<string> {
  const previous = store.actor;
  store.actor = rowFor(ADMIN);
  const result = await createPermissionBaseline(name, capabilities);
  store.actor = previous;
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

describe('writing a baseline down', () => {
  it('stores it sorted, de-duplicated, and audited', async () => {
    const id = await seedBaseline('Socials VP', [...SOCIALS, 'announcements.page']);
    const row = baselines().find((b) => b.id === id)!;
    expect(row.name).toBe('Socials VP');
    expect(row.capabilities).toEqual([...SOCIALS].sort());
    expect(row.created_by).toBe(ADMIN);

    const entry = audits().at(-1)!;
    expect(entry.action_type).toBe('permission_baseline_created');
    expect(entry.target_type).toBe('permission_baseline');
    expect(entry.target_id).toBe(id);
  });

  it('refuses a second baseline with the same name in any casing', async () => {
    await seedBaseline('Socials VP', SOCIALS);
    const again = await createPermissionBaseline('  socials vp ', SOCIALS);
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.error).toMatch(/already a baseline/);
  });

  it('refuses a capability whose area page is missing', async () => {
    const result = await createPermissionBaseline('Broken', ['announcements.create.write']);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/announcements\.page/);
    expect(baselines()).toHaveLength(0);
  });

  it('refuses an empty baseline', async () => {
    const result = await createPermissionBaseline('Nothing', []);
    expect(result.ok).toBe(false);
    expect(baselines()).toHaveLength(0);
  });

  // ------------------------------------------------------------------
  // CLOSURE AT AUTHORING
  // ------------------------------------------------------------------
  it('refuses a capability the author does not hold', async () => {
    Object.assign(rowFor(EXEC_A), TREASURER);
    store.actor = rowFor(EXEC_A);
    const result = await createPermissionBaseline('Reach', SOCIALS);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/do not hold/);
    expect(baselines()).toHaveLength(0);
  });

  it('lets an author write down exactly their own job', async () => {
    Object.assign(rowFor(EXEC_A), TREASURER);
    store.actor = rowFor(EXEC_A);
    const result = await createPermissionBaseline('Expenses only', [
      'fees.page',
      'fees.expenses.read',
      'fees.expenses.add.write',
    ]);
    expect(result.ok).toBe(true);
  });

  // Closure cannot bound an admin — they hold everything by level — so the
  // ceiling is what stops a baseline nobody could ever assign.
  it('caps an admin at what the editor may hand out', async () => {
    const result = await createPermissionBaseline('Superuser', [
      'permissions.page',
      'permissions.write',
    ]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/admin-only/);
    expect(baselines()).toHaveLength(0);
  });

  it('refuses somebody without permissions.write outright', async () => {
    store.actor = rowFor(EXEC_A);
    const result = await createPermissionBaseline('Socials VP', SOCIALS);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/Admin access required/);
  });
});

describe('handing a baseline to somebody', () => {
  it('copies the capabilities and records where they came from', async () => {
    const id = await seedBaseline('Socials VP', SOCIALS);
    const result = await setPlayerPermissions(EXEC_A, {
      role: 'custom',
      grants: SOCIALS,
      revokes: [],
      baselineId: id,
    });
    expect(result.ok).toBe(true);

    const row = rowFor(EXEC_A);
    expect(row.permission_role).toBe('custom');
    expect(row.permission_grants).toEqual([...SOCIALS].sort());
    expect(row.permission_revokes).toEqual([]);
    expect(row.permission_baseline_id).toBe(id);
  });

  // THE BASELINE IS THE SOURCE OF TRUTH when its id is sent. A payload that
  // disagrees is refused rather than overruled: silently writing the other one
  // is how an admin comes to believe they granted what the diff showed them.
  it('refuses a payload that does not match the baseline', async () => {
    const id = await seedBaseline('Socials VP', SOCIALS);
    const result = await setPlayerPermissions(EXEC_A, {
      role: 'custom',
      grants: [...SOCIALS, 'announcements.delete.write'],
      revokes: [],
      baselineId: id,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/does not match/);
    expect(rowFor(EXEC_A).permission_role).toBeNull();
  });

  it('refuses a baseline stored under any role but hand-picked', async () => {
    const id = await seedBaseline('Socials VP', SOCIALS);
    const result = await setPlayerPermissions(EXEC_A, {
      role: 'external',
      grants: SOCIALS,
      revokes: [],
      baselineId: id,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/Hand-picked/);
  });

  // THE LABEL DROPS ON ANY HAND EDIT, and every capability stays. Without this
  // the row would claim a baseline it no longer matches, and the next edit to
  // that baseline would propagate over the extra tick.
  it('clears the label when the set is edited by hand', async () => {
    const id = await seedBaseline('Socials VP', SOCIALS);
    await setPlayerPermissions(EXEC_A, {
      role: 'custom', grants: SOCIALS, revokes: [], baselineId: id,
    });

    const extra: Capability[] = [...SOCIALS, 'announcements.delete.write'];
    const result = await setPlayerPermissions(EXEC_A, {
      role: 'custom', grants: extra, revokes: [],
    });
    expect(result.ok).toBe(true);
    expect(rowFor(EXEC_A).permission_baseline_id).toBeNull();
    expect(rowFor(EXEC_A).permission_grants).toEqual([...extra].sort());
  });

  it('clears the label when the person goes back to unrestricted', async () => {
    const id = await seedBaseline('Socials VP', SOCIALS);
    await setPlayerPermissions(EXEC_A, {
      role: 'custom', grants: SOCIALS, revokes: [], baselineId: id,
    });
    await setPlayerPermissions(EXEC_A, { role: null, grants: [], revokes: [] });
    expect(rowFor(EXEC_A).permission_baseline_id).toBeNull();
    expect(rowFor(EXEC_A).permission_role).toBeNull();
  });

  // ------------------------------------------------------------------
  // CLOSURE AT ASSIGNMENT, unchanged by any of this
  // ------------------------------------------------------------------
  it('refuses an actor who does not hold what the baseline says', async () => {
    const id = await seedBaseline('Socials VP', SOCIALS);
    Object.assign(rowFor(EXEC_A), TREASURER);
    store.actor = rowFor(EXEC_A);
    const result = await setPlayerPermissions(EXEC_B, {
      role: 'custom', grants: SOCIALS, revokes: [], baselineId: id,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/cannot grant/);
    expect(rowFor(EXEC_B).permission_baseline_id).toBeNull();
  });

  it('composes a trainer with one, which is a widening and is allowed', async () => {
    const id = await seedBaseline('Socials VP', SOCIALS);
    const result = await setPlayerPermissions(TRAINER, {
      role: 'custom', grants: SOCIALS, revokes: [], baselineId: id,
    });
    expect(result.ok).toBe(true);
    const { accessLevelFor, effectiveCapabilities, permissionsOf } = await import('../permissions');
    const row = rowFor(TRAINER);
    const set = effectiveCapabilities(accessLevelFor(row), permissionsOf(row));
    expect([...set].sort()).toEqual([...SOCIALS].sort());
  });

  it('refuses one on an admin, whose stored set is never consulted', async () => {
    const id = await seedBaseline('Socials VP', SOCIALS);
    const other = admin('aaaaaaaa-0000-4000-8000-000000000009');
    store.db.players!.push(other);
    const result = await setPlayerPermissions(other.id as string, {
      role: 'custom', grants: SOCIALS, revokes: [], baselineId: id,
    });
    expect(result.ok).toBe(false);
  });
});

describe('editing a baseline', () => {
  it('propagates to every holder in one act', async () => {
    const id = await seedBaseline('Socials VP', SOCIALS);
    for (const person of [EXEC_A, EXEC_B]) {
      await setPlayerPermissions(person, {
        role: 'custom', grants: SOCIALS, revokes: [], baselineId: id,
      });
    }

    const wider: Capability[] = [...SOCIALS, 'announcements.delete.write'];
    const result = await updatePermissionBaseline(id, 'Socials VP', wider, 'they run the socials now');
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.data.propagated).toBe(2);

    for (const person of [EXEC_A, EXEC_B]) {
      expect(rowFor(person).permission_grants).toEqual([...wider].sort());
      expect(rowFor(person).permission_baseline_id).toBe(id);
    }
    expect(baselines()[0]!.capabilities).toEqual([...wider].sort());
  });

  it('writes the reason onto every person it reached', async () => {
    const id = await seedBaseline('Socials VP', SOCIALS);
    await setPlayerPermissions(EXEC_A, {
      role: 'custom', grants: SOCIALS, revokes: [], baselineId: id,
    });
    await updatePermissionBaseline(id, 'Socials VP', [...SOCIALS, 'announcements.delete.write'], 'agreed at the AGM');

    const personal = audits().filter((a) => a.action_type === 'player_permissions_changed');
    expect(personal.at(-1)!.reason).toBe('agreed at the AGM');
    const own = audits().filter((a) => a.action_type === 'permission_baseline_updated');
    expect(own).toHaveLength(1);
    expect(own[0]!.reason).toBe('agreed at the AGM');
  });

  it('demands a typed reason', async () => {
    const id = await seedBaseline('Socials VP', SOCIALS);
    const result = await updatePermissionBaseline(id, 'Socials VP', SOCIALS, '   ');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/Say why/);
  });

  // ONE UNREACHABLE HOLDER REFUSES THE WHOLE EDIT — the promise saveBatch makes
  // for a batch somebody chose, held here for a batch nobody did.
  it('writes nothing at all when one holder is out of reach', async () => {
    const id = await seedBaseline('Socials VP', SOCIALS);
    await setPlayerPermissions(EXEC_A, {
      role: 'custom', grants: SOCIALS, revokes: [], baselineId: id,
    });
    // EXEC_B holds the whole exec baseline and this baseline; an actor narrowed
    // to the socials job cannot reach them.
    await setPlayerPermissions(EXEC_B, {
      role: 'custom', grants: SOCIALS, revokes: [], baselineId: id,
    });
    Object.assign(rowFor(EXEC_B), {
      permission_grants: [...SOCIALS, 'players.page', 'players.read'].sort(),
      permission_baseline_id: id,
    });

    Object.assign(rowFor(TRAINER), {
      permission_role: 'custom',
      permission_grants: [...SOCIALS, 'permissions.page', 'permissions.write'].sort(),
      permission_revokes: [],
    });
    store.actor = rowFor(TRAINER);

    const result = await updatePermissionBaseline(id, 'Socials lead', SOCIALS, 'tidying up');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/players\.page|players\.read/);
    // Not renamed, so the refusal happened before the baseline row was touched.
    expect(baselines()[0]!.name).toBe('Socials VP');
    expect(rowFor(EXEC_B).permission_grants).toEqual(
      [...SOCIALS, 'players.page', 'players.read'].sort(),
    );
  });

  it('refuses an editor who holds the baseline themselves', async () => {
    const id = await seedBaseline('Socials VP', SOCIALS);
    Object.assign(rowFor(TRAINER), {
      permission_role: 'custom',
      permission_grants: [...SOCIALS, 'permissions.page', 'permissions.write'].sort(),
      permission_revokes: [],
      permission_baseline_id: id,
    });
    store.actor = rowFor(TRAINER);
    const result = await updatePermissionBaseline(id, 'Socials VP', SOCIALS, 'because');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/yourself/);
  });

  // EDITING ONE DOWN IS A REVOKE BY ANOTHER NAME, so it is bound by what the
  // baseline SAID as well as by what it will say.
  it('refuses an editor who cannot reach what the baseline already holds', async () => {
    const id = await seedBaseline('Socials VP', SOCIALS);
    Object.assign(rowFor(EXEC_A), TREASURER);
    store.actor = rowFor(EXEC_A);
    const result = await updatePermissionBaseline(id, 'Socials VP', [
      'fees.page', 'fees.expenses.read', 'fees.expenses.add.write',
    ], 'making it mine');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/which you do not/);
    expect(baselines()[0]!.capabilities).toEqual([...SOCIALS].sort());
  });

  it('still applies the ceiling on the new contents', async () => {
    const id = await seedBaseline('Socials VP', SOCIALS);
    const result = await updatePermissionBaseline(
      id,
      'Socials VP',
      [...SOCIALS, 'audit.page'],
      'widening',
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/admin-only/);
  });
});

describe('deleting a baseline', () => {
  it('removes one nobody holds, and says what it was', async () => {
    const id = await seedBaseline('Socials VP', SOCIALS);
    const result = await deletePermissionBaseline(id, 'the role was folded into External');
    expect(result.ok).toBe(true);
    expect(baselines()).toHaveLength(0);

    const entry = audits().at(-1)!;
    expect(entry.action_type).toBe('permission_baseline_deleted');
    expect(entry.reason).toBe('the role was folded into External');
    expect((entry.old_value as { capabilities: string[] }).capabilities)
      .toEqual([...SOCIALS].sort());
  });

  it('refuses while somebody holds it, and names them', async () => {
    const id = await seedBaseline('Socials VP', SOCIALS);
    await setPlayerPermissions(EXEC_A, {
      role: 'custom', grants: SOCIALS, revokes: [], baselineId: id,
    });
    const result = await deletePermissionBaseline(id, 'no longer needed');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/Exec 1/);
    expect(baselines()).toHaveLength(1);
  });

  it('demands a typed reason', async () => {
    const id = await seedBaseline('Socials VP', SOCIALS);
    const result = await deletePermissionBaseline(id, '');
    expect(result.ok).toBe(false);
    expect(baselines()).toHaveLength(1);
  });

  it('refuses a deleter who cannot reach what it holds', async () => {
    const id = await seedBaseline('Socials VP', SOCIALS);
    Object.assign(rowFor(EXEC_A), TREASURER);
    store.actor = rowFor(EXEC_A);
    const result = await deletePermissionBaseline(id, 'tidying');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/which you do not/);
    expect(baselines()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// THE HARD FLOOR
// ---------------------------------------------------------------------------
// role, is_exec, is_trainer and the permission_* columns are refused below admin
// under all circumstances and are reachable by NO capability. A baseline is a
// set of capabilities, so it cannot name one — but "cannot" is worth testing
// against the WRITES this feature makes rather than only against the
// vocabulary, because a write is where a column would actually move.
describe('the hard floor', () => {
  it('no baseline write touches a level marker', async () => {
    const id = await seedBaseline('Socials VP', SOCIALS);

    const before = { role: rowFor(EXEC_A).role, is_exec: rowFor(EXEC_A).is_exec, is_trainer: rowFor(EXEC_A).is_trainer };
    await setPlayerPermissions(EXEC_A, {
      role: 'custom', grants: SOCIALS, revokes: [], baselineId: id,
    });
    await updatePermissionBaseline(id, 'Socials VP', [...SOCIALS, 'announcements.delete.write'], 'x');

    expect(rowFor(EXEC_A).role).toBe(before.role);
    expect(rowFor(EXEC_A).is_exec).toBe(before.is_exec);
    expect(rowFor(EXEC_A).is_trainer).toBe(before.is_trainer);
    // ...and the trainer nobody touched is still a trainer and still unrestricted.
    expect(rowFor(TRAINER).is_trainer).toBe(true);
    expect(rowFor(TRAINER).permission_role).toBeNull();
  });

  // The vocabulary itself, checked here as well as in shared: a capability whose
  // name reads as one of these columns is the one way a baseline could ever
  // claim to hand out a level.
  it('no capability in the vocabulary names a floor column', async () => {
    const { CAPABILITIES } = await import('../permissions');
    for (const capability of CAPABILITIES) {
      for (const column of ['role', 'is_exec', 'is_trainer', 'permission_']) {
        expect(capability.includes(column), `${capability} reads as ${column}`).toBe(false);
      }
    }
  });
});
