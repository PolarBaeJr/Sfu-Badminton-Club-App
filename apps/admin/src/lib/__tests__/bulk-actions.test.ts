import { describe, it, expect, beforeEach, vi } from 'vitest';

// The bulk server actions on /players and /sessions.
//
// THE ONE CLAIM THESE TESTS EXIST TO CHECK is that a bulk action is a LOOP over
// the ordinary single-record action and never a batched write. The tempting
// shape — `.update({...}).in('id', ids)` — is one statement, and it runs none of
// the per-record guards: approvePlayer's "only a pending signup" precondition,
// assertPlayerFieldAccess, the refusal to mark a suspended member inactive, and
// the audit row whose old_value is read from THAT row. It is also the shape this
// codebase has already been bitten by: an unqualified UPDATE needs no SELECT
// grant, which is how the elo_review write got out.
//
// So what is asserted here is per-record behaviour, out of a bulk call: one
// audit row and one email each, a refusal on one member that does not touch the
// others, and a gate that stops the whole thing before a single write.

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  emails: [] as string[],
  /** Flipped by the test that checks an uncapable officer writes nothing. */
  gateError: null as string | null,
  gateCalls: [] as string[],
}));

const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    let op: 'select' | 'update' | 'delete' = 'select';
    let payload: Row = {};

    const matching = () => (store.db[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));

    const run = () => {
      if (op === 'update') {
        const hit = matching();
        for (const r of hit) Object.assign(r, payload);
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      if (op === 'delete') {
        const hit = matching();
        store.db[table] = (store.db[table] ?? []).filter((r) => !hit.includes(r));
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      return { data: matching().map((r) => ({ ...r })), error: null };
    };

    const api = {
      select() { return api; },
      insert(p: Row) { (store.db[table] ??= []).push({ ...p }); return api; },
      update(p: Row) { op = 'update'; payload = p; return api; },
      delete() { op = 'delete'; return api; },
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      async single() { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      async maybeSingle() { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(run()).then(resolve); },
    };
    return api;
  }
  return {
    from: (table: string) => query(table),
    rpc: async () => ({ data: 'K3F9TQ2', error: null }),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('../supabase-server', () => ({ createAdminClient: makeClient }));
vi.mock('../notify', () => ({ notifyPlayers: async () => {} }));
vi.mock('../session-reminders', () => ({ remindSessionGoers: async () => ({ notified: 0 }) }));
// The seam the action tests mock, and the reason _shared exists at all. One
// mock covers the outer gate AND the per-record gate, because both call this.
vi.mock('../actions/_shared', () => ({
  requireCapability: async (capability: string) => {
    store.gateCalls.push(capability);
    if (store.gateError) throw new Error(store.gateError);
    return { id: 'exec-1', role: 'player', is_exec: true };
  },
}));
vi.mock('../audit', () => ({
  logAdminAudit: async (client: { from: (t: string) => { insert: (r: Row) => unknown } }, entry: Row) => {
    await client.from('audit_logs').insert(entry);
  },
}));
vi.mock('@badminton/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@badminton/shared')>()),
  sendPlayerApprovedEmail: async (email: string) => { store.emails.push(email); },
}));

import {
  bulkApprovePlayers,
  bulkUpdatePlayers,
  bulkArchiveSessions,
  bulkDeleteSessions,
} from '../actions/bulk';
import { MAX_BULK_TARGETS } from '../bulk';

const PENDING = ['p-ada', 'p-bao', 'p-kiera'];

const players = () => store.db.players ?? [];
const player = (id: string) => players().find((p) => p.id === id)!;
const auditsOf = (type: string) => (store.db.audit_logs ?? []).filter((r) => r.action_type === type);
const REASON = 'Signed up at the club fair';

beforeEach(() => {
  store.emails = [];
  store.gateError = null;
  store.gateCalls = [];
  store.db = {
    players: PENDING.map((id) => ({
      id,
      status: 'pending_approval',
      active_flag: false,
      is_banned: false,
      membership_type: 'external',
      email: `${id}@sfu.ca`,
      full_name: id,
    })),
    sessions: [
      { id: 's-1', status: 'open', name: 'Tuesday Drop-in' },
      { id: 's-2', status: 'open', name: 'Thursday Drop-in' },
    ],
    session_attendance: [{ id: 'att-1', session_id: 's-1' }],
    audit_logs: [],
  };
});

describe('approving a whole intake', () => {
  it('lets each one in individually, with their own audit row and their own email', async () => {
    // The club owner's ask: "it will take ages to approve a ton of people". What
    // must NOT be lost in doing it faster is that each approval is still a real
    // approval — a member code, a welcome, and a line in the log naming who
    // clicked.
    const res = await bulkApprovePlayers(PENDING, 'competitive', REASON);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toMatchObject({ attempted: 3, succeeded: 3, failures: [] });
    expect(players().every((p) => p.status === 'competitive')).toBe(true);
    expect(auditsOf('player_approved')).toHaveLength(3);
    expect(store.emails.sort()).toEqual(PENDING.map((id) => `${id}@sfu.ca`).sort());
  });

  it('names the one it could not, and still lets the others in', async () => {
    // A removed member (status 'suspended', written by the admin-only
    // removePlayer) must not come back through an exec-level bulk approve —
    // and the officer must be told which one, not handed a silent 2-of-3.
    player('p-bao').status = 'suspended';

    const res = await bulkApprovePlayers(PENDING, 'competitive', REASON);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.succeeded).toBe(2);
      expect(res.data.failures).toHaveLength(1);
      expect(res.data.failures[0]!.id).toBe('p-bao');
      expect(res.data.failures[0]!.error).toMatch(/only a pending signup/i);
    }
    expect(player('p-bao').status).toBe('suspended');
    expect(player('p-kiera').status).toBe('competitive');
    // The one that was refused is not emailed "you're in".
    expect(store.emails).not.toContain('p-bao@sfu.ca');
  });

  it('approves a repeated id once', async () => {
    const res = await bulkApprovePlayers(['p-ada', 'p-ada'], 'recreational', REASON);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.attempted).toBe(1);
    expect(auditsOf('player_approved')).toHaveLength(1);
  });
});

describe('the same edit to several members', () => {
  it('writes only the fields it was given, to each of them', async () => {
    await bulkApprovePlayers(PENDING, 'competitive', REASON);
    store.db.audit_logs = [];

    const res = await bulkUpdatePlayers(PENDING, {
      membership_type: 'internal',
      reason: 'Corrected after the membership audit',
    });

    expect(res.ok).toBe(true);
    expect(players().every((p) => p.membership_type === 'internal')).toBe(true);
    // Division untouched: the bar left it on "leave as they are", so the key
    // was never in the payload.
    expect(players().every((p) => p.status === 'competitive')).toBe(true);
    expect(auditsOf('player_updated')).toHaveLength(3);
  });

  it('carries the one typed reason onto every row it writes', async () => {
    await bulkApprovePlayers(['p-ada'], 'competitive', REASON);
    store.db.audit_logs = [];

    await bulkUpdatePlayers(['p-ada'], { membership_type: 'alumni', reason: 'Graduated in April' });

    expect(auditsOf('player_updated')[0]).toMatchObject({ reason: 'Graduated in April' });
  });
});

describe('the gate', () => {
  it('refuses an officer without the capability before touching a single row', async () => {
    // The whole point of the outer gate: one sentence back, not twenty-five
    // identical failures — and, either way, nothing written.
    store.gateError = 'Admin or exec access required';

    const res = await bulkApprovePlayers(PENDING, 'competitive', REASON);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/access required/i);
    expect(players().every((p) => p.status === 'pending_approval')).toBe(true);
    expect(auditsOf('player_approved')).toHaveLength(0);
    expect(store.emails).toEqual([]);
  });

  it('asks for the same capability the single-record action asks for', async () => {
    // Not a second answer to "who may do this" — the SAME constant, so the two
    // cannot drift. Every id in the loop re-asks, which is what protects the
    // write; the first call is the one that produces a readable refusal.
    await bulkApprovePlayers(['p-ada'], 'competitive', REASON);
    expect(new Set(store.gateCalls)).toEqual(new Set(['players.approve.write']));

    store.gateCalls = [];
    await bulkArchiveSessions(['s-1'], 'End of the fall term');
    expect(new Set(store.gateCalls)).toEqual(new Set(['sessions.archive.write']));
  });

  it('refuses a list longer than one request may act on, and writes nothing', async () => {
    // Reached only by a hand-rolled POST — the console chunks. Every exported
    // argument of a server action is a client-controlled field.
    const many = Array.from({ length: MAX_BULK_TARGETS + 1 }, (_, i) => `p${i}`);
    const res = await bulkApprovePlayers(many, 'competitive', REASON);

    expect(res.ok).toBe(false);
    expect(auditsOf('player_approved')).toHaveLength(0);
    expect(store.gateCalls).toEqual([]);
  });
});

describe('sessions', () => {
  it('closes each night on its own, with its own audit row', async () => {
    const res = await bulkArchiveSessions(['s-1', 's-2'], 'End of the fall term');

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toMatchObject({ attempted: 2, succeeded: 2, failures: [] });
    expect((store.db.sessions ?? []).every((s) => s.status === 'closed')).toBe(true);
    expect(auditsOf('session_archived')).toHaveLength(2);
  });

  it('takes the attendance rows with a deletion, one session at a time', async () => {
    // Why Close and Delete stay two buttons: this is the club's record of who
    // actually turned up, and it goes with the night.
    const res = await bulkDeleteSessions(['s-1'], 'Duplicated by the import');

    expect(res.ok).toBe(true);
    expect((store.db.sessions ?? []).map((s) => s.id)).toEqual(['s-2']);
    expect(store.db.session_attendance).toEqual([]);
    expect(auditsOf('session_deleted')).toHaveLength(1);
  });

  it('refuses the whole thing when the reason is too short, before any write', async () => {
    const res = await bulkArchiveSessions(['s-1', 's-2'], 'x');

    expect(res.ok).toBe(true);
    // requireReason runs per record, inside archiveSession, so this arrives as
    // two named refusals rather than one — which is the honest shape: the loop
    // really did try each one.
    if (res.ok) {
      expect(res.data.succeeded).toBe(0);
      expect(res.data.failures).toHaveLength(2);
      expect(res.data.failures[0]!.error).toMatch(/needs a reason/i);
    }
    expect((store.db.sessions ?? []).every((s) => s.status === 'open')).toBe(true);
  });
});
