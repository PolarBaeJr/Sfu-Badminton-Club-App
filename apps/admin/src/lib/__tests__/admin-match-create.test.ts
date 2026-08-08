import { describe, it, expect, beforeEach, vi } from 'vitest';

// adminCreateMatch writes four tables with no transaction around them, and it
// used to throw away the results of two of them. supabase-js RESOLVES on a
// Postgres error instead of rejecting, so a failed participant or game insert
// was indistinguishable from success — and for an UNRATED match nothing
// downstream reads either table, so the action audited the match and returned
// its id while the database held a completed match with a winner, a score
// summary and nobody in it.
//
// These tests exist to prove that cannot happen again. The harness below can
// make any single write fail the way Postgres actually fails, and every case
// asserts on what is LEFT BEHIND, not merely that the caller saw an error —
// "it threw" was already true of the broken code in the cleanup cases.

type Row = Record<string, unknown>;
type Op = 'select' | 'update' | 'insert' | 'delete';

interface Fault {
  table: string;
  op: Op;
  message: string;
  code?: string;
}

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  faults: [] as Fault[],
  seq: 0,
  /** Fires when the participant batch is attempted — stands in for another
   *  admin touching the committed match shell while this action is mid-flight. */
  onParticipantInsert: null as null | (() => void),
}));

// Minimal PostgREST-shaped builder: thenable, resolves with { data, error }
// rather than rejecting, and models the ON DELETE CASCADE from match_id that
// the cleanup path depends on (00001_schema.sql).
const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    const inFilters: Array<[string, unknown[]]> = [];
    let op: Op = 'select';
    let payload: Row | Row[] = {};

    const matching = () =>
      (store.db[table] ?? []).filter(
        (r) =>
          filters.every(([c, v]) => r[c] === v) &&
          inFilters.every(([c, vs]) => vs.includes(r[c])),
      );

    const fault = () => store.faults.find((f) => f.table === table && f.op === op);

    const run = (): { data: Row[] | null; error: { message: string; code?: string } | null } => {
      if (table === 'match_participants' && op === 'insert') store.onParticipantInsert?.();
      const f = fault();
      if (f) return { data: null, error: { message: f.message, code: f.code } };
      if (op === 'insert') {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r) => ({
          id: `${table}-${++store.seq}`,
          ...r,
        }));
        (store.db[table] ??= []).push(...rows);
        return { data: rows, error: null };
      }
      if (op === 'update') {
        for (const r of matching()) Object.assign(r, payload);
        return { data: null, error: null };
      }
      if (op === 'delete') {
        const doomed = matching();
        store.db[table] = (store.db[table] ?? []).filter((r) => !doomed.includes(r));
        // matches -> match_participants / match_games are ON DELETE CASCADE.
        if (table === 'matches') {
          const ids = doomed.map((r) => r.id);
          for (const child of ['match_participants', 'match_games']) {
            store.db[child] = (store.db[child] ?? []).filter((r) => !ids.includes(r.match_id));
          }
        }
        // `.select()` after a delete returns the rows that were removed — which
        // is how the action tells "deleted nothing" from "deleted the shell".
        return { data: doomed, error: null };
      }
      return { data: matching(), error: null };
    };

    const api = {
      select() { return api; },
      insert(p: Row | Row[]) { op = 'insert'; payload = p; return api; },
      update(p: Row) { op = 'update'; payload = p; return api; },
      delete() { op = 'delete'; return api; },
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      in(c: string, vs: unknown[]) { inFilters.push([c, vs]); return api; },
      async single() {
        const res = run();
        if (res.error) return { data: null, error: res.error };
        return { data: res.data?.[0] ?? null, error: null };
      },
      // Same shape as single() here: the distinction that matters to PostgREST
      // — no row is an error vs no row is null — is not what these tests
      // exercise, and a builder that simply lacks the method turns a production
      // call into "undefined is not a function" three layers down.
      async maybeSingle() {
        const res = run();
        if (res.error) return { data: null, error: res.error };
        return { data: res.data?.[0] ?? null, error: null };
      },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(run()).then(resolve); },
    };
    return api;
  }
  return {
    from: (table: string) => query(table),
    rpc: async () => ({ data: null, error: null }),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('../supabase-server', () => ({ createAdminClient: makeClient }));
vi.mock('../actions/_shared', () => ({
  getExecOrAdmin: async () => ({ id: 'admin-1', role: 'admin' }),
  getAdminPlayer: async () => ({ id: 'admin-1', role: 'admin' }),
}));

import { adminCreateMatch } from '../actions/matches';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

const validMatch = {
  match_type: 'singles',
  format: 'single_21',
  rated_flag: false,
  side_a_players: [ALICE],
  side_b_players: [BOB],
  winner_side: 'a',
  games: [{ game_number: 1, side_a_score: 21, side_b_score: 15 }],
};

const matches = () => store.db.matches ?? [];
const participants = () => store.db.match_participants ?? [];
const games = () => store.db.match_games ?? [];

beforeEach(() => {
  store.faults = [];
  store.seq = 0;
  store.onParticipantInsert = null;
  store.db = {
    seasons: [{ id: 'season-1', active_flag: true }],
    ratings: [
      { player_id: ALICE, singles_elo: 900, doubles_elo: 900 },
      { player_id: BOB, singles_elo: 950, doubles_elo: 950 },
    ],
    matches: [],
    match_participants: [],
    match_games: [],
    audit_logs: [],
  };
});

describe('adminCreateMatch', () => {
  it('writes the match, its participants and its games on the happy path', async () => {
    const res = await adminCreateMatch(validMatch);
    expect(res.ok).toBe(true);
    expect(matches()).toHaveLength(1);
    expect(participants()).toHaveLength(2);
    expect(games()).toHaveLength(1);
  });

  // The reported trigger. Before the schema refinement this parsed cleanly, the
  // match row committed, and the participant batch died on
  // UNIQUE(match_id, player_id) — silently, because the result was discarded.
  // The assertion that discriminates is the empty matches table: "it failed" is
  // not enough, because the broken code left a match behind while reporting
  // SUCCESS.
  it('refuses the same player on both sides without writing anything', async () => {
    const res = await adminCreateMatch({ ...validMatch, side_b_players: [ALICE] });
    expect(res.ok).toBe(false);
    expect(matches()).toHaveLength(0);
    expect(participants()).toHaveLength(0);
  });

  // The failure mode the schema cannot see coming: a player deleted between
  // validation and the insert, a concurrent write, any constraint at all. The
  // half-state that must survive is "no match", not "a scored match belonging
  // to nobody".
  it('discards the match when the participant insert fails', async () => {
    store.faults.push({
      table: 'match_participants',
      op: 'insert',
      code: '23505',
      message: 'duplicate key value violates unique constraint "match_participants_match_id_player_id_key"',
    });

    const res = await adminCreateMatch(validMatch);
    expect(res.ok).toBe(false);
    expect(matches()).toHaveLength(0);
    expect(participants()).toHaveLength(0);
    expect(games()).toHaveLength(0);
  });

  // Same defect one line further down: match_games' error was discarded too, so
  // a match could end up with participants, a winner and no scores.
  it('discards the match when the game insert fails, taking the participants with it', async () => {
    store.faults.push({
      table: 'match_games',
      op: 'insert',
      message: 'duplicate key value violates unique constraint "match_games_match_id_game_number_key"',
    });

    const res = await adminCreateMatch(validMatch);
    expect(res.ok).toBe(false);
    expect(matches()).toHaveLength(0);
    // The cascade is load-bearing: without it the cleanup would leave the
    // participant rows pointing at a match that no longer exists.
    expect(participants()).toHaveLength(0);
  });

  // If the cleanup cannot run, the orphan is real. The one thing that must not
  // happen then is silence — the admin has to be told which match to void.
  it('names the orphan when the cleanup delete also fails', async () => {
    store.faults.push({ table: 'match_participants', op: 'insert', message: 'participants exploded' });
    store.faults.push({ table: 'matches', op: 'delete', message: 'delete exploded' });

    const res = await adminCreateMatch(validMatch);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toContain(matches()[0]!.id as string);
    expect(res.error).toMatch(/void/i);
  });

  // The shell is committed and visible on /matches while this action is still
  // running, so another admin can void it in that window. Cleaning up by id
  // alone would then delete somebody else's decision — and cascade away any
  // dispute filed against it — while reporting only the original failure. The
  // delete is scoped to the status we wrote, so a row that has moved on stays.
  it('does not delete a match that somebody else has already voided', async () => {
    store.faults.push({
      table: 'match_participants',
      op: 'insert',
      message: 'participants exploded',
    });
    // Stand in for the concurrent void: the row is no longer as we left it.
    store.onParticipantInsert = () => { matches()[0]!.result_status = 'voided'; };

    const res = await adminCreateMatch(validMatch);

    expect(res.ok).toBe(false);
    expect(matches()).toHaveLength(1);
    expect(matches()[0]!.result_status).toBe('voided');
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toMatch(/void it from the matches list/i);
  });
});
