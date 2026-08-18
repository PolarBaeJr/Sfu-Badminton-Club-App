import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// banPlayer had none of the guards approvePlayer got
// ---------------------------------------------------------------------------
// It read nothing, wrote four columns blind, and filed an audit row carrying
// new_value alone. Three things follow from that, and this suite pins each:
//
//   1. RE-BANNING AN ALREADY-BANNED MEMBER RE-STAMPS banned_at. That column is
//      not decoration: club_fees.ban_started_at snapshots it at reinstatement
//      and club_fees_reinstatement_ban_key UNIQUE (player_id, ban_started_at)
//      (00065, carried into 00094) is the only thing making "one reinstatement
//      fee per ban" true. reinstatePlayer's own comment says two concurrent
//      unbans "snapshot the same banned_at and the index does" the separating —
//      slide a re-ban between the two reads and they no longer do. The certain
//      half of the damage needs no race at all: the original banned_at,
//      banned_by and ban_reason were overwritten with nothing anywhere holding
//      the old values.
//
//   2. THE LAST ADMIN COULD BE BANNED. 00050 guards the three ways to end up
//      with a console nobody can open; is_banned was not one, because in
//      00050's day a banned admin still passed is_admin(). 00140 ended that, so
//      a ban is now a fourth way — and players.ban.write is EXEC-level.
//
//   3. THE REFUSALS HAD TO BECOME RETURN VALUES. Next replaces anything thrown
//      out of a server action in production with a generic message, and
//      handleBan awaited a bare promise and toasted "Player banned" whatever
//      came back. Every assertion below reads `res.ok`, which is the shape the
//      dialog now checks.
//
// The door count is asserted THROUGH THE RPC, not through a hand-rolled join:
// banPlayer calls admins_with_passkeys(), the same function
// guard_last_admin_role calls, so what is mocked here is the same boundary the
// database enforces at. 00145 adds the is_banned clause that count is missing
// and the matching arm on the trigger; neither is testable from here, and both
// are noted in the migration rather than faked.

type Row = Record<string, unknown>;
type Op = 'select' | 'update' | 'insert';

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  rpcCalls: [] as Array<{ name: string; args: Row }>,
  // What admins_with_passkeys() returns, and whether it fails.
  doors: 2 as number | null,
  doorsError: null as { message: string } | null,
  // Fires at the start of every UPDATE, before rows are matched. The only way
  // to model "somebody else wrote the row between our read and our write",
  // which is exactly what the .eq('is_banned', false) re-check is for.
  onUpdate: null as null | ((table: string) => void),
  actor: { id: 'exec-1', role: 'player', is_exec: true },
}));

const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    let op: Op = 'select';
    let payload: Row = {};

    const matching = () => (store.db[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));

    const run = (): { data: Row[] | null; error: { message: string } | null } => {
      if (op === 'insert') {
        (store.db[table] ??= []).push({ ...payload });
        return { data: [{ ...payload }], error: null };
      }
      if (op === 'update') {
        store.onUpdate?.(table);
        const hit = matching();
        for (const r of hit) Object.assign(r, payload);
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      return { data: matching().map((r) => ({ ...r })), error: null };
    };

    const api = {
      select() { return api; },
      insert(p: Row) { op = 'insert'; payload = p; return api; },
      update(p: Row) { op = 'update'; payload = p; return api; },
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      async single() { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      async maybeSingle() { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(run()).then(resolve); },
    };
    return api;
  }
  return {
    from: (table: string) => query(table),
    rpc: async (name: string, args: Row) => {
      store.rpcCalls.push({ name, args });
      return { data: store.doors, error: store.doorsError };
    },
  };
});

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('../supabase-server', () => ({ createAdminClient: makeClient }));
// Which capability this action names is settled elsewhere (officer-access,
// capability-equivalence). Everything under test here happens after the gate.
vi.mock('../actions/_shared', () => ({
  requireCapability: async () => store.actor,
}));

import { banPlayer } from '../actions/reinstatement';

const PLAYER = '22222222-2222-4222-8222-222222222222';
const T1 = '2026-07-01T00:00:00.000Z';

const player = () => store.db.players!.find((p) => p.id === PLAYER)!;
const bans = () => (store.db.audit_logs ?? []).filter((r) => r.action_type === 'player_banned');
const doorChecks = () => store.rpcCalls.filter((c) => c.name === 'admins_with_passkeys');

function seed(overrides: Row = {}) {
  store.db = {
    players: [{
      id: PLAYER,
      role: 'player',
      is_banned: false,
      banned_at: null,
      banned_by: null,
      ban_reason: null,
      ...overrides,
    }],
    audit_logs: [],
  };
}

beforeEach(() => {
  store.rpcCalls = [];
  store.doors = 2;
  store.doorsError = null;
  store.onUpdate = null;
  store.actor = { id: 'exec-1', role: 'player', is_exec: true };
  seed();
});

describe('banPlayer — the ordinary ban', () => {
  it('writes all four columns and records what it replaced', async () => {
    const res = await banPlayer({ player_id: PLAYER, reason: 'Repeated no-shows' });

    expect(res.ok).toBe(true);
    expect(player().is_banned).toBe(true);
    expect(player().banned_by).toBe('exec-1');
    expect(player().ban_reason).toBe('Repeated no-shows');
    expect(player().banned_at).toEqual(expect.any(String));

    // old_value is the half that did not exist. Empty here, and the whole point
    // on any row that had a ban before.
    expect(bans()).toHaveLength(1);
    expect(bans()[0]!.old_value).toMatchObject({ is_banned: false, banned_at: null, ban_reason: null });
  });

  it('does not count the remaining admin doors when the target is not an admin', async () => {
    await banPlayer({ player_id: PLAYER, reason: 'Repeated no-shows' });
    // The guard is scoped to role = 'admin', mirroring guard_last_admin_role.
    // An unscoped check would refuse every ban in a club whose admins have no
    // passkeys yet.
    expect(doorChecks()).toHaveLength(0);
  });
});

describe('banPlayer — a ban that was never lifted is not re-stamped', () => {
  // THE DISCRIMINATOR FOR GUARD 1. Delete the `if (target.is_banned)` block and
  // banned_at moves to now(), banned_by becomes the second exec, and the
  // original reason is gone — which is exactly the state that lets two
  // concurrent reinstatements snapshot two different ban episodes and charge a
  // member twice for one ban.
  it('refuses, and leaves the original ban exactly as it was', async () => {
    seed({ is_banned: true, banned_at: T1, banned_by: 'admin-1', ban_reason: 'Repeated no-shows' });

    const res = await banPlayer({ player_id: PLAYER, reason: 'Rude at the door' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/already banned/i);
    expect(player().banned_at).toBe(T1);
    expect(player().banned_by).toBe('admin-1');
    expect(player().ban_reason).toBe('Repeated no-shows');
    expect(bans()).toHaveLength(0);
  });

  // THE DISCRIMINATOR FOR THE WHERE-CLAUSE HALF, which the precondition above
  // cannot reach: here the row is clean when banPlayer reads it and banned by
  // the time it writes, which is the two-execs-one-report race. Drop
  // `.eq('is_banned', false)` from the update and the second ban lands on top of
  // the first, re-stamping banned_at — the same damage, arrived at without
  // anybody re-banning on purpose.
  it('refuses when somebody else bans them between the read and the write', async () => {
    store.onUpdate = (table) => {
      if (table !== 'players') return;
      store.onUpdate = null;
      Object.assign(player(), { is_banned: true, banned_at: T1, banned_by: 'admin-1', ban_reason: 'Got there first' });
    };

    const res = await banPlayer({ player_id: PLAYER, reason: 'Repeated no-shows' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/while you were banning them/i);
    expect(player().banned_at).toBe(T1);
    expect(player().ban_reason).toBe('Got there first');
    expect(bans()).toHaveLength(0);
  });
});

describe('banPlayer — the console has to stay reachable', () => {
  // THE DISCRIMINATOR FOR GUARD 2. Delete the role === 'admin' block and this
  // ban lands: since 00140 the member fails is_admin() on 45 RLS policies and is
  // refused by requireAdminPlayer, so the club is locked out of its own console
  // with a manual UPDATE against production as the only way back.
  it('refuses to ban the last admin holding a passkey', async () => {
    seed({ role: 'admin' });
    store.doors = 0;

    const res = await banPlayer({ player_id: PLAYER, reason: 'Under investigation' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/only admin with a passkey/i);
    expect(player().is_banned).toBe(false);
    expect(bans()).toHaveLength(0);
    // Counted through the same function the trigger calls, excluding the player
    // about to lose their access — not a second transcription of 00051's join.
    expect(doorChecks()).toEqual([
      { name: 'admins_with_passkeys', args: { p_excluding_player: PLAYER } },
    ]);
  });

  it('bans an admin when another one can still get in', async () => {
    seed({ role: 'admin' });
    store.doors = 1;

    const res = await banPlayer({ player_id: PLAYER, reason: 'Under investigation' });

    expect(res.ok).toBe(true);
    expect(player().is_banned).toBe(true);
  });

  // Fails closed. An unreadable count is not permission to ban the last admin,
  // and a null from a function declared RETURNS INTEGER means the call is wrong
  // rather than that there are doors.
  it('refuses rather than guessing when the count cannot be read', async () => {
    seed({ role: 'admin' });
    store.doors = null;

    const res = await banPlayer({ player_id: PLAYER, reason: 'Under investigation' });

    expect(res.ok).toBe(false);
    expect(player().is_banned).toBe(false);
  });
});

describe('banPlayer — a member who is not there', () => {
  it('says so instead of writing nothing and reporting success', async () => {
    store.db = { players: [], audit_logs: [] };

    const res = await banPlayer({ player_id: PLAYER, reason: 'Repeated no-shows' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no longer exists/i);
    expect(bans()).toHaveLength(0);
  });
});
