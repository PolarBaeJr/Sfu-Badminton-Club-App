import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Capability } from '../permissions';

// GIVING SOMEBODY THE CONSOLE IS A CAPABILITY, AND THIS IS THE DOOR IT OPENS IN
// THE HARD FLOOR.
//
// `role`, `is_exec` and `is_trainer` are PLAYER_FIELD_FLOOR: refused to
// everybody below admin by assertPlayerFieldAccess, reachable by no capability,
// and the reason the capability system cannot be used to manufacture a level.
// 00105 opens exactly one path through that floor — setConsoleAccess, under
// `players.consoleaccess.write` — because the club owner asked for it: "also
// make role change a permission."
//
// EVERY REFUSAL THAT MAKES THAT SAFE IS PINNED HERE, and the file is written so
// that removing any one of them turns a test red. Where two refusals cover the
// same case (the explicit admin checks sit in front of a closure test that would
// also catch them), the assertion is on the MESSAGE — otherwise deleting the
// explicit check would leave the suite green and the claim untested.
//
// THE ONE THING THAT MUST NEVER BECOME REACHABLE: minting an admin. If a
// capability could do it, holding that capability would be the same thing as
// being an admin, and the floor would be decorative.

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  actor: {} as Row,
}));

// The harness permission-reason.test.ts and grant-closure.test.ts use, so the
// gate and the resolver under test are the real ones and only the database and
// the session are stubbed.
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
        // A COPY, because PostgREST returns fresh JSON and a shared reference
        // would make every "what it was" snapshot in this file read back as
        // "what it is". That is a harness fidelity point, not a nicety: the
        // audit assertion below is exactly the thing it would silently break.
        const hit = res.data?.[0];
        return { data: hit ? { ...hit } : null, error: res.error };
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

// THE REAL GATE, run against the actor's real row. Nothing here decides who may
// do what — permits() does, from the same resolver the app uses — so a test that
// passes because the gate was stubbed open is not possible.
vi.mock('../actions/_shared', async () => {
  const { accessLevelFor, permissionsOf, permits } = await import('../permissions');
  return {
    requireCapability: async (capability: Capability) => {
      const level = accessLevelFor(store.actor);
      if (!permits(level, permissionsOf(level, store.actor), capability)) {
        throw new Error(`Missing capability: ${capability}`);
      }
      return store.actor;
    },
  };
});

// The ADMIN half of the level write, stubbed for the same reason
// permission-reason.test.ts stubs it: updatePlayer is a large action with its
// own guard and its own audit row, and what is under test here is who reaches
// it. The NON-ADMIN half is deliberately NOT stubbed — writeConsoleLevel is
// inside actions/permissions.ts and writes through the mock client above, so
// its columns and its audit row are the real ones.
vi.mock('../actions/players', async () => {
  const { fromRoleValue } = await import('../console-access');
  return {
    updatePlayer: async (id: string, data: Record<string, unknown>) => {
      const row = store.db.players!.find((p) => p.id === id);
      if (row) {
        const { reason: _reason, ...columns } = data;
        Object.assign(row, columns);
      }
      (store.db.audit_logs ??= []).push({
        action_type: 'player_updated',
        target_id: id,
        new_value: { ...fromRoleValue(data.is_exec === true ? 'executive' : 'none') },
      });
      return { ok: true as const, data: undefined };
    },
  };
});

import { setConsoleAccess, setPlayerPermissions } from '../actions/permissions';
import {
  CAPABILITIES,
  EDITOR_OFFERABLE,
  EXEC_BASELINE,
  ROLE_DEFAULTS,
  TRAINER_BASELINE,
  type Capability as Cap,
} from '../permissions';
import { isAccessChange } from '../officer-access';

const CONSOLE_CAP: Cap = 'players.consoleaccess.write';

const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const ADMIN_2 = 'aaaaaaaa-0000-4000-8000-000000000002';
/** Holds every capability an admin may compose — the widest legitimate holder. */
const FULL_HOLDER = 'ffffffff-0000-4000-8000-000000000001';
/** Holds the trainer baseline plus the console capability, and nothing else. */
const SMALL_HOLDER = 'ffffffff-0000-4000-8000-000000000002';
/** An ordinary unrestricted exec: permissions.write is not in EXEC_BASELINE. */
const PLAIN_EXEC = 'eeeeeeee-0000-4000-8000-000000000001';
/** An unrestricted exec, as a TARGET. */
const TARGET_EXEC = 'eeeeeeee-0000-4000-8000-000000000002';
/** Nobody: no level at all. */
const MEMBER = 'bbbbbbbb-0000-4000-8000-000000000001';

const WHY = 'Elected at the AGM and needs the console';

const person = (id: string, extra: Row = {}): Row => ({
  id,
  full_name: `Person ${id.slice(0, 4)}`,
  email: null,
  role: 'player',
  is_exec: false,
  is_trainer: false,
  permission_role: null,
  permission_grants: [],
  permission_revokes: [],
  permission_baseline_id: null,
  ...extra,
});

const rowFor = (id: string) => store.db.players!.find((p) => p.id === id)!;
const audits = () => store.db.audit_logs ?? [];
const levelAudits = () => audits().filter((a) => a.action_type === 'player_updated');
const permissionAudits = () =>
  audits().filter((a) => a.action_type === 'player_permissions_changed');
const errorOf = (res: { ok: boolean } | { ok: false; error: string }) =>
  'error' in res ? res.error : '';

beforeEach(() => {
  store.db = {
    players: [
      person(ADMIN, { role: 'admin', is_exec: true }),
      person(ADMIN_2, { role: 'admin', is_exec: true }),
      // A composed exec holding the whole ceiling. Every element is in
      // EDITOR_OFFERABLE, so this is a row an admin could actually write through
      // setPlayerPermissions — asserted at the bottom of this file rather than
      // assumed.
      person(FULL_HOLDER, {
        is_exec: true,
        permission_role: 'custom',
        permission_grants: [...EDITOR_OFFERABLE],
      }),
      // A composed TRAINER holding the console capability. The point of the
      // pair: the same capability, two different ceilings, because closure — not
      // a second capability — is what decides which levels they may hand out.
      //
      // IT WAS `is_exec: true` AND HAD TO STOP BEING, which is the level floor
      // showing up in a fixture. The row was trainer-SIZED only because a role
      // replaced the base; now the level's baseline is a floor under every
      // composition, so an exec is never trainer-sized — this row would hold all
      // twelve exec reads and could promote somebody to executive, which is the
      // exact thing the next test says it must not do. A varsity trainer is what
      // the comment always described, and composable trainers (00090) make it a
      // state the club can actually be in.
      person(SMALL_HOLDER, {
        is_trainer: true,
        permission_role: 'custom',
        permission_grants: [...TRAINER_BASELINE, CONSOLE_CAP],
      }),
      person(PLAIN_EXEC, { is_exec: true }),
      person(TARGET_EXEC, { is_exec: true }),
      person(MEMBER),
    ],
    audit_logs: [],
  };
  store.actor = rowFor(ADMIN);
});

// ---------------------------------------------------------------------------
// THE GATE
// ---------------------------------------------------------------------------

describe('the capability is what opens the action', () => {
  it('refuses an ordinary exec, who holds permissions but not this', async () => {
    store.actor = rowFor(PLAIN_EXEC);
    const res = await setConsoleAccess(MEMBER, 'trainer', WHY);
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toContain(CONSOLE_CAP);
    expect(rowFor(MEMBER).is_trainer).toBe(false);
    expect(audits()).toHaveLength(0);
  });

  it('lets an admin through by LEVEL, as it always did', async () => {
    const res = await setConsoleAccess(MEMBER, 'trainer', WHY);
    expect(res.ok).toBe(true);
    expect(rowFor(MEMBER).is_trainer).toBe(true);
  });

  it('lets a holder through who is not an admin', async () => {
    store.actor = rowFor(FULL_HOLDER);
    const res = await setConsoleAccess(MEMBER, 'trainer', WHY);
    expect(res.ok).toBe(true);
    expect(rowFor(MEMBER).is_trainer).toBe(true);
    expect(rowFor(MEMBER).is_exec).toBe(false);
    expect(rowFor(MEMBER).role).toBe('player');
  });

  // THE WHOLE FEATURE, END TO END: an admin can actually put this capability on
  // somebody's row. It is the assertion that makes every test above about a real
  // state rather than one hand-written into the fixture — the reason
  // EDITOR_OFFERABLE membership was not optional.
  it('can be granted to a non-admin through the ordinary permissions editor', async () => {
    const res = await setPlayerPermissions(PLAIN_EXEC, {
      role: 'custom',
      // THE WHOLE TRAINER BASELINE, not just the console capability. Promoting
      // somebody to varsity trainer hands them all three of TRAINER_BASELINE, and
      // closure refuses an actor who does not hold every one of them — which is
      // the graduation this feature relies on, met here in passing.
      grants: [...TRAINER_BASELINE, CONSOLE_CAP],
      revokes: [],
      reason: WHY,
    });
    expect(res.ok).toBe(true);
    expect(rowFor(PLAIN_EXEC).permission_grants).toContain(CONSOLE_CAP);

    // ...and it works the moment it lands.
    store.actor = rowFor(PLAIN_EXEC);
    const used = await setConsoleAccess(MEMBER, 'trainer', WHY);
    expect(used.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE LINE THAT DOES NOT MOVE — no capability mints an admin
// ---------------------------------------------------------------------------

describe('the admin level is not grantable by any capability', () => {
  // MESSAGE-ASSERTED ON PURPOSE. Closure would refuse this too, because an admin
  // resolves to all 119 capabilities and no holder has them — so a test that
  // only checked `ok === false` would pass with the explicit check deleted. The
  // explicit check is the sentence a treasurer can act on; closure is the floor
  // underneath it. Both are wanted, and only this assertion tells them apart.
  it('refuses the widest possible holder, in its own words', async () => {
    store.actor = rowFor(FULL_HOLDER);
    const res = await setConsoleAccess(MEMBER, 'admin', WHY);
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toBe('Only an admin can make somebody an admin.');
    expect(rowFor(MEMBER).role).toBe('player');
    expect(audits()).toHaveLength(0);
  });

  it('refuses a holder even when the target already has a level', async () => {
    store.actor = rowFor(FULL_HOLDER);
    const res = await setConsoleAccess(TARGET_EXEC, 'admin', WHY);
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toBe('Only an admin can make somebody an admin.');
    expect(rowFor(TARGET_EXEC).role).toBe('player');
  });

  it('still lets an admin make an admin', async () => {
    const res = await setConsoleAccess(MEMBER, 'admin', WHY);
    expect(res.ok).toBe(true);
    expect(rowFor(MEMBER).role).toBe('admin');
  });

  // The vocabulary itself, as a second line of defence: no capability string
  // names a level, so there is nothing to grant that would BE the admin level
  // even if a gate were written carelessly.
  it('has no capability naming a level at all', () => {
    for (const capability of CAPABILITIES) {
      expect(capability.includes('admin'), capability).toBe(false);
      expect(capability.includes('exec'), capability).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// REVOCATION — taking it away is the same act
// ---------------------------------------------------------------------------

describe('taking console access away', () => {
  // MESSAGE-ASSERTED for the same reason as the admin-minting pair: closure
  // catches this too, because an admin's `before` is every capability there is.
  it('refuses a holder trying to strip an admin', async () => {
    store.actor = rowFor(FULL_HOLDER);
    const res = await setConsoleAccess(ADMIN_2, 'none', WHY);
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toBe("Only an admin can change an admin's console access.");
    expect(rowFor(ADMIN_2).role).toBe('admin');
    expect(rowFor(ADMIN_2).is_exec).toBe(true);
  });

  it('refuses a holder trying to demote an admin to executive', async () => {
    store.actor = rowFor(FULL_HOLDER);
    const res = await setConsoleAccess(ADMIN_2, 'executive', WHY);
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toBe("Only an admin can change an admin's console access.");
    expect(rowFor(ADMIN_2).role).toBe('admin');
  });

  it('lets a holder take the console from somebody inside their own set', async () => {
    store.actor = rowFor(FULL_HOLDER);
    const res = await setConsoleAccess(TARGET_EXEC, 'none', WHY);
    expect(res.ok).toBe(true);
    expect(rowFor(TARGET_EXEC).is_exec).toBe(false);
    expect(rowFor(TARGET_EXEC).is_trainer).toBe(false);
  });

  // THE CLEAR PATH, UNDER THE NEW GATE. A holder does not hold
  // `permissions.write` — nobody below admin can — so this is the case that
  // proves splitting applyPlayerPermissions out of the gated action actually
  // works, rather than half-applying: the level goes, the composition goes with
  // it, and both are audited.
  it('clears a stored composition it can no longer reach, without permissions.write', async () => {
    Object.assign(rowFor(TARGET_EXEC), {
      permission_role: 'custom',
      permission_grants: ['fees.page', 'fees.expenses.read'],
      permission_revokes: [],
    });
    store.actor = rowFor(FULL_HOLDER);

    const res = await setConsoleAccess(TARGET_EXEC, 'none', WHY);

    expect(res.ok).toBe(true);
    expect(rowFor(TARGET_EXEC).is_exec).toBe(false);
    expect(rowFor(TARGET_EXEC).permission_role).toBe(null);
    expect(rowFor(TARGET_EXEC).permission_grants).toEqual([]);
    expect(permissionAudits()).toHaveLength(1);
    expect(permissionAudits()[0]!.reason).toBe(WHY);
  });
});

// ---------------------------------------------------------------------------
// SELF-EDIT — the one move that would let the capability promote its holder
// ---------------------------------------------------------------------------

describe('nobody changes their own console access', () => {
  it('refuses self-PROMOTION by a holder', async () => {
    store.actor = rowFor(SMALL_HOLDER);
    const res = await setConsoleAccess(SMALL_HOLDER, 'executive', WHY);
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toBe(
      'You cannot change your own console access. Ask another admin to do it.',
    );
    expect(audits()).toHaveLength(0);
  });

  it('refuses self-DEMOTION by an admin, as it always did', async () => {
    const res = await setConsoleAccess(ADMIN, 'none', WHY);
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toBe(
      'You cannot change your own console access. Ask another admin to do it.',
    );
    expect(rowFor(ADMIN).role).toBe('admin');
  });
});

// ---------------------------------------------------------------------------
// GRANT CLOSURE — what makes one capability enough for two levels
// ---------------------------------------------------------------------------

describe('closure decides which levels a holder may hand out', () => {
  it('lets a trainer-sized holder make a varsity trainer', async () => {
    store.actor = rowFor(SMALL_HOLDER);
    const res = await setConsoleAccess(MEMBER, 'trainer', WHY);
    expect(res.ok).toBe(true);
    expect(rowFor(MEMBER).is_trainer).toBe(true);
  });

  // THE GRADUATION, AND IT IS WHY THIS IS ONE CAPABILITY RATHER THAN TWO.
  // Promoting to executive hands over EXEC_BASELINE — twelve reads, down from
  // the historic 73, so the bar is LOWER than it was. This holder still does not
  // clear it: their four are the trainer floor plus the console capability, and
  // the exec floor contains eight section pages they have never held. Nothing
  // about the capability says "trainer only" — the baselines do.
  it('refuses the same holder making an executive', async () => {
    store.actor = rowFor(SMALL_HOLDER);
    const res = await setConsoleAccess(MEMBER, 'executive', WHY);
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toMatch(/^That would give them /);
    expect(rowFor(MEMBER).is_exec).toBe(false);
    expect(audits()).toHaveLength(0);
  });

  it('lets a holder with the whole ceiling make an executive', async () => {
    store.actor = rowFor(FULL_HOLDER);
    const res = await setConsoleAccess(MEMBER, 'executive', WHY);
    expect(res.ok).toBe(true);
    expect(rowFor(MEMBER).is_exec).toBe(true);
  });

  // THE OTHER DIRECTION, and it is the denial-of-access half: a narrowly scoped
  // holder must not be able to take the console from somebody who was elected to
  // more of it than they hold.
  it('refuses a holder reaching into somebody who holds more than they do', async () => {
    store.actor = rowFor(SMALL_HOLDER);
    const res = await setConsoleAccess(TARGET_EXEC, 'none', WHY);
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toMatch(/^You cannot change this person's console access/);
    expect(rowFor(TARGET_EXEC).is_exec).toBe(true);
  });

  // EXECUTIVE TO TRAINER KEEPS THE COMPOSITION, so `after` has to be computed
  // through it rather than from the new level's baseline. A holder whose set does
  // not cover what the composition leaves them with is refused; one whose set
  // does is not. Getting this branch wrong would make the check wrong in exactly
  // the case where a composition is what the person actually holds.
  it('measures a live-to-live move against the composition, not the baseline', async () => {
    Object.assign(rowFor(TARGET_EXEC), {
      permission_role: 'custom',
      permission_grants: ['fees.page', 'fees.expenses.read'],
      permission_revokes: [],
    });
    store.actor = rowFor(SMALL_HOLDER);

    // The target is an EXEC, so before the move they hold the exec floor plus
    // their composition — and this holder, a trainer, holds neither. The BEFORE
    // test refuses them, and would do so on the floor alone: closure got easier
    // WITHIN a level (everybody shares a floor, so it cancels) and no easier
    // across one, which is the direction that matters.
    //
    const refused = await setConsoleAccess(TARGET_EXEC, 'trainer', WHY);
    expect(refused.ok).toBe(false);
    expect(errorOf(refused)).toMatch(/^You cannot change this person's console access/);

    // ...and the composition SURVIVES the move when somebody who does hold them
    // makes it, which is the behaviour that makes computing `after` through it
    // necessary in the first place.
    store.actor = rowFor(FULL_HOLDER);
    const allowed = await setConsoleAccess(TARGET_EXEC, 'trainer', WHY);
    expect(allowed.ok).toBe(true);
    expect(rowFor(TARGET_EXEC).is_trainer).toBe(true);
    expect(rowFor(TARGET_EXEC).is_exec).toBe(false);
    expect(rowFor(TARGET_EXEC).permission_role).toBe('custom');
  });
});

// ---------------------------------------------------------------------------
// THE AUDIT ROW THE SECOND WRITER LEAVES
// ---------------------------------------------------------------------------
// The non-admin path does not go through updatePlayer — the hard floor stops it
// — so it writes its own row. isAccessChange() picks console-access changes out
// of the log by looking for `player_updated` rows naming one of the three level
// columns, so a different shape here would make a holder's changes vanish from
// the access-changes view. Silently, which is the whole reason this is asserted.

describe('a holder’s change is visible in the access log', () => {
  it('writes a player_updated row naming all three level columns', async () => {
    store.actor = rowFor(FULL_HOLDER);
    const res = await setConsoleAccess(MEMBER, 'executive', WHY);
    expect(res.ok).toBe(true);

    expect(levelAudits()).toHaveLength(1);
    const row = levelAudits()[0]!;
    expect(row.actor_id).toBe(FULL_HOLDER);
    expect(row.target_id).toBe(MEMBER);
    expect(row.reason).toBe(WHY);
    expect(row.new_value).toEqual({ role: 'player', is_exec: true, is_trainer: false });
    expect(isAccessChange(row as { action_type: string; new_value?: unknown })).toBe(true);
  });

  it('records what it was, so the row answers what changed', async () => {
    store.actor = rowFor(FULL_HOLDER);
    await setConsoleAccess(TARGET_EXEC, 'trainer', WHY);
    const old = levelAudits()[0]!.old_value as { player: Row };
    expect(old.player.is_exec).toBe(true);
    expect(old.player.is_trainer).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WHERE THE CAPABILITY SITS
// ---------------------------------------------------------------------------

describe('players.consoleaccess.write is reachable only by being given it', () => {
  it('is in neither baseline', () => {
    expect((EXEC_BASELINE as readonly Cap[]).includes(CONSOLE_CAP)).toBe(false);
    expect((TRAINER_BASELINE as readonly Cap[]).includes(CONSOLE_CAP)).toBe(false);
  });

  it('is in none of the shipped roles', () => {
    for (const [role, defaults] of Object.entries(ROLE_DEFAULTS)) {
      expect((defaults as readonly Cap[]).includes(CONSOLE_CAP), role).toBe(false);
    }
  });

  it('IS offerable, or nobody could ever be given it', () => {
    expect((EDITOR_OFFERABLE as readonly Cap[]).includes(CONSOLE_CAP)).toBe(true);
  });
});
