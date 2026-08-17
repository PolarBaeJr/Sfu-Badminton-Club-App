import { describe, it, expect, beforeEach, vi } from 'vitest';

// THE DESK'S WRITES MUST NOT LAND ON A ROW THAT MOVED UNDER THEM.
//
// setMatchLive and setMatchCourt both read the match, reason carefully about what
// they read, and then issued an UPDATE keyed on the id alone. Everything the
// guard established was true of a row that had already been replaced by the time
// the write ran:
//
//   * Start/Undo refuses 'completed', 'walkover', 'voided' and 'disputed'. Two
//     execs on the Court Management tab — one presses Start, the other submits
//     that match's score — and the unguarded UPDATE stomps 'completed' back to
//     'live' while the score rows and the bracket advancement stay applied. The
//     match reappears as if still on court with the next round already filled in.
//   * The audit row then records `previous_status` from the STALE read, so the
//     log asserts a transition that never happened — worse than no row at all,
//     because it is the artefact somebody reconstructs the day from.
//   * setMatchCourt has the same shape: it reads `court`, decides the change is
//     not a no-op, and overwrites whatever the other desk typed in between.
//
// THE ASSERTIONS ARE ON THE SURVIVING ROW AND ON THE AUDIT LOG, never on "it
// threw". A refusal that still overwrote, or that refused and logged anyway,
// would pass a throw-only test and leave both defects in place.
//
// The interleaving is MODELLED, not asserted about by string: `beforeUpdate` runs
// inside the fake client at the instant between the action's read and its write,
// which is exactly where the other desk's commit lands in production.

type Row = Record<string, unknown>;
type Op = 'select' | 'update' | 'insert';

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  seq: 0,
  /** Runs just before an UPDATE is applied — models the other desk winning. */
  beforeUpdate: null as null | ((ctx: { table: string; payload: Row }) => void),
}));

const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    // `.eq(col, null)` compiles to `col=eq.null` in PostgREST and matches NOTHING,
    // which is why the two predicate kinds are tracked separately here. A fake
    // that folded them together would let a guard written as `.eq('court', null)`
    // pass in this file and turn every court-clear into a spurious conflict in
    // production — the exact class of mistake these tests exist to catch.
    const eqFilters: Array<[string, unknown]> = [];
    const isFilters: Array<[string, unknown]> = [];
    let op: Op = 'select';
    let payload: Row = {};

    const matching = () =>
      (store.db[table] ?? []).filter(
        (r) =>
          eqFilters.every(([c, v]) => v !== null && r[c] === v) &&
          isFilters.every(([c, v]) => (v === null ? r[c] == null : r[c] === v)),
      );

    const run = (): { data: Row[] | null; error: { message: string } | null } => {
      if (op === 'insert') {
        const row = { id: `row-${++store.seq}`, ...payload };
        (store.db[table] ??= []).push(row);
        return { data: [row], error: null };
      }
      if (op === 'update') {
        store.beforeUpdate?.({ table, payload });
        const hit = matching();
        for (const r of hit) Object.assign(r, payload);
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      // Detached copies: PostgREST returns JSON, not a live handle on the row.
      return { data: matching().map((r) => ({ ...r })), error: null };
    };

    const api = {
      select() { return api; },
      insert(p: Row) { op = 'insert'; payload = p; return api; },
      update(p: Row) { op = 'update'; payload = p; return api; },
      eq(c: string, v: unknown) { eqFilters.push([c, v]); return api; },
      is(c: string, v: unknown) { isFilters.push([c, v]); return api; },
      async single() {
        const res = run();
        return { data: res.data?.[0] ?? null, error: res.error };
      },
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

vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('../supabase-server', () => ({ createAdminClient: makeClient }));
// The whole internal helper module: requireCapability, the suspension gate and
// the revalidate calls are all beside the point here, and _internal drags in
// next/cache plus the entire shared barrel.
vi.mock('../tournament-actions/_internal', () => ({
  requireCapability: async () => ({ id: 'admin-1', role: 'admin' }),
  revalidateEventPaths: () => {},
  assertTournamentNotSuspended: async () => {},
}));
// The REAL audit shape, writing into the same fake db, so the rows asserted on
// below are the rows the action actually produces.
vi.mock('../audit', () => ({
  logAudit: async (client: { from: (t: string) => { insert: (r: Row) => unknown } }, entry: Row) => {
    await client.from('tournament_audit_log').insert(entry);
  },
}));

import { setMatchLive, setMatchCourt } from '../tournament-actions/scheduling';

const TOURNAMENT = 'tourn-1';
const EVENT = 'event-1';
const MATCH = 'match-1';

const match = () => store.db.tournament_matches!.find((r) => r.id === MATCH)!;
const auditRows = (action?: string) =>
  (store.db.tournament_audit_log ?? []).filter((r) => !action || r.action === action);

function seedMatch(extra: Row = {}) {
  store.db.tournament_matches = [{
    id: MATCH,
    status: 'ready',
    is_bye: false,
    court: null,
    event_id: EVENT,
    participant_a_id: 'entry-a',
    participant_b_id: 'entry-b',
    pair_a_id: null,
    pair_b_id: null,
    updated_at: '2026-08-01T00:00:00.000Z',
    // The action selects `event:tournament_events(tournament_id)` as an embed, so
    // the fake row carries the embedded object rather than a joinable table.
    event: { tournament_id: TOURNAMENT },
    ...extra,
  }];
}

/** The other desk's score submission, committed between our read and our write. */
function otherDeskCompletes() {
  store.beforeUpdate = ({ table }) => {
    if (table !== 'tournament_matches') return;
    store.beforeUpdate = null;
    const row = match();
    row.status = 'completed';
    row.winner_participant_id = 'entry-a';
  };
}

beforeEach(() => {
  store.seq = 0;
  store.beforeUpdate = null;
  store.db = { tournament_matches: [], tournament_audit_log: [] };
  seedMatch();
});

describe('setMatchLive', () => {
  // The ordinary path, which must stay open — every guard below is worthless if
  // calling a match onto court stops working.
  it('starts a ready match and audits the transition it actually made', async () => {
    const res = await setMatchLive(MATCH, true);

    expect(res.ok).toBe(true);
    expect(match().status).toBe('live');
    expect(auditRows('match_started')).toHaveLength(1);
    expect((auditRows('match_started')[0]!.details as Row).previous_status).toBe('ready');
  });

  it('takes a live match back off court', async () => {
    seedMatch({ status: 'live' });

    const res = await setMatchLive(MATCH, false);

    expect(res.ok).toBe(true);
    expect(match().status).toBe('ready');
    expect(auditRows('match_start_undone')).toHaveLength(1);
  });

  // THE REPORTED DEFECT. The guard above the write read 'ready' and was right to
  // let it through; by the time the UPDATE ran the match was 'completed'.
  it('refuses to start a match that was completed between the read and the write', async () => {
    otherDeskCompletes();

    const res = await setMatchLive(MATCH, true);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toMatch(/changed while you were looking at it/i);
    // The result survives, and so does everything the bracket derived from it.
    expect(match().status).toBe('completed');
    expect(match().winner_participant_id).toBe('entry-a');
    // And no log entry claiming a transition out of 'ready' that never happened.
    expect(auditRows()).toHaveLength(0);
  });

  // The same race in the other direction: Undo, against a match somebody has
  // just finished. 'live' -> 'ready' would un-complete it just as thoroughly.
  it('refuses to undo a start when the match was completed in the meantime', async () => {
    seedMatch({ status: 'live' });
    otherDeskCompletes();

    const res = await setMatchLive(MATCH, false);

    expect(res.ok).toBe(false);
    expect(match().status).toBe('completed');
    expect(auditRows()).toHaveLength(0);
  });

  // The guards that were already correct, kept honest: this file now owns the
  // write, so it owns the refusals that decide whether the write is reached.
  it('still refuses an already-decided match up front', async () => {
    seedMatch({ status: 'completed' });

    const res = await setMatchLive(MATCH, true);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toMatch(/completed/i);
    expect(auditRows()).toHaveLength(0);
  });

  it('is idempotent in both directions without writing anything', async () => {
    seedMatch({ status: 'live' });
    expect((await setMatchLive(MATCH, true)).ok).toBe(true);
    expect(match().status).toBe('live');

    seedMatch({ status: 'ready' });
    expect((await setMatchLive(MATCH, false)).ok).toBe(true);
    expect(match().status).toBe('ready');

    expect(auditRows()).toHaveLength(0);
  });
});

describe('setMatchCourt', () => {
  // Naming a court where there was none is the COMMON case and it exercises the
  // null branch of the guard. `.eq('court', null)` would match no row here and
  // turn this into a permanent, inexplicable refusal.
  it('names a court on a match that had none', async () => {
    const res = await setMatchCourt(MATCH, '3');

    expect(res.ok).toBe(true);
    expect(match().court).toBe('3');
    expect(auditRows('match_court_set')).toHaveLength(1);
  });

  it('clears a court back to unassigned', async () => {
    seedMatch({ court: '3' });

    const res = await setMatchCourt(MATCH, '');

    expect(res.ok).toBe(true);
    expect(match().court).toBeNull();
    expect(auditRows('match_court_cleared')).toHaveLength(1);
  });

  it('moves a match from one court to another', async () => {
    seedMatch({ court: '3' });

    const res = await setMatchCourt(MATCH, '7');

    expect(res.ok).toBe(true);
    expect(match().court).toBe('7');
  });

  // The same read-then-write shape as Start: two execs typing a court on the same
  // row, and the loser used to overwrite the winner while auditing a
  // `previous_court` that had not been there for some time.
  it('refuses to overwrite a court another desk set in the meantime', async () => {
    store.beforeUpdate = ({ table }) => {
      if (table !== 'tournament_matches') return;
      store.beforeUpdate = null;
      match().court = '11';
    };

    const res = await setMatchCourt(MATCH, '3');

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toMatch(/changed while you were looking at it/i);
    expect(match().court).toBe('11');
    expect(auditRows()).toHaveLength(0);
  });

  it('refuses to clear a court another desk changed in the meantime', async () => {
    seedMatch({ court: '3' });
    store.beforeUpdate = ({ table }) => {
      if (table !== 'tournament_matches') return;
      store.beforeUpdate = null;
      match().court = '11';
    };

    const res = await setMatchCourt(MATCH, '');

    expect(res.ok).toBe(false);
    expect(match().court).toBe('11');
    expect(auditRows()).toHaveLength(0);
  });
});
