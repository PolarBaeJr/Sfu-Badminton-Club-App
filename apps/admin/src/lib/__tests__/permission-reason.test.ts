import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Capability } from '../permissions';

// EVERY AUDITED ACTION CARRIES A TYPED REASON, AND THIS WAS THE LAST EXEMPTION.
//
// Sessions, announcements, legal documents, ratings and platform settings all
// refuse to write without one. `player_permissions_changed` did not ask for
// one, so every row of it in the log read `reason: null` — on the one action
// where "who gave them this, and why" is the whole question the log exists to
// answer.
//
// Three things are pinned here, and the harness is grant-closure.test.ts's so
// that the gate and the resolver are the real ones:
//
//   1. THE FLOOR IS THE SERVER'S. The Save button is disabled without a reason;
//      a stale tab and a direct call to the action are not, and neither may
//      write. A refusal leaves the row and the log untouched.
//   2. ONE REASON COVERS A BATCH. The editor saves several people at once and
//      asks once. saveBatch is N calls, each writing its own audit row against
//      its own target, so the text typed once has to reach all of them.
//   3. setConsoleAccess FORWARDS ITS OWN. Giving or taking the console can
//      clear a stored composition, and that clear goes through
//      setPlayerPermissions — the member's permissions row must explain itself
//      with the reason the admin typed for the act that caused it.

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
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

// The level half of setConsoleAccess, stubbed. updatePlayer is a large action
// with its own field guard and its own audit row; what this file is testing is
// what the OTHER half — the composition clear — records, so the stub does the
// column write and nothing else.
vi.mock('../actions/players', async () => {
  const { fromRoleValue } = await import('../console-access');
  return {
    updatePlayer: async (id: string, data: Record<string, unknown>) => {
      const row = store.db.players!.find((p) => p.id === id);
      if (row) {
        const { reason: _reason, ...columns } = data;
        Object.assign(row, columns);
      }
      return { ok: true as const, data: undefined };
    },
    // Re-exported so the mock keeps the module's shape if anything else reaches
    // for it; fromRoleValue itself is imported by the action under test from
    // console-access, not from here.
    __fromRoleValue: fromRoleValue,
  };
});

import { setPlayerPermissions, setConsoleAccess } from '../actions/permissions';
import { saveBatch } from '../permission-batch';
import { REASON_MIN } from '../audit-reason';

const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const EXEC_A = 'eeeeeeee-0000-4000-8000-000000000001';
const EXEC_B = 'eeeeeeee-0000-4000-8000-000000000002';

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

const rowFor = (id: string) => store.db.players!.find((p) => p.id === id)!;
const audits = () => store.db.audit_logs ?? [];
const permissionAudits = () =>
  audits().filter((a) => a.action_type === 'player_permissions_changed');

beforeEach(() => {
  store.db = {
    players: [
      {
        id: ADMIN,
        full_name: 'An admin',
        role: 'admin',
        is_exec: false,
        is_trainer: false,
        permission_role: null,
        permission_grants: [],
        permission_revokes: [],
      },
      exec(EXEC_A),
      exec(EXEC_B),
    ],
    audit_logs: [],
  };
  store.actor = rowFor(ADMIN);
});

describe('setPlayerPermissions — the reason is the boundary, not the button', () => {
  it('refuses an empty reason and writes nothing at all', async () => {
    const res = await setPlayerPermissions(EXEC_A, {
      role: 'finance',
      grants: [],
      revokes: [],
      reason: '',
    });

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(new RegExp(`at least ${REASON_MIN} characters`));
    // The row and the log are both untouched. A refusal that had already
    // written the row would be worse than no check at all.
    expect(rowFor(EXEC_A).permission_role).toBe(null);
    expect(audits()).toHaveLength(0);
  });

  it('refuses a reason that is only whitespace, and one under the floor', async () => {
    for (const reason of ['     ', '  .  ', 'a'.repeat(REASON_MIN - 1)]) {
      const res = await setPlayerPermissions(EXEC_A, {
        role: 'finance',
        grants: [],
        revokes: [],
        reason,
      });
      expect(res.ok, `accepted ${JSON.stringify(reason)}`).toBe(false);
    }
    expect(audits()).toHaveLength(0);
  });

  it('names the act it is refusing', async () => {
    const res = await setPlayerPermissions(EXEC_A, {
      role: 'finance',
      grants: [],
      revokes: [],
      reason: '',
    });
    expect(res.ok === false && res.error).toMatch(/^Changing somebody’s permissions/);
  });

  it('writes the trimmed reason onto the audit row', async () => {
    const res = await setPlayerPermissions(EXEC_A, {
      role: 'finance',
      grants: [],
      revokes: [],
      reason: '   Elected treasurer at the AGM   ',
    });

    expect(res.ok).toBe(true);
    expect(permissionAudits()).toHaveLength(1);
    // Trimmed: the whitespace that got it past the length check is not what
    // the next reader of the log should have to see.
    expect(permissionAudits()[0]!.reason).toBe('Elected treasurer at the AGM');
    expect(permissionAudits()[0]!.target_id).toBe(EXEC_A);
  });

  it('is refused before the actor is even allowed to be wrong about anything else', async () => {
    // A self-edit AND no reason. Either refusal is correct; what matters is
    // that nothing is written, which is what the assertion pins.
    const res = await setPlayerPermissions(ADMIN, {
      role: 'finance',
      grants: [],
      revokes: [],
      reason: '',
    });
    expect(res.ok).toBe(false);
    expect(audits()).toHaveLength(0);
  });
});

describe('one typed reason covers a whole batch', () => {
  it('reaches every person’s own audit row', async () => {
    // The editor's save path in miniature: one reason, N calls, each writing
    // its own row against its own target.
    const why = 'New external team starts this week';
    const result = await saveBatch(
      [{ id: EXEC_A }, { id: EXEC_B }],
      {
        validate: () => null,
        write: async (entry) => {
          const res = await setPlayerPermissions(entry.id, {
            role: 'external',
            grants: [],
            revokes: [],
            reason: why,
          });
          return res.ok ? { ok: true } : { ok: false, error: res.error };
        },
      },
    );

    expect(result.saved).toEqual([EXEC_A, EXEC_B]);
    expect(permissionAudits()).toHaveLength(2);
    expect(permissionAudits().map((a) => a.target_id)).toEqual([EXEC_A, EXEC_B]);
    // BOTH rows, not just the first. A member looking up why their own access
    // moved reads their own row and nobody else's.
    expect(permissionAudits().map((a) => a.reason)).toEqual([why, why]);
  });

  it('leaves no row at all when the shared reason is refused', async () => {
    const result = await saveBatch(
      [{ id: EXEC_A }, { id: EXEC_B }],
      {
        validate: () => null,
        write: async (entry) => {
          const res = await setPlayerPermissions(entry.id, {
            role: 'external',
            grants: [],
            revokes: [],
            reason: 'no',
          });
          return res.ok ? { ok: true } : { ok: false, error: res.error };
        },
      },
    );

    expect(result.saved).toEqual([]);
    expect(result.failed).toHaveLength(2);
    expect(audits()).toHaveLength(0);
  });
});

describe('setConsoleAccess carries its reason into the composition it clears', () => {
  it('records the admin’s own words on the permissions row it writes', async () => {
    // An exec with something stored, losing the console entirely: `clears` is
    // true and the level was live, so the composition is cleared AFTER the
    // level write — through setPlayerPermissions, which now needs a reason.
    Object.assign(rowFor(EXEC_A), {
      permission_role: 'finance',
      permission_grants: [],
      permission_revokes: [],
    });

    const res = await setConsoleAccess(EXEC_A, 'none', 'Stepped down at the AGM');

    expect(res.ok).toBe(true);
    expect(rowFor(EXEC_A).permission_role).toBe(null);
    expect(permissionAudits()).toHaveLength(1);
    expect(permissionAudits()[0]!.reason).toBe('Stepped down at the AGM');
  });

  it('refuses a reason below the shared floor rather than half-applying', async () => {
    // The dialog used to let two characters through. Refused here, before the
    // level write, so the member is not left with a changed level and a
    // composition that could not be cleared.
    Object.assign(rowFor(EXEC_A), { permission_role: 'finance' });

    const res = await setConsoleAccess(EXEC_A, 'none', 'ok');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/^Changing somebody’s console access/);
    expect(rowFor(EXEC_A).is_exec).toBe(true);
    expect(rowFor(EXEC_A).permission_role).toBe('finance');
    expect(audits()).toHaveLength(0);
  });
});
