import { describe, it, expect, beforeEach, vi } from 'vitest';

// This suite pins the security boundary the club owner drew: "leave elevation
// of privilege to exec/admin to admins". Execs manage the roster; only admins
// grant privilege or touch money.
//
// It exercises the REAL server action rather than the guard helper, because the
// guard only matters if updatePlayer actually calls it — and because the
// database cannot be the backstop here: guard_player_privileged_columns returns
// early when auth.uid() IS NULL, and these actions all run on the service-role
// client.

const state = vi.hoisted(() => ({
  // Who is calling. getExecOrAdmin has already established they are an exec or
  // an admin; the field guard's only question is which.
  actor: { id: 'actor-1', role: 'player' } as { id: string; role: string },
  // Every table write the action performed, so a rejected request can be shown
  // to have written nothing at all.
  updates: [] as { table: string; values: Record<string, unknown> }[],
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

vi.mock('../audit', () => ({ logAdminAudit: async () => {} }));

vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));

vi.mock('../actions/_shared', () => ({
  getAdminPlayer: async () => {
    if (state.actor.role !== 'admin') throw new Error('Admin access required');
    return state.actor;
  },
  getExecOrAdmin: async () => state.actor,
}));

vi.mock('../supabase-server', () => {
  const builder = (table: string) => {
    const self: Record<string, unknown> = {
      select: () => self,
      eq: () => self,
      update: (values: Record<string, unknown>) => {
        state.updates.push({ table, values });
        return self;
      },
      single: async () => ({ data: { id: 'player-9', status: 'recreational' } }),
      maybeSingle: async () => ({ data: null }),
      then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null }),
    };
    return self;
  };
  return {
    createAdminClient: () => ({ from: (table: string) => builder(table) }),
  };
});

// Imported after the mocks are registered.
import { updatePlayer } from '../actions/players';

beforeEach(() => {
  state.actor = { id: 'actor-1', role: 'player' };
  state.updates = [];
});

const asExec = () => { state.actor = { id: 'exec-1', role: 'player' }; };
const asAdmin = () => { state.actor = { id: 'admin-1', role: 'admin' }; };

describe('updatePlayer field-level access', () => {
  it('lets an exec change status (ban-by-status is roster management)', async () => {
    asExec();
    const res = await updatePlayer('player-9', { status: 'suspended', reason: 'Repeated no-shows' });
    expect(res.ok).toBe(true);
    expect(state.updates).toContainEqual({ table: 'players', values: { status: 'suspended' } });
  });

  it('lets an exec rewrite a rating', async () => {
    asExec();
    const res = await updatePlayer('player-9', { singles_elo: 1200, reason: 'Seeding correction' });
    expect(res.ok).toBe(true);
    expect(state.updates).toContainEqual({ table: 'ratings', values: { singles_elo: 1200 } });
  });

  it('rejects an exec who supplies role — this is the escalation path', async () => {
    asExec();
    const res = await updatePlayer('player-9', { role: 'admin', reason: 'Promoting myself' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('Admin access required');
    // Rejected outright, not silently stripped: nothing was written.
    expect(state.updates).toEqual([]);
  });

  it('rejects an exec who supplies is_exec', async () => {
    asExec();
    const res = await updatePlayer('player-9', { is_exec: true, reason: 'Adding a friend to the exec team' });
    expect(res.ok).toBe(false);
    expect(state.updates).toEqual([]);
  });

  it('rejects an exec who supplies fee_exempt (money is admin-only)', async () => {
    asExec();
    const res = await updatePlayer('player-9', { fee_exempt: true, reason: 'Waiving a fee' });
    expect(res.ok).toBe(false);
    expect(state.updates).toEqual([]);
  });

  it('rejects the whole request even when the admin-only field rides along with an allowed one', async () => {
    asExec();
    const res = await updatePlayer('player-9', { status: 'competitive', is_exec: true, reason: 'Mixed payload' });
    expect(res.ok).toBe(false);
    // The permitted half must not land either — a partial save would look like
    // a success that half-worked.
    expect(state.updates).toEqual([]);
  });

  it('lets an admin change role', async () => {
    asAdmin();
    const res = await updatePlayer('player-9', { role: 'admin', reason: 'Promotion' });
    expect(res.ok).toBe(true);
    expect(state.updates).toContainEqual({ table: 'players', values: { role: 'admin' } });
  });

  it('lets an admin change is_exec and fee_exempt', async () => {
    asAdmin();
    const res = await updatePlayer('player-9', { is_exec: true, fee_exempt: true, reason: 'New exec' });
    expect(res.ok).toBe(true);
    expect(state.updates).toContainEqual({ table: 'players', values: { is_exec: true, fee_exempt: true } });
  });

  it('does not reject an exec for an untouched blank exec_title', async () => {
    // blankAsUndefined turns '' into undefined during parsing, which is why the
    // guard inspects the PARSED payload. Guarding the raw input would fail an
    // exec for a form field they never filled in.
    asExec();
    const res = await updatePlayer('player-9', {
      status: 'competitive',
      exec_title: '',
      reason: 'Status change from a form that always posts every field',
    } as never);
    expect(res.ok).toBe(true);
  });
});

describe('createPlayer field-level access', () => {
  it('lets an exec add a plain member but not an exec', async () => {
    const { createPlayer } = await import('../actions/players');
    asExec();
    const denied = await createPlayer({
      first_name: 'Ada', email: 'ada@sfu.ca', status: 'recreational', role: 'player', is_exec: true,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toContain('Admin access required');
  });
});
