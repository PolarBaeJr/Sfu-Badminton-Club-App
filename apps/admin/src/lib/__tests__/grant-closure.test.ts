import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Capability } from '../permissions';

// GRANT CLOSURE — the primary defence, and what makes permissions.write safe to
// hand to somebody who is not an admin.
//
// The old model had a property that made it safe almost by accident: a
// portfolio could only ever NARROW an exec, so no configuration of it could
// widen anybody. The additive model gives that up, and this is one of the three
// things that replace it: nobody grants what they do not hold, revokes are
// bound by the same rule, and the actor's set is resolved server-side from the
// actor's own row through the same path the gates use.
//
// The other two are the pinned baselines with the equivalence proof
// (capabilities.test.ts, capability-equivalence.test.ts) and the hard floor
// (player-field-access.test.ts). Drop any one and the model is unsafe; these
// tests only cover this one.

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  // The signed-in caller, as a player ROW. Every capability decision below is
  // made from this and from nothing else — that is the point being tested.
  actor: {} as Row,
}));

const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    let op: 'select' | 'update' | 'insert' = 'select';
    let payload: Row = {};

    const matching = () =>
      (store.db[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));

    const run = (): { data: Row[] | null; error: { message: string } | null } => {
      if (op === 'insert') {
        (store.db[table] ??= []).push({ ...payload });
        return { data: [payload], error: null };
      }
      if (op === 'update') {
        const hit = matching();
        for (const r of hit) Object.assign(r, payload);
        return { data: hit, error: null };
      }
      return { data: matching(), error: null };
    };

    const api = {
      select() { return api; },
      insert(p: Row) { op = 'insert'; payload = p; return api; },
      update(p: Row) { op = 'update'; payload = p; return api; },
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

// The REAL gate decision, against the real baselines and the real resolver.
// requireCapability returns the row it authenticated, which is exactly how the
// action gets the actor's set — mocking it to return an arbitrary object is
// what makes the closure tests below mean anything.
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

import { setPlayerPermissions } from '../actions/permissions';

const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_ADMIN = 'aaaaaaaa-0000-4000-8000-000000000002';
const EXEC_A = 'eeeeeeee-0000-4000-8000-000000000001';
const EXEC_B = 'eeeeeeee-0000-4000-8000-000000000002';
const EXEC_C = 'eeeeeeee-0000-4000-8000-000000000003';
const TRAINER = 'tttttttt-0000-4000-8000-000000000001';

/** An unrestricted exec row — every row's state on the day 00087 lands. */
const exec = (id: string, extra: Row = {}): Row => ({
  id,
  full_name: `Exec ${id.slice(-1)}`,
  role: 'player',
  is_exec: true,
  is_trainer: false,
  permission_role: null,
  permission_grants: [],
  permission_revokes: [],
  ...extra,
});

const admin = (id: string): Row => ({
  id,
  full_name: 'An admin',
  role: 'admin',
  is_exec: false,
  is_trainer: false,
  permission_role: null,
  permission_grants: [],
  permission_revokes: [],
});

const rowFor = (id: string) => store.db.players!.find((p) => p.id === id)!;
const audits = () => store.db.audit_logs ?? [];

beforeEach(() => {
  store.db = {
    players: [
      admin(ADMIN),
      admin(OTHER_ADMIN),
      exec(EXEC_A),
      exec(EXEC_B),
      exec(EXEC_C),
      {
        id: TRAINER,
        full_name: 'A trainer',
        role: 'player',
        is_exec: false,
        is_trainer: true,
        permission_role: null,
        permission_grants: [],
        permission_revokes: [],
      },
    ],
    audit_logs: [],
  };
  store.actor = rowFor(ADMIN);
});

describe('setPlayerPermissions — who may edit whom', () => {
  it('refuses to let anybody edit their own row', async () => {
    const res = await setPlayerPermissions(ADMIN, { role: null, grants: [], revokes: [] });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/your own permissions/);
  });

  // Its own message, ahead of the subset test that would also catch it. "Their
  // set is not a subset of yours" is true and useless; this tells a treasurer
  // who to ask.
  it('tells a non-admin in plain words that admins are off limits', async () => {
    store.actor = rowFor(EXEC_A);
    store.actor.permission_role = 'finance';
    store.actor.permission_grants = ['permissions.page', 'permissions.write'];

    const res = await setPlayerPermissions(OTHER_ADMIN, {
      role: 'finance',
      grants: [],
      revokes: [],
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe("Only an admin can change an admin's permissions.");
  });

  // The BEFORE half of the whom-rule. Without it, a narrowly-scoped holder of
  // permissions.write could reach into somebody who holds more than they do
  // purely by narrowing them — granting nothing at all, and so passing every
  // delta check.
  it('refuses a non-subset target even when the change only narrows them', async () => {
    store.actor = rowFor(EXEC_A);
    store.actor.permission_role = 'finance';
    store.actor.permission_grants = ['permissions.page', 'permissions.write'];

    // EXEC_B is unrestricted, so they hold the whole exec baseline — far more
    // than the actor's Expenses tab.
    const res = await setPlayerPermissions(EXEC_B, { role: 'finance', grants: [], revokes: [] });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/they hold .*which you do not/);
    expect(rowFor(EXEC_B).permission_role).toBeNull();
  });
});

describe('setPlayerPermissions — nobody grants what they do not hold', () => {
  it('lets an admin grant anything the editor offers', async () => {
    const res = await setPlayerPermissions(EXEC_A, {
      role: 'finance',
      grants: ['players.page', 'players.approve.write'],
      revokes: [],
    });
    expect(res.ok).toBe(true);
    expect(rowFor(EXEC_A).permission_grants).toEqual([
      'players.approve.write',
      'players.page',
    ]);
  });

  it('lets a delegate grant exactly their own set, and nothing beyond it', async () => {
    // A finance officer who has also been handed the roster.
    store.actor = rowFor(EXEC_A);
    store.actor.permission_role = 'finance';
    store.actor.permission_grants = [
      'permissions.page',
      'permissions.write',
      'players.page',
      'players.approve.write',
    ];
    // The target must already be inside the actor's set for the whom-rule to
    // let them near it at all.
    Object.assign(rowFor(EXEC_B), { permission_role: 'finance', permission_grants: [], permission_revokes: [] });

    const ok = await setPlayerPermissions(EXEC_B, {
      role: 'finance',
      grants: ['players.page', 'players.approve.write'],
      revokes: [],
    });
    expect(ok.ok).toBe(true);

    const overreach = await setPlayerPermissions(EXEC_B, {
      role: 'finance',
      grants: ['players.page', 'players.approve.write', 'players.ban.write'],
      revokes: [],
    });
    expect(overreach.ok).toBe(false);
    expect(overreach.ok === false && overreach.error).toMatch(/cannot grant Ban a member \(write\)/);
    // NOTHING APPLIED. All-or-nothing: the two capabilities that WERE allowed
    // must not have been written on the way to refusing the third.
    expect(rowFor(EXEC_B).permission_grants).toEqual([
      'players.approve.write',
      'players.page',
    ]);
  });

  // An unbounded revoke is a denial-of-access weapon: a narrowly-scoped holder
  // could strip a colleague of the capabilities they were elected to use.
  it('binds a revoke by the same rule as a grant', async () => {
    store.actor = rowFor(EXEC_A);
    store.actor.permission_role = 'finance';
    store.actor.permission_grants = ['permissions.page', 'permissions.write'];
    Object.assign(rowFor(EXEC_B), {
      permission_role: 'finance',
      permission_grants: [],
      permission_revokes: [],
    });

    const res = await setPlayerPermissions(EXEC_B, {
      role: 'finance',
      grants: [],
      revokes: ['players.ban.write'],
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/cannot revoke Ban a member \(write\)/);
  });

  // The AFTER half of the whom-rule. A role change moves the whole base at
  // once, and its defaults are not grants — so nothing in the delta checks
  // would ever look at them.
  it('catches a role change whose defaults exceed the actor’s set', async () => {
    store.actor = rowFor(EXEC_A);
    store.actor.permission_role = 'finance';
    store.actor.permission_grants = ['permissions.page', 'permissions.write'];
    Object.assign(rowFor(EXEC_B), {
      permission_role: 'finance',
      permission_grants: [],
      permission_revokes: [],
    });

    const res = await setPlayerPermissions(EXEC_B, { role: 'internal', grants: [], revokes: [] });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/That would give them/);
    expect(rowFor(EXEC_B).permission_role).toBe('finance');
  });

  // NO PREFIX IMPLICATION, asserted through the closure check rather than
  // through permits(). If resolve-time implication were ever added, this is
  // where it would show up as a delegate silently able to hand out a leaf they
  // were never given.
  it('does not let a holder of the roster write hand out varsity notes', async () => {
    // The actor was handed the roster and the ability to edit a member. They
    // were NOT handed the coaching log, which sits beneath the same first path
    // segment and is a completely separate act.
    store.actor = rowFor(EXEC_A);
    store.actor.permission_role = 'finance';
    store.actor.permission_grants = [
      'permissions.page',
      'permissions.write',
      'players.page',
      'players.update.write',
    ];
    Object.assign(rowFor(EXEC_B), {
      permission_role: 'finance',
      permission_grants: ['players.page', 'players.update.write'],
      permission_revokes: [],
    });

    const res = await setPlayerPermissions(EXEC_B, {
      role: 'finance',
      grants: ['players.page', 'players.update.write', 'players.editor.varsitynotes.write'],
      revokes: [],
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/cannot grant Varsity notes \(write\)/);
  });

  // THE CHAIN. Delegation spreads access sideways from admins and never
  // manufactures it, so every hop can only shrink or hold level.
  //
  // B's permissions.write is seeded directly rather than granted through the
  // action, because the action refuses it — it is outside EDITOR_OFFERABLE
  // until the change that opens the admin-only half. The closure logic it
  // guards is complete and tested here regardless of when that lands.
  it('shrinks along a chain of three distinct sets', async () => {
    // A (admin) → B gets the internal role.
    const first = await setPlayerPermissions(EXEC_A, {
      role: 'internal',
      grants: [],
      revokes: [],
    });
    expect(first.ok).toBe(true);
    rowFor(EXEC_A).permission_grants = ['permissions.page', 'permissions.write'];

    // A → C, so that C starts somewhere B is allowed to reach.
    const second = await setPlayerPermissions(EXEC_B, {
      role: 'internal',
      grants: [],
      revokes: [],
    });
    expect(second.ok).toBe(true);

    // B → C, giving away a strict subset of what B holds.
    store.actor = rowFor(EXEC_A);
    const third = await setPlayerPermissions(EXEC_B, {
      role: 'internal',
      grants: [],
      revokes: ['players.ban.write', 'players.reinstate.write', 'seasons.create.write'],
    });
    expect(third.ok).toBe(true);

    const { accessLevelFor, effectiveCapabilities, permissionsOf } = await import('../permissions');
    const setOf = (id: string) => {
      const row = rowFor(id);
      return effectiveCapabilities(accessLevelFor(row), permissionsOf(row));
    };
    const a = effectiveCapabilities('admin', { kind: 'unrestricted' });
    const b = setOf(EXEC_A);
    const c = setOf(EXEC_B);

    expect(b.size).toBeGreaterThan(c.size);
    expect(a.size).toBeGreaterThan(b.size);
    for (const capability of c) expect(b.has(capability), capability).toBe(true);
    for (const capability of b) expect(a.has(capability), capability).toBe(true);
  });
});

describe('setPlayerPermissions — the shape of what gets stored', () => {
  it('refuses a role on a trainer, whose level has nothing to narrow', async () => {
    const res = await setPlayerPermissions(TRAINER, { role: 'internal', grants: [], revokes: [] });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/Only an executive/);
    expect(rowFor(TRAINER).permission_role).toBeNull();
  });

  // A stored delta with no role is dormant today and WAKES UP the day somebody
  // picks a role. The database CHECK makes that state unreachable; this is what
  // stops an admin ever meeting the constraint.
  it('clears both arrays when the role goes back to unrestricted', async () => {
    await setPlayerPermissions(EXEC_A, {
      role: 'finance',
      grants: ['players.page'],
      revokes: ['fees.expenses.add.write'],
    });
    expect(rowFor(EXEC_A).permission_grants).toEqual(['players.page']);

    await setPlayerPermissions(EXEC_A, {
      role: null,
      grants: ['players.page'],
      revokes: ['fees.expenses.add.write'],
    });
    expect(rowFor(EXEC_A).permission_role).toBeNull();
    expect(rowFor(EXEC_A).permission_grants).toEqual([]);
    expect(rowFor(EXEC_A).permission_revokes).toEqual([]);
  });

  // A redundant grant resolves identically today and survives the role LOSING
  // that capability — so its holder would keep it while every other holder of
  // the role lost it, from a tick nobody made deliberately.
  it('normalises away a grant the role already gives', async () => {
    const res = await setPlayerPermissions(EXEC_A, {
      role: 'finance',
      grants: ['fees.expenses.read', 'players.page'],
      revokes: [],
    });
    expect(res.ok).toBe(true);
    expect(rowFor(EXEC_A).permission_grants).toEqual(['players.page']);
  });

  it('refuses a string the vocabulary does not have', async () => {
    const res = await setPlayerPermissions(EXEC_A, {
      role: 'finance',
      grants: ['players.write'],
      revokes: [],
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/players\.write/);
  });

  it('refuses granting and revoking the same thing', async () => {
    const res = await setPlayerPermissions(EXEC_A, {
      role: 'finance',
      grants: ['players.page'],
      revokes: ['players.page'],
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/grant and revoke the same thing/);
  });

  // THE CEILING THIS CHANGE SHIPS WITH. Grant closure cannot bound an admin,
  // who holds everything by level — so the set an admin may compose is capped
  // at what execs already had, which is what keeps this change provably inside
  // the envelope that shipped before it. Opening these up is its own change.
  it('refuses even an admin the admin-only half of the vocabulary', async () => {
    for (const capability of ['audit.page', 'fees.clubfees.read', 'permissions.write'] as const) {
      const res = await setPlayerPermissions(EXEC_A, {
        role: 'finance',
        grants: [capability],
        revokes: [],
      });
      expect(res.ok, capability).toBe(false);
      expect(res.ok === false && res.error).toMatch(/admin-only/);
    }
  });

  // A role is a NAME whose contents live in code and can move in a later
  // deploy, so the stored triple alone cannot answer "what did this change
  // actually do" six months from now. The resolved sets can.
  it('logs the triple AND the resolved set on both sides', async () => {
    await setPlayerPermissions(EXEC_A, {
      role: 'finance',
      grants: ['players.page'],
      revokes: [],
    });

    expect(audits()).toHaveLength(1);
    const entry = audits()[0]!;
    expect(entry.action_type).toBe('player_permissions_changed');
    expect(entry.actor_id).toBe(ADMIN);
    expect(entry.target_id).toBe(EXEC_A);

    const before = entry.old_value as Record<string, unknown>;
    const after = entry.new_value as Record<string, unknown>;
    expect(before.permission_role).toBeNull();
    // Unrestricted before, so the resolved set is the whole exec baseline —
    // which the triple on its own says nothing about.
    expect((before.effective as string[]).length).toBe(71);
    expect(after.permission_role).toBe('finance');
    expect(after.permission_grants).toEqual(['players.page']);
    expect((after.effective as string[]).sort()).toEqual([
      'fees.expenses.add.write',
      'fees.expenses.read',
      'fees.page',
      'players.page',
    ]);
  });
});
