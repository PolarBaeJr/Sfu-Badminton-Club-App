import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isApprovalEdit } from '../player-approval';

describe('isApprovalEdit', () => {
  it('treats a pending signup moving into a division as an approval', () => {
    // approvePlayer is what emails them "you're in" and files the
    // player_approved audit row. Edit is the only console control left on the
    // Needs Attention tab, so this is the only thing keeping either of those
    // from being lost.
    expect(isApprovalEdit('pending_approval', 'competitive')).toBe(true);
    expect(isApprovalEdit('pending_approval', 'recreational')).toBe(true);
  });

  it('does not welcome someone who is being deactivated or suspended instead', () => {
    expect(isApprovalEdit('pending_approval', 'inactive')).toBe(false);
    expect(isApprovalEdit('pending_approval', 'suspended')).toBe(false);
    expect(isApprovalEdit('pending_approval', 'pending_approval')).toBe(false);
  });

  it('never re-approves someone who was already in', () => {
    // A recreational member moved to competitive is an ordinary status change:
    // they have been welcomed once already, and approving them twice would file
    // a second player_approved row for an approval that never happened.
    expect(isApprovalEdit('recreational', 'competitive')).toBe(false);
    expect(isApprovalEdit('competitive', 'recreational')).toBe(false);
    expect(isApprovalEdit('suspended', 'competitive')).toBe(false);
  });

  it('says no when the stored status is unknown', () => {
    expect(isApprovalEdit(undefined, 'competitive')).toBe(false);
    expect(isApprovalEdit(null, 'competitive')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The same rule, server-side
// ---------------------------------------------------------------------------
// EVERYTHING ABOVE IS A CLIENT-SIDE RULE, and until now that was all there was.
// approvePlayer wrote `status` and `active_flag: true` with no reference to what
// the row held, so the "only out of pending_approval" boundary lived entirely in
// the two dialogs that call it. A server action is a public endpoint and a stale
// tab is a client that still believes an old status, so the rule was a
// suggestion — the shape reinstatePlayer's own comment calls out ("this is the
// guarantee rather than the suggestion").
//
// A privilege audit read the same lines and proposed an `is_banned` check, on the
// reading that a holder of players.approve.write could return a banned member to
// the active roster without holding players.reinstate.write. The precondition
// below is strictly stronger and better shaped: a banned member is not
// pending_approval — banPlayer does not touch `status` — so it refuses them, and
// refuses the suspended and the already-approved with them. The ban itself is not
// what makes the write wrong, and `active_flag: true` beside a ban is what the
// club asks for anyway (see updatePlayer's note on not marking a banned member
// inactive).

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  rpcCalls: [] as string[],
  emails: [] as string[],
}));

const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    let op: 'select' | 'update' = 'select';
    let payload: Row = {};

    const matching = () => (store.db[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));

    const run = () => {
      if (op === 'update') {
        const hit = matching();
        for (const r of hit) Object.assign(r, payload);
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      return { data: matching().map((r) => ({ ...r })), error: null };
    };

    const api = {
      select() { return api; },
      insert(p: Row) { (store.db[table] ??= []).push({ ...p }); return api; },
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
    rpc: async (name: string) => {
      store.rpcCalls.push(name);
      return { data: 'K3F9TQ2', error: null };
    },
  };
});

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('../supabase-server', () => ({ createAdminClient: makeClient }));
vi.mock('../actions/_shared', () => ({
  requireCapability: async () => ({ id: 'exec-1', role: 'player', is_exec: true }),
}));
vi.mock('../audit', () => ({
  logAdminAudit: async (client: { from: (t: string) => { insert: (r: Row) => unknown } }, entry: Row) => {
    await client.from('audit_logs').insert(entry);
  },
}));
// Only the mailer is replaced; every rule under test lives in @badminton/shared's
// real exports and must not be stubbed out with them.
vi.mock('@badminton/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@badminton/shared')>()),
  sendPlayerApprovedEmail: async (email: string) => { store.emails.push(email); },
}));

import { approvePlayer } from '../actions/players';

const PLAYER = '33333333-3333-4333-8333-333333333333';
const player = () => store.db.players!.find((p) => p.id === PLAYER)!;
const approvals = () => (store.db.audit_logs ?? []).filter((r) => r.action_type === 'player_approved');

function seed(overrides: Row) {
  store.db = {
    players: [{
      id: PLAYER, status: 'pending_approval', active_flag: false,
      is_banned: false, email: 'ada@sfu.ca', full_name: 'Ada', ...overrides,
    }],
    audit_logs: [],
  };
}

beforeEach(() => {
  store.rpcCalls = [];
  store.emails = [];
  seed({});
});

describe('approvePlayer refuses anything that is not a pending signup', () => {
  it('approves a pending signup, stamps a code and welcomes them', async () => {
    const res = await approvePlayer(PLAYER, 'competitive', 'Signed up at the fair');

    expect(res.ok).toBe(true);
    expect(player().status).toBe('competitive');
    expect(player().active_flag).toBe(true);
    expect(store.rpcCalls).toContain('assign_member_code');
    expect(store.emails).toEqual(['ada@sfu.ca']);
    expect(approvals()).toHaveLength(1);
  });

  // The audit's case, arrived at the right way round. The member stays banned
  // either way — is_banned is its own refusal everywhere — but the club must not
  // send them "you're in", and their status must not be rewritten from a screen
  // that is meant to be letting new people in.
  it('will not approve a banned member, and sends them nothing', async () => {
    seed({ status: 'suspended', is_banned: true });

    const res = await approvePlayer(PLAYER, 'competitive', 'Trying it on');

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/only a pending signup/i);
    expect(player().status).toBe('suspended');
    expect(player().active_flag).toBe(false);
    expect(store.emails).toEqual([]);
    expect(approvals()).toHaveLength(0);
  });

  // removePlayer writes { status: 'suspended', active_flag: false } and asks for
  // players.remove.write, which no baseline below admin holds. Approval must not
  // be the way back out of it.
  it('will not undo a removal', async () => {
    seed({ status: 'suspended', active_flag: false });

    const res = await approvePlayer(PLAYER, 'recreational', 'Putting them back');

    expect(res.ok).toBe(false);
    expect(player().status).toBe('suspended');
    expect(player().active_flag).toBe(false);
  });

  // Nothing is destroyed here, but the log is: a second player_approved row over
  // an already-approved member reads as an approval that never happened, and its
  // old_value is the row as it was months after the real one.
  it('will not re-approve somebody who is already in', async () => {
    seed({ status: 'recreational', active_flag: true });

    const res = await approvePlayer(PLAYER, 'competitive', 'Moving them up');

    expect(res.ok).toBe(false);
    expect(player().status).toBe('recreational');
    expect(approvals()).toHaveLength(0);
    expect(store.emails).toEqual([]);
  });

  // The read is a moment old, so two execs clearing the Needs Attention tab
  // together both pass the check above. The predicate on the UPDATE is what makes
  // exactly one of them the approver.
  it('lets only one of two concurrent approvals through', async () => {
    // The first call commits; the row is no longer pending for the second.
    const first = await approvePlayer(PLAYER, 'competitive', 'First exec');
    const second = await approvePlayer(PLAYER, 'recreational', 'Second exec');

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(player().status).toBe('competitive');
    expect(approvals()).toHaveLength(1);
    expect(store.emails).toEqual(['ada@sfu.ca']);
  });
});
