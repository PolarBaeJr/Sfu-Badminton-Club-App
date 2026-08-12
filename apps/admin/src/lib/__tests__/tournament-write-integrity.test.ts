import { describe, it, expect, beforeEach, vi } from 'vitest';

// supabase-js resolves with { data, error } and only REJECTS on a transport
// failure, so every Postgres error the tournament engine hit — an RLS denial, a
// constraint violation — arrived as a fulfilled promise and was dropped on the
// floor. These tests exist to prove that stopped: the harness below can make
// any individual write fail the way Postgres actually fails, and every case
// asserts the failure reaches the caller AND that what is left behind can be
// repaired.

type Row = Record<string, unknown>;
type Op = 'select' | 'update' | 'insert' | 'delete';

interface Fault {
  table: string;
  op: Op;
  message: string;
  /** Narrow the fault to one row: gets the filters and the payload of the write. */
  when?: (ctx: { filters: Array<[string, unknown]>; payload: Row }) => boolean;
}

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  faults: [] as Fault[],
  // Stands in for `gen_random_uuid()`. Bracket generation inserts a match shell
  // and immediately uses the id it gets back to wire up the next round, so an
  // insert that returns no id cannot be exercised at all.
  seq: 0,
}));

// Minimal PostgREST-shaped query builder: enough of select/eq/in/not/order/
// update/insert for the tournament actions, thenable so
// `await client.from(t).update(x).eq(...)` resolves the way the real client
// does — INCLUDING resolving with an { error } rather than throwing.
const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    const inFilters: Array<[string, unknown[]]> = [];
    const notFilters: Array<[string, string, unknown]> = [];
    // `.is(col, null)` — a seeded row may omit the column entirely, which stands
    // for SQL NULL here just as COALESCE tolerates it elsewhere in this harness.
    const isFilters: Array<[string, unknown]> = [];
    let orderBy: [string, boolean] | null = null;
    let cols = '*';
    let op: Op = 'select';
    let payload: Row = {};
    // `.select(cols, { count: 'exact', head: true })`. An UPDATE already
    // reported its count here, because "matched no rows is a success" is the
    // whole reason this harness exists — but a SELECT did not, so every guard
    // that counts rows and refuses (assertNoResultsEntered, the go-live "no
    // bracket" check, the entry-cap checks) read `undefined`, took the
    // `(count ?? 0) > 0` branch as false, and was VACUOUS in every test that
    // reached it. A guard that cannot fail in the harness is a guard the
    // harness is not testing.
    let countExact = false;
    let head = false;

    // PostgREST spells a list literal `("a","b")`.
    const parseList = (raw: unknown): unknown[] =>
      String(raw).replace(/^\(/, '').replace(/\)$/, '').split(',')
        .map((s) => s.trim().replace(/^"/, '').replace(/"$/, ''));

    const passesNot = (r: Row) =>
      notFilters.every(([c, o, v]) => {
        if (o === 'in') return !parseList(v).includes(r[c]);
        if (o === 'is') return v === null ? r[c] !== null && r[c] !== undefined : r[c] !== v;
        return r[c] !== v;
      });

    const matching = () => {
      const rows = (store.db[table] ?? []).filter(
        (r) =>
          filters.every(([c, v]) => r[c] === v) &&
          inFilters.every(([c, vs]) => vs.includes(r[c])) &&
          isFilters.every(([c, v]) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)) &&
          passesNot(r),
      );
      if (!orderBy) return rows;
      const [col, asc] = orderBy;
      return [...rows].sort((a, b) => (((a[col] as number) ?? 0) - ((b[col] as number) ?? 0)) * (asc ? 1 : -1));
    };

    // Always a COPY. The real client decodes a row out of an HTTP response, so a
    // caller that read a row, wrote to it, and then consulted its own copy sees
    // the values from BEFORE the write. Handing back the live object instead made
    // that read follow the write, which is how a rollback-to-the-row-as-found
    // could look like a no-op and pass for the wrong reason.
    const embed = (r: Row): Row =>
      cols.includes('tournament_events(')
        ? { ...r, event: (store.db.tournament_events ?? []).find((e) => e.id === r.event_id) ?? null }
        : { ...r };

    const fault = () =>
      store.faults.find((f) => f.table === table && f.op === op && (!f.when || f.when({ filters, payload })));

    const run = () => {
      const f = fault();
      // The whole point: a Postgres error is a RESOLVED value, not a rejection.
      if (f) return { data: null, error: { message: f.message } };
      if (op === 'update') {
        const hit = matching();
        for (const r of hit) Object.assign(r, payload);
        // PostgREST reports "matched no rows" as SUCCESS, so the count is the
        // only way a caller can tell a guarded write fired from one that did
        // not. Always returned; supabase-js only populates it when asked, and a
        // caller that does not ask simply ignores it.
        return { data: null, error: null, count: hit.length };
      }
      if (op === 'insert') {
        const rows = Array.isArray(payload) ? (payload as Row[]) : [payload];
        // The id is spread FIRST so an explicit one in the payload wins, exactly
        // as a DEFAULT does. Rows are returned rather than discarded because
        // `.insert(...).select('id').single()` is how every match shell in the
        // bracket generator is created.
        const created = rows.map((r) => ({ id: `gen-${++store.seq}`, ...r }));
        (store.db[table] ??= []).push(...created);
        return { data: created, error: null };
      }
      if (op === 'delete') {
        store.db[table] = (store.db[table] ?? []).filter((r) => !matching().includes(r));
        return { data: null, error: null };
      }
      const rows = matching();
      // head:true asks PostgREST for the count and no body, so `data` is null —
      // a caller that reads `data` off a head request must see nothing there.
      if (countExact) return { data: head ? null : rows.map(embed), error: null, count: rows.length };
      return { data: rows.map(embed), error: null };
    };

    const api = {
      select(c: string, opts?: { count?: string; head?: boolean }) {
        cols = c;
        countExact = opts?.count === 'exact';
        head = opts?.head === true;
        return api;
      },
      update(p: Row) { op = 'update'; payload = p; return api; },
      insert(p: Row) { op = 'insert'; payload = p; return api; },
      delete() { op = 'delete'; return api; },
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      in(c: string, vs: unknown[]) { inFilters.push([c, vs]); return api; },
      is(c: string, v: unknown) { isFilters.push([c, v]); return api; },
      not(c: string, o: string, v: unknown) { notFilters.push([c, o, v]); return api; },
      order(c: string, opts?: { ascending?: boolean }) { orderBy = [c, opts?.ascending !== false]; return api; },
      async single() {
        const f = fault();
        if (f) return { data: null, error: { message: f.message } };
        // `.insert(x).select('id').single()` is a WRITE that returns what it
        // wrote. Reading the table instead — which is what this did — meant an
        // insert issued that way never happened at all, and any code path built
        // on the returned id was untestable.
        if (op !== 'select') {
          const res = run() as { data: Row[] | null; error: unknown };
          if (res.error) return { data: null, error: res.error };
          const created = res.data?.[0];
          return { data: created ? embed(created) : null, error: null };
        }
        const r = matching()[0];
        return { data: r ? embed(r) : null, error: null };
      },
      async maybeSingle() {
        const f = fault();
        if (f) return { data: null, error: { message: f.message } };
        const r = matching()[0];
        return { data: r ? embed(r) : null, error: null };
      },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(run()).then(resolve); },
    };
    return api;
  }

  // Stand-ins for the two rating RPCs
  // (supabase/migrations/00070_tournament_rating_atomic.sql and
  //  supabase/migrations/00078_tournament_rating_reversal_atomic.sql).
  //
  // BOTH ARE ATOMIC ON PURPOSE. Every logical write still consults store.faults
  // with the same { table, op, filters, payload } shape a direct PostgREST write
  // would, so the existing fault fixtures keep working — but the FIRST failure
  // restores the whole store and returns an error. A harness that let half the
  // writes survive could not tell the fixed behaviour from the bug it replaces.
  const faultFor = (table: string, op: Op, ctx: { filters: Array<[string, unknown]>; payload: Row }) =>
    store.faults.find((f) => f.table === table && f.op === op && (!f.when || f.when(ctx)));

  // rating_setting_int('provisional_threshold', 8)
  const threshold = () => {
    const settings = (store.db.platform_settings ?? []).find((r) => r.key === 'rating_defaults')?.value as Row | undefined;
    return (settings?.provisional_threshold as number) ?? 8;
  };

  function applyRpc(args: Record<string, unknown>) {
    const rollback = structuredClone(store.db);
    const abort = (message: string) => {
      store.db = rollback;
      return Promise.resolve({ data: null, error: { message } });
    };

    const matchId = args.p_match_id as string;
    const discipline = args.p_discipline as 'singles' | 'doubles';
    const entries = args.p_entries as Array<Record<string, unknown>>;

    const m = (store.db.tournament_matches ?? []).find((r) => r.id === matchId);
    if (!m) return abort(`Tournament match not found: ${matchId}`);
    if (m.elo_snapshot) return abort(`Tournament match ${matchId} is already rated`);

    const snapshotEntries: Row[] = [];

    for (const e of entries) {
      const pid = e.player_id as string;
      const row = (store.db.ratings ?? []).find((r) => r.player_id === pid);
      if (!row) return abort(`No ratings row for player ${pid} — cannot rate tournament match ${matchId}`);

      const eloField = `${discipline}_elo`;
      const ratingFault = faultFor('ratings', 'update', {
        filters: [['player_id', pid]],
        payload: { [eloField]: e.after },
      });
      if (ratingFault) return abort(ratingFault.message);

      // apply_rating_stats. The seeded ratings rows omit the statistics columns
      // entirely, exactly as COALESCE(%I, 0) in the real SQL tolerates a NULL —
      // so a missing column has to read as 0 here or the assertions would come
      // back NaN and pass for the wrong reason.
      const n = (k: string) => (row[k] as number | undefined) ?? 0;
      const won = e.won === true;
      const played = n(`${discipline}_matches_played`) + 1;
      const streakField = `current_${discipline}_streak`;
      // Read BEFORE apply_rating_stats moves it, and stored on the snapshot, so
      // the reversal can put the streak back exactly rather than stepping it.
      const streakBefore = n(streakField);
      const streakAfter = won ? Math.max(streakBefore + 1, 1) : Math.min(streakBefore - 1, -1);

      row[eloField] = e.after;
      row[`${discipline}_matches_played`] = played;
      row[`${discipline}_wins`] = n(`${discipline}_wins`) + (won ? 1 : 0);
      row[`${discipline}_losses`] = n(`${discipline}_losses`) + (won ? 0 : 1);
      row[`${discipline}_points_scored`] = n(`${discipline}_points_scored`) + ((e.points_scored as number) ?? 0);
      row[`${discipline}_points_allowed`] = n(`${discipline}_points_allowed`) + ((e.points_allowed as number) ?? 0);
      row[`${discipline}_games_won`] = n(`${discipline}_games_won`) + ((e.games_won as number) ?? 0);
      row[`${discipline}_games_lost`] = n(`${discipline}_games_lost`) + ((e.games_lost as number) ?? 0);
      row[streakField] = streakAfter;
      if (played >= threshold()) row[`${discipline}_provisional`] = false;

      // The half apply_match_result has always done for challenges and the
      // tournament path never did. INSERT ... ON CONFLICT in the SQL, so a
      // player with no row gets one.
      const rel = (store.db.reliability_metrics ??= []).find((r) => r.player_id === pid);
      if (rel) rel.matches_completed = ((rel.matches_completed as number | undefined) ?? 0) + 1;
      else store.db.reliability_metrics.push({ player_id: pid, matches_completed: 1 });

      if (e.participant_id) {
        const payload = { elo_after: e.after, elo_change: e.delta };
        const pFault = faultFor('tournament_participants', 'update', {
          filters: [['id', e.participant_id]],
          payload,
        });
        if (pFault) return abort(pFault.message);
        const p = (store.db.tournament_participants ?? []).find((r) => r.id === e.participant_id);
        if (p) Object.assign(p, payload);
      }

      snapshotEntries.push({
        player_id: e.player_id, before: e.before, after: e.after, delta: e.delta,
        won: e.won, points_scored: e.points_scored ?? 0, points_allowed: e.points_allowed ?? 0,
        games_won: e.games_won ?? 0, games_lost: e.games_lost ?? 0,
        streak_before: streakBefore, streak_after: streakAfter,
      });
    }

    // A superset of the pre-00070 shape: the four rating fields are unchanged,
    // and the statistics plus the streak ride along so the reversal can take
    // them off exactly.
    const snapshot = { discipline, entries: snapshotEntries };
    const snapFault = faultFor('tournament_matches', 'update', {
      filters: [['id', matchId]],
      payload: { elo_snapshot: snapshot },
    });
    if (snapFault) return abort(snapFault.message);
    m.elo_snapshot = snapshot;

    return Promise.resolve({ data: null, error: null });
  }

  function reverseRpc(args: Record<string, unknown>) {
    const rollback = structuredClone(store.db);
    const abort = (message: string) => {
      store.db = rollback;
      return Promise.resolve({ data: null, error: { message } });
    };
    const ok = () => Promise.resolve({ data: null, error: null });

    const matchId = args.p_match_id as string;
    const m = (store.db.tournament_matches ?? []).find((r) => r.id === matchId);
    if (!m) return abort(`Tournament match not found: ${matchId}`);

    const snapshot = m.elo_snapshot as { discipline: 'singles' | 'doubles'; entries: Row[] } | null;
    // Nothing to reverse is not an error — that is what makes a retry safe.
    if (!snapshot || !snapshot.entries?.length) return ok();

    const d = snapshot.discipline;
    const eloField = `${d}_elo`;
    const streakField = `current_${d}_streak`;

    for (const e of snapshot.entries) {
      const pid = e.player_id as string;
      const row = (store.db.ratings ?? []).find((r) => r.player_id === pid);
      if (!row) return abort(`No ratings row for player ${pid} — cannot reverse tournament match ${matchId}`);

      const n = (k: string) => (row[k] as number | undefined) ?? 0;
      const ratingFault = faultFor('ratings', 'update', {
        filters: [['player_id', pid]],
        payload: { [eloField]: n(eloField) - (e.delta as number) },
      });
      if (ratingFault) return abort(ratingFault.message);

      // The three snapshot tiers, discriminated exactly as the SQL does it and
      // by POSITIVE tests, so an absent key falls through to the older, more
      // conservative branch.
      const hasStats = typeof e.won === 'boolean';
      const hasStreak = hasStats && typeof e.streak_before === 'number' && typeof e.streak_after === 'number';

      row[eloField] = n(eloField) - (e.delta as number);
      if (!hasStats) continue; // pre-00070: its match moved the Elo and nothing else

      const won = e.won === true;
      const played = Math.max(0, n(`${d}_matches_played`) - 1);
      row[`${d}_matches_played`] = played;
      row[won ? `${d}_wins` : `${d}_losses`] = Math.max(0, n(won ? `${d}_wins` : `${d}_losses`) - 1);
      row[`${d}_points_scored`] = Math.max(0, n(`${d}_points_scored`) - ((e.points_scored as number) ?? 0));
      row[`${d}_points_allowed`] = Math.max(0, n(`${d}_points_allowed`) - ((e.points_allowed as number) ?? 0));
      row[`${d}_games_won`] = Math.max(0, n(`${d}_games_won`) - ((e.games_won as number) ?? 0));
      row[`${d}_games_lost`] = Math.max(0, n(`${d}_games_lost`) - ((e.games_lost as number) ?? 0));
      // Exact only while this is still the player's most recent rated match —
      // otherwise rewinding would erase whatever moved the streak since.
      row[streakField] = hasStreak && n(streakField) === e.streak_after
        ? e.streak_before
        : (won ? Math.max(0, n(streakField) - 1) : Math.min(0, n(streakField) + 1));
      if (played < threshold()) row[`${d}_provisional`] = true;

      // Only a 00078 snapshot counted the match on reliability_metrics, so only
      // that tier may take it back off.
      if (hasStreak) {
        const rel = (store.db.reliability_metrics ?? []).find((r) => r.player_id === pid);
        if (rel) rel.matches_completed = Math.max(0, ((rel.matches_completed as number | undefined) ?? 0) - 1);
      }
    }

    if (d === 'singles') {
      const participantIds = [m.winner_participant_id, m.loser_participant_id]
        .filter((x): x is string => typeof x === 'string' && x.length > 0);
      if (participantIds.length > 0) {
        const payload = { elo_after: null, elo_change: null };
        const pFault = faultFor('tournament_participants', 'update', { filters: [], payload });
        if (pFault) return abort(pFault.message);
        for (const p of (store.db.tournament_participants ?? []).filter((r) => participantIds.includes(r.id as string))) {
          Object.assign(p, payload);
        }
      }
    }

    const snapFault = faultFor('tournament_matches', 'update', {
      filters: [['id', matchId]],
      payload: { elo_snapshot: null },
    });
    if (snapFault) return abort(snapFault.message);
    m.elo_snapshot = null;

    return ok();
  }

  function rpc(name: string, args: Record<string, unknown>) {
    if (name === 'apply_tournament_match_rating') return applyRpc(args);
    if (name === 'reverse_tournament_match_rating') return reverseRpc(args);
    return Promise.resolve({ data: null, error: { message: `unknown rpc ${name}` } });
  }

  return { from: (table: string) => query(table), rpc };
});

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('../supabase-server', () => ({ createAdminClient: makeClient }));
vi.mock('../actions/_shared', () => ({ requireCapability: async () => ({ id: 'admin-1' }) }));

import {
  enterMatchResult, editMatchResult, enterWalkover, voidMatch, undoMatchResult,
} from '../tournament-actions/results';
import { finalizeEvent, applyPlacementBonuses } from '../tournament-actions/finalize';
import { generateSingleEliminationBracket, generateRoundRobinMatches } from '../tournament-actions/brackets';
import { withdrawParticipant } from '../tournament-actions/participants';
import {
  settleWrites, assertWritesSucceeded, reverseEloSnapshot, undoDecidedResult,
} from '../tournament-actions/_internal';
import { createAdminClient } from '../supabase-server';

const QF = 'match-qf';
const SF = 'match-sf';

function ratingOf(playerId: string) {
  return store.db.ratings!.find((r) => r.player_id === playerId)!.singles_elo as number;
}
function match(id: string) {
  return store.db.tournament_matches!.find((m) => m.id === id)!;
}
function participant(id: string) {
  return store.db.tournament_participants!.find((p) => p.id === id)!;
}
function event() {
  return store.db.tournament_events![0]!;
}
function snapshotPlayers(matchId: string): string[] {
  const snap = match(matchId).elo_snapshot as { entries: Array<{ player_id: string }> } | null;
  return (snap?.entries ?? []).map((e) => e.player_id);
}

// rating_defaults as it is actually configured in production, read live off the
// Pi rather than copied out of a migration: max_elo is 3001, not the 1500 the
// TS constant falls back to, and singles_k_established is 36, not the code
// default of 48. Tests that use the fallbacks would pass for the wrong reasons.
const LIVE_RATING_DEFAULTS = {
  min_elo: 100,
  max_elo: 3001,
  default_elo: 400,
  provisional_threshold: 8,
  singles_k_provisional: 64,
  singles_k_established: 36,
  doubles_k_provisional: 64,
  doubles_k_established: 36,
  sweep_margin_multiplier: 1.15,
};

beforeEach(() => {
  store.faults = [];
  store.db = {
    tournaments: [{ id: 't1', suspended_at: null, suspension_reason: null, name: 'Test Cup' }],
    tournament_events: [{
      id: 'e1', tournament_id: 't1', status: 'live', event_type: 'mens_singles',
      format: 'single_elimination', match_format: 'best_of_3_to_21', elo_multiplier: 1,
      placement_bonus_enabled: false,
    }],
    tournament_participants: [
      { id: 'p-alice', event_id: 'e1', player_id: 'pl-alice', elo_before: 1000, elo_after: null, elo_change: null, final_position: null, points: null, status: 'checked_in' },
      { id: 'p-bob', event_id: 'e1', player_id: 'pl-bob', elo_before: 1000, elo_after: null, elo_change: null, final_position: null, points: null, status: 'checked_in' },
    ],
    ratings: [
      { player_id: 'pl-alice', singles_elo: 1000, singles_provisional: false, singles_matches_played: 30 },
      { player_id: 'pl-bob', singles_elo: 1000, singles_provisional: false, singles_matches_played: 30 },
    ],
    // Created for every player by the on-insert trigger (00004). Seeded non-zero
    // so a decrement that ran when it should not have is visible.
    reliability_metrics: [
      { player_id: 'pl-alice', matches_completed: 5 },
      { player_id: 'pl-bob', matches_completed: 5 },
    ],
    tournament_matches: [
      {
        id: QF, event_id: 'e1', status: 'ready', is_bye: false,
        participant_a_id: 'p-alice', participant_b_id: 'p-bob',
        winner_participant_id: null, loser_participant_id: null,
        winner_to_match_id: SF, winner_to_position: 'a',
        round_number: 1, scores: null, elo_snapshot: null, notes: null,
      },
      {
        id: SF, event_id: 'e1', status: 'pending', is_bye: false,
        participant_a_id: null, participant_b_id: null,
        winner_participant_id: null, loser_participant_id: null,
        winner_to_match_id: null, winner_to_position: null,
        round_number: 2, scores: null, elo_snapshot: null, notes: null,
      },
    ],
    platform_settings: [{ key: 'rating_defaults', value: { ...LIVE_RATING_DEFAULTS } }],
    notifications: [],
    tournament_audit_log: [],
  };
});

function setRatingDefault(key: string, value: unknown) {
  const row = store.db.platform_settings!.find((r) => r.key === 'rating_defaults')!;
  row.value = { ...(row.value as Row), [key]: value };
}

describe('settleWrites', () => {
  it('counts a resolved { error } as a failure, exactly like a rejection', async () => {
    const { failures, landed } = await settleWrites([
      ['row that saved', Promise.resolve({ data: null, error: null })],
      ['row denied by RLS', Promise.resolve({ data: null, error: { message: 'permission denied for table ratings' } })],
      ['row lost in transit', Promise.reject(new Error('fetch failed'))],
    ]);

    expect(landed).toEqual([true, false, false]);
    expect(failures.map((f) => f.label)).toEqual(['row denied by RLS', 'row lost in transit']);
    // The old idiom (`if (r.status === 'rejected')`) would have seen ONE failure
    // here and silently accepted the RLS denial as a successful write.
    expect(failures).toHaveLength(2);
  });

  it('names every failed write in the error it throws', () => {
    expect(() =>
      assertWritesSucceeded('Test batch', [{ label: 'ratings.singles_elo for player X', message: 'permission denied' }]),
    ).toThrow(/ratings\.singles_elo for player X \(permission denied\)/);
  });

  it('is a no-op when everything landed', () => {
    expect(() => assertWritesSucceeded('Test batch', [])).not.toThrow();
  });
});

describe('post-match Elo writes', () => {
  // These four used to assert the MITIGATION for a half-applied rating: one
  // player's Elo moved, the other's did not, and the snapshot recorded only the
  // half that landed. All the writes now happen inside
  // apply_tournament_match_rating, so a failure rolls the whole thing back and
  // the half-state is no longer reachable. Each assertion below is the corrected
  // behaviour, not the old one.

  it('rolls the whole result back when one player\'s rating write fails', async () => {
    store.faults.push({
      table: 'ratings', op: 'update', message: 'permission denied for table ratings',
      when: ({ filters }) => filters.some(([c, v]) => c === 'player_id' && v === 'pl-bob'),
    });

    const res = await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/permission denied/);
    expect(res.ok === false && res.error).toMatch(/NOTHING was applied/);
    // Previously Alice's rating moved and Bob's did not. Now neither does —
    // there is no partial rating to reconcile by hand.
    expect(ratingOf('pl-alice')).toBe(1000);
    expect(ratingOf('pl-bob')).toBe(1000);
  });

  it('never leaves ratings moved without a snapshot recording the deltas', async () => {
    // Finding #3: the snapshot write used to be a separate round trip AFTER the
    // rating writes committed. Fault the snapshot write specifically and prove
    // the ratings did not survive it — undo/void/edit all reverse from that
    // snapshot, so a moved rating with no snapshot was unrecoverable in-app.
    store.faults.push({
      table: 'tournament_matches', op: 'update', message: 'could not serialize access',
      when: ({ payload }) => 'elo_snapshot' in payload,
    });

    const res = await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(res.ok).toBe(false);
    expect(match(QF).elo_snapshot).toBeNull();
    expect(ratingOf('pl-alice')).toBe(1000);
    expect(ratingOf('pl-bob')).toBe(1000);
  });

  it('leaves elo_snapshot null when nothing landed, so the match can be rated again', async () => {
    store.faults.push({ table: 'ratings', op: 'update', message: 'permission denied for table ratings' });

    const res = await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(res.ok).toBe(false);
    // An empty snapshot is still truthy JSON, and the idempotency guard reads
    // any snapshot as "already rated" — writing one here would wedge the match.
    expect(match(QF).elo_snapshot).toBeNull();
    expect(ratingOf('pl-alice')).toBe(1000);
    expect(ratingOf('pl-bob')).toBe(1000);
  });

  it('rolls the ratings back when the participant row is what fails', async () => {
    store.faults.push({
      table: 'tournament_participants', op: 'update', message: 'null value violates not-null constraint',
      when: ({ payload }) => 'elo_after' in payload,
    });

    const res = await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(res.ok).toBe(false);
    // The RPC surfaces whatever Postgres said; the label naming the individual
    // write is gone with the per-write batching, but the match id is not.
    expect(res.ok === false && res.error).toMatch(/match-qf/);
    expect(res.ok === false && res.error).toMatch(/not-null constraint/);
    // This used to snapshot both players because "ratings are the source of
    // truth and they did move". They no longer move at all.
    expect(snapshotPlayers(QF)).toEqual([]);
    expect(ratingOf('pl-alice')).toBe(1000);
  });

  it('writes a snapshot that is a superset of the shape undo/void/edit read', async () => {
    // player_id/before/after/delta are unchanged, so the snapshots already in
    // production stay readable. The statistics are added alongside them because
    // reversal now has to take those back off too.
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    const snap = match(QF).elo_snapshot as { discipline: string; entries: Row[] };
    expect(snap.discipline).toBe('singles');
    expect(snap.entries).toHaveLength(2);
    expect(Object.keys(snap.entries[0]!).sort()).toEqual([
      'after', 'before', 'delta', 'games_lost', 'games_won',
      'player_id', 'points_allowed', 'points_scored',
      // 00078 adds these two. streak_before is what makes the streak reversible
      // exactly; streak_after is what says whether doing so is still safe. Their
      // presence is also the marker that reliability_metrics was incremented.
      'streak_after', 'streak_before', 'won',
    ]);
  });
});

describe('a decided match is never left unrated', () => {
  // The result row has to be written BEFORE the rating, because rating reads the
  // winner and loser off it. So a failed rating used to leave the match
  // completed-but-unrated — and nothing could retry it: enterMatchResult refuses
  // anything that is not pending/ready/live, and the withdrawal cascade skips
  // matches that are no longer open. A missing ratings row is the case that
  // actually reaches this, and it is deterministic: every retry hits it again.
  it('takes the result back off when the rating fails, so the desk can re-enter it', async () => {
    store.db.ratings = store.db.ratings!.filter((r) => r.player_id !== 'pl-bob');

    const res = await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/No ratings row for player pl-bob/);
    // The match is back where it started, not stranded on 'completed'.
    expect(match(QF).status).toBe('ready');
    expect(match(QF).winner_participant_id).toBeNull();
    expect(match(QF).loser_participant_id).toBeNull();
    expect(match(QF).scores).toBeNull();
    expect(match(QF).elo_snapshot).toBeNull();
    // ...and nothing advanced, because rating runs before advancement.
    expect(match(SF).participant_a_id).toBeNull();
  });

  it('lets the retry succeed once the cause is repaired', async () => {
    store.db.ratings = store.db.ratings!.filter((r) => r.player_id !== 'pl-bob');
    expect((await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a')).ok).toBe(false);

    store.db.ratings!.push({
      player_id: 'pl-bob', singles_elo: 1000, singles_provisional: false, singles_matches_played: 30,
    });
    const res = await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(res.ok).toBe(true);
    expect(match(QF).status).toBe('completed');
    expect(ratingOf('pl-alice')).toBe(1026);
    // Counted exactly once — the abandoned first attempt left nothing behind.
    expect(store.db.ratings!.find((r) => r.player_id === 'pl-alice')!.singles_matches_played).toBe(31);
  });

  it('does the same for a walkover, which the withdrawal cascade cannot retry either', async () => {
    store.db.ratings = store.db.ratings!.filter((r) => r.player_id !== 'pl-bob');

    const res = await enterWalkover(QF, 'a', 'Opponent did not appear');

    expect(res.ok).toBe(false);
    expect(match(QF).status).toBe('ready');
    expect(match(QF).walkover_winner ?? null).toBeNull();
    expect(match(QF).winner_participant_id).toBeNull();
    expect(match(SF).participant_a_id).toBeNull();
  });

  it('refuses a result written over a match that changed underneath it', async () => {
    // The race closed at its source. Two desks both read a playable match and
    // both pass the status check; without a compare-and-swap both then WRITE a
    // result and both go on to rate it, and the loser only finds out inside the
    // rating RPC — by which point it has already stamped its own scores over the
    // winner's. Conditioning the write on the status this request read means the
    // loser writes nothing at all.
    //
    // Modelled by moving the match on between the read and the write, which is
    // what the other desk's commit does. The hook hangs off the suspension check
    // because that read sits between the two, and it declines to fault (returns
    // false) — it is here for its side effect only.
    store.faults.push({
      table: 'tournaments', op: 'select', message: 'unused',
      when: () => { match(QF).status = 'completed'; return false; },
    });

    const res = await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/changed while you were entering the result/);
    // Nothing of this attempt survives: no scores, no winner, no rating.
    expect(match(QF).scores).toBeNull();
    expect(match(QF).winner_participant_id).toBeNull();
    expect(match(QF).elo_snapshot).toBeNull();
    expect(ratingOf('pl-alice')).toBe(1000);
  });

  it('refuses to un-decide a match that turned out to be rated after all', async () => {
    // The losing side of a two-desk race. Both read a playable match, both write
    // a result, both compute against a null snapshot; the first RPC commits and
    // the second is refused with "already rated". Rolling the result back on
    // that refusal would leave a RATED match open for entry — every rating,
    // statistic and reliability count applied, and the idempotency guard then
    // refusing every attempt to enter it again. Strictly worse than the gap the
    // compensation closes, so the write is conditional on the snapshot still
    // being null and the count is what reports that it did not fire.
    //
    // The same guard covers a response lost after Postgres committed.
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    const rated = { ...match(QF) };

    await expect(
      undoDecidedResult(createAdminClient(), QF, { ...rated, status: 'ready' }, new Error('is already rated')),
    ).rejects.toThrow(/already rated, so the result was left in place/);

    expect(match(QF).status).toBe('completed');
    expect(match(QF).winner_participant_id).toBe('p-alice');
    expect(match(QF).elo_snapshot).toEqual(rated.elo_snapshot);
    expect(ratingOf('pl-alice')).toBe(1026);
  });

  it('compensates when a prerequisite READ fails, not only the rating write', async () => {
    // applyTournamentMatchElo used to return quietly when one of its own reads
    // came back with an error — reporting the match as rated when nothing was.
    // Nothing threw, so the compensation never fired and the caller went on to
    // advance the winner: a decided, unrated match with a bracket built on it.
    store.faults.push({ table: 'ratings', op: 'select', message: 'permission denied for table ratings' });

    const res = await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/Could not read current ratings/);
    expect(match(QF).status).toBe('ready');
    expect(match(QF).elo_snapshot).toBeNull();
    expect(match(SF).participant_a_id).toBeNull();
  });

  it('tells the exec a failed CORRECTION is safe to repeat, and proves it is', async () => {
    // editMatchResult cannot be compensated the way entry is: by the time it
    // rates, the old rating has been reversed and the scoreline it came from
    // overwritten, so there is nothing to put back. Going forward is the only
    // route and it is safe — but only if the exec knows that pressing Save again
    // will not double the delta.
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    store.faults.push({ table: 'ratings', op: 'select', message: 'deadlock detected' });
    const failed = await editMatchResult(QF, [{ a: 15, b: 21 }, { a: 17, b: 21 }], 'b', 'Scores read off the wrong sheet');
    expect(failed.ok).toBe(false);
    expect(failed.ok === false && failed.error).toMatch(/WAS saved but is not yet rated/);

    // The correction is on the row; the rating is not, and the snapshot is clear.
    expect(match(QF).winner_participant_id).toBe('p-bob');
    expect(match(QF).elo_snapshot).toBeNull();

    store.faults = [];
    expect((await editMatchResult(QF, [{ a: 15, b: 21 }, { a: 17, b: 21 }], 'b', 'Retry')).ok).toBe(true);

    // Rated once, for the corrected result — not once per attempt.
    expect(ratingOf('pl-bob')).toBe(1026);
    expect(ratingOf('pl-alice')).toBe(974);
    const alice = store.db.ratings!.find((r) => r.player_id === 'pl-alice')!;
    expect(alice.singles_matches_played).toBe(31);
    expect(alice.singles_losses).toBe(1);
    expect(alice.singles_wins).toBe(0);
    expect(store.db.reliability_metrics!.find((r) => r.player_id === 'pl-alice')!.matches_completed).toBe(6);
  });

  it('says so plainly when the result cannot be taken back off either', async () => {
    // The compensating write is a PostgREST write like any other. If it fails
    // too, the match really is decided and unrated, and the message has to say
    // that rather than "rating failed, try again" — which the exec would.
    store.db.ratings = store.db.ratings!.filter((r) => r.player_id !== 'pl-bob');
    store.faults.push({
      table: 'tournament_matches', op: 'update', message: 'deadlock detected',
      when: ({ payload }) => payload.status === 'ready',
    });

    const res = await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/decided but UNRATED/);
    expect(res.ok === false && res.error).toMatch(/No ratings row for player pl-bob/);
  });
});

describe('reliability metrics count tournament matches', () => {
  // apply_match_result has always incremented matches_completed for a confirmed
  // challenge; the tournament path never did, so the console's "Matches
  // Completed" figure and the player's own /my-stats page counted challenges
  // only, however many tournament rounds they played.
  function completed(playerId: string) {
    return store.db.reliability_metrics!.find((r) => r.player_id === playerId)!.matches_completed;
  }

  it('counts a tournament result for both players', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(completed('pl-alice')).toBe(6);
    expect(completed('pl-bob')).toBe(6);
  });

  it('counts a walkover too — it is still a match that resolved', async () => {
    await enterWalkover(QF, 'a', 'Opponent did not appear');

    expect(completed('pl-alice')).toBe(6);
  });

  it('takes the count back off when the match is voided', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    await voidMatch(QF, 'Court collapsed');

    expect(completed('pl-alice')).toBe(5);
    expect(completed('pl-bob')).toBe(5);
  });

  it('does not double-count a corrected result', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    await editMatchResult(QF, [{ a: 15, b: 21 }, { a: 17, b: 21 }], 'b', 'Winner recorded on the wrong side');

    expect(completed('pl-alice')).toBe(6);
    expect(completed('pl-bob')).toBe(6);
  });

  it('leaves the count alone for a 00070-era snapshot, which never incremented it', async () => {
    // 00070 is already applied in production, so snapshots with statistics but no
    // streak_before exist. Their matches never touched reliability_metrics, and
    // decrementing on the way out would subtract a challenge somebody played.
    match(QF).status = 'completed';
    match(QF).winner_participant_id = 'p-alice';
    match(QF).loser_participant_id = 'p-bob';
    match(QF).elo_snapshot = {
      discipline: 'singles',
      entries: [{
        player_id: 'pl-alice', before: 1000, after: 1026, delta: 26,
        won: true, points_scored: 42, points_allowed: 32, games_won: 2, games_lost: 0,
      }],
    };
    Object.assign(store.db.ratings!.find((r) => r.player_id === 'pl-alice')!, {
      singles_elo: 1026, singles_matches_played: 31, singles_wins: 1,
      singles_points_scored: 42, current_singles_streak: 1,
    });

    expect((await voidMatch(QF, '00070-era row')).ok).toBe(true);

    // The statistics still reverse...
    expect(ratingOf('pl-alice')).toBe(1000);
    expect(store.db.ratings!.find((r) => r.player_id === 'pl-alice')!.singles_matches_played).toBe(30);
    // ...but the counter this snapshot never touched is left where it was.
    expect(completed('pl-alice')).toBe(5);
  });
});

describe('winner must agree with the scores', () => {
  // Finding #1: enterMatchResult validated that the GAME COUNT was legal but
  // never compared the caller's winnerSide with it. The dialog derives the
  // winner correctly, so this is only reachable by invoking the server action
  // directly — which is exactly why the server action has to check.
  it('refuses a 2-0 recorded for the side that lost both games', async () => {
    const res = await enterMatchResult(QF, [{ a: 21, b: 10 }, { a: 21, b: 12 }], 'b');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/winner_side does not match game scores/);
    // Nothing about the match may have moved: no stored winner, no Elo, no
    // advancement into the semi-final.
    expect(match(QF).status).toBe('ready');
    expect(match(QF).winner_participant_id).toBeNull();
    expect(match(QF).elo_snapshot).toBeNull();
    expect(ratingOf('pl-alice')).toBe(1000);
    expect(ratingOf('pl-bob')).toBe(1000);
    expect(match(SF).participant_a_id).toBeNull();
  });

  it('still accepts the result when the declared winner is the side that won', async () => {
    // Guards the fix against over-rejection — the check must not break the
    // normal path the dialog drives.
    const res = await enterMatchResult(QF, [{ a: 21, b: 10 }, { a: 21, b: 12 }], 'a');

    expect(res.ok).toBe(true);
    expect(match(QF).winner_participant_id).toBe('p-alice');
    expect(match(SF).participant_a_id).toBe('p-alice');
  });

  it('still lets a scoreless walkover be corrected', async () => {
    // A walkover's winner comes from the forfeit, not a scoreline, and
    // editMatchResult explicitly re-rates one. Rejecting an empty score list as
    // a 0-0 tie would take away the only way to fix a walkover awarded to the
    // wrong side, so the check has to skip a match with no games.
    expect((await enterWalkover(QF, 'a', 'Opponent did not appear')).ok).toBe(true);
    expect(match(QF).winner_participant_id).toBe('p-alice');

    expect((await editMatchResult(QF, [], 'b', 'Awarded to the wrong side')).ok).toBe(true);

    expect(match(QF).winner_participant_id).toBe('p-bob');
    expect(match(QF).loser_participant_id).toBe('p-alice');
  });

  it('refuses through editMatchResult too — the same hole on the correction path', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 10 }, { a: 21, b: 12 }], 'a');
    const aliceAfterWin = ratingOf('pl-alice');

    const res = await editMatchResult(QF, [{ a: 21, b: 10 }, { a: 21, b: 12 }], 'b', 'Trying to flip the winner');
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/winner_side does not match game scores/);

    // Refused before the snapshot was reversed, so the applied result is intact.
    expect(match(QF).winner_participant_id).toBe('p-alice');
    expect(ratingOf('pl-alice')).toBe(aliceAfterWin);
  });
});

describe('tournament matches update the whole ratings row', () => {
  // Finding #2, the one with confirmed live divergence: the tournament path
  // moved singles_elo and nothing else, so stored match counts were lower than
  // the real regular-plus-tournament counts.
  function rating(playerId: string) {
    return store.db.ratings!.find((r) => r.player_id === playerId)!;
  }

  it('increments matches played, wins and losses', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(rating('pl-alice').singles_matches_played).toBe(31);
    expect(rating('pl-bob').singles_matches_played).toBe(31);
    expect(rating('pl-alice').singles_wins).toBe(1);
    expect(rating('pl-alice').singles_losses).toBe(0);
    expect(rating('pl-bob').singles_wins).toBe(0);
    expect(rating('pl-bob').singles_losses).toBe(1);
  });

  it('sums points and games onto the right side of the match', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(rating('pl-alice').singles_points_scored).toBe(42);
    expect(rating('pl-alice').singles_points_allowed).toBe(32);
    expect(rating('pl-alice').singles_games_won).toBe(2);
    expect(rating('pl-alice').singles_games_lost).toBe(0);
    // The loser's figures are the exact mirror — a transposed side here would
    // credit the loser with the winner's points.
    expect(rating('pl-bob').singles_points_scored).toBe(32);
    expect(rating('pl-bob').singles_points_allowed).toBe(42);
    expect(rating('pl-bob').singles_games_won).toBe(0);
    expect(rating('pl-bob').singles_games_lost).toBe(2);
  });

  it('attributes points correctly when side B is the winner', async () => {
    // The mirror of the case above. statsForSide is keyed off which physical
    // slot the winner occupies, and getting it backwards is invisible whenever
    // side A happens to win.
    await enterMatchResult(QF, [{ a: 15, b: 21 }, { a: 17, b: 21 }], 'b');

    expect(rating('pl-bob').singles_points_scored).toBe(42);
    expect(rating('pl-bob').singles_games_won).toBe(2);
    expect(rating('pl-alice').singles_points_scored).toBe(32);
    expect(rating('pl-alice').singles_games_lost).toBe(2);
  });

  it('moves the current streak, up for the winner and down for the loser', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(rating('pl-alice').current_singles_streak).toBe(1);
    expect(rating('pl-bob').current_singles_streak).toBe(-1);
  });

  it('clears the provisional flag on the match that reaches the threshold', async () => {
    // The specific consequence the review names: a player with eight tournament
    // singles matches stayed provisional forever AND kept drawing the placement
    // K-factor, because that K is chosen from the same count that never moved.
    for (const p of ['pl-alice', 'pl-bob']) {
      Object.assign(rating(p), { singles_matches_played: 7, singles_provisional: true });
    }

    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(rating('pl-alice').singles_matches_played).toBe(8);
    expect(rating('pl-alice').singles_provisional).toBe(false);
    expect(rating('pl-bob').singles_provisional).toBe(false);
  });

  it('leaves a player short of the threshold provisional', async () => {
    for (const p of ['pl-alice', 'pl-bob']) {
      Object.assign(rating(p), { singles_matches_played: 3, singles_provisional: true });
    }

    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(rating('pl-alice').singles_matches_played).toBe(4);
    expect(rating('pl-alice').singles_provisional).toBe(true);
  });

  it('takes the statistics back off when the match is voided', async () => {
    // Counterpart to the increments above. Once a tournament match moves the
    // counts, a reversal that only moved the Elo would leave a result in the
    // statistics that no longer exists anywhere else.
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    expect((await voidMatch(QF, 'Court collapsed')).ok).toBe(true);

    expect(rating('pl-alice').singles_matches_played).toBe(30);
    expect(rating('pl-alice').singles_wins).toBe(0);
    expect(rating('pl-alice').singles_points_scored).toBe(0);
    expect(rating('pl-alice').singles_games_won).toBe(0);
    expect(rating('pl-alice').current_singles_streak).toBe(0);
    expect(ratingOf('pl-alice')).toBe(1000);
    expect(rating('pl-bob').singles_matches_played).toBe(30);
    expect(rating('pl-bob').singles_losses).toBe(0);
  });

  it('makes a player provisional again when the undo drops them below the threshold', async () => {
    // The mirror of clearing the flag. Without this, one entered-then-voided
    // match would permanently establish a player who has played 7.
    for (const p of ['pl-alice', 'pl-bob']) {
      Object.assign(rating(p), { singles_matches_played: 7, singles_provisional: true });
    }

    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    expect(rating('pl-alice').singles_provisional).toBe(false);

    await voidMatch(QF, 'Wrong court');

    expect(rating('pl-alice').singles_matches_played).toBe(7);
    expect(rating('pl-alice').singles_provisional).toBe(true);
  });

  it('does not double-count the statistics when a result is corrected', async () => {
    // editMatchResult reverses the snapshot and then RE-rates the match. Before
    // the reversal learned to move the counts, every correction added a second
    // matches_played, a second win, and a second set of points.
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    await editMatchResult(QF, [{ a: 15, b: 21 }, { a: 17, b: 21 }], 'b', 'Scoresheet transcribed backwards');

    expect(rating('pl-alice').singles_matches_played).toBe(31);
    expect(rating('pl-bob').singles_matches_played).toBe(31);
    // The corrected result, not the sum of both.
    expect(rating('pl-alice').singles_wins).toBe(0);
    expect(rating('pl-alice').singles_losses).toBe(1);
    expect(rating('pl-bob').singles_wins).toBe(1);
    expect(rating('pl-bob').singles_losses).toBe(0);
    expect(rating('pl-bob').singles_points_scored).toBe(42);
    expect(rating('pl-alice').singles_points_scored).toBe(32);
  });

  it('leaves a pre-00070 snapshot\'s statistics alone when reversing it', async () => {
    // The three snapshots already in production have no `won` key, and their
    // matches never touched the counts. Reversing one must not deduct
    // statistics this match never added.
    Object.assign(rating('pl-alice'), { singles_matches_played: 30, singles_wins: 12 });
    match(QF).status = 'completed';
    match(QF).winner_participant_id = 'p-alice';
    match(QF).loser_participant_id = 'p-bob';
    match(QF).elo_snapshot = {
      discipline: 'singles',
      entries: [{ player_id: 'pl-alice', before: 1000, after: 1026, delta: 26 }],
    };
    store.db.ratings!.find((r) => r.player_id === 'pl-alice')!.singles_elo = 1026;

    expect((await voidMatch(QF, 'Legacy row')).ok).toBe(true);

    expect(ratingOf('pl-alice')).toBe(1000);          // Elo still reverses
    expect(rating('pl-alice').singles_matches_played).toBe(30); // counts untouched
    expect(rating('pl-alice').singles_wins).toBe(12);
  });

  it('records a walkover as a played match with no points or games', async () => {
    // A walkover carries no scores, exactly like a challenge walkover carries no
    // match_games rows. It still counts as a match played.
    const res = await enterWalkover(QF, 'a', 'Opponent did not appear');

    expect(res.ok).toBe(true);
    expect(rating('pl-alice').singles_matches_played).toBe(31);
    expect(rating('pl-alice').singles_wins).toBe(1);
    expect(rating('pl-alice').singles_points_scored).toBe(0);
    expect(rating('pl-alice').singles_games_won).toBe(0);
  });
});

describe('Elo reversal', () => {
  // These two replace a pair that asserted the old PARTIAL-reversal machinery:
  // the reversal ran as a batch of PostgREST writes, so one player's delta could
  // come off while the other's did not, and the mitigation was to write the
  // un-reversed entries back onto the snapshot and retry the remainder. That
  // shape is what made a double-reverse possible in the first place — the
  // reduced-snapshot write was a SEPARATE round trip, and when it failed the
  // ORIGINAL snapshot survived with every delta already gone, so the next
  // attempt subtracted them again. Since 00070 the statistics travel with the
  // Elo, so the second subtraction also strips a matches_played, a win, and a
  // set of points and games the match never added.
  //
  // reverse_tournament_match_rating (00078) does the whole reversal in one
  // transaction, so a partial reversal is unreachable and the assertions below
  // are the corrected invariant: all or nothing, and a retry reverses once.

  it('leaves every rating and the snapshot untouched when the reversal fails', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    const aliceApplied = ratingOf('pl-alice');
    const bobApplied = ratingOf('pl-bob');

    store.faults.push({
      table: 'ratings', op: 'update', message: 'permission denied for table ratings',
      when: ({ filters }) => filters.some(([c, v]) => c === 'player_id' && v === 'pl-alice'),
    });

    const res = await voidMatch(QF, 'Court collapsed');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/NOTHING was reversed/);
    // Previously Bob's half DID reverse while Alice's did not, and the snapshot
    // was rewritten to hold Alice alone. Now neither moves.
    expect(ratingOf('pl-alice')).toBe(aliceApplied);
    expect(ratingOf('pl-bob')).toBe(bobApplied);
    expect(match(QF).status).toBe('completed');   // so the void did not happen
    // The snapshot is intact — not reduced — so a retry reverses the whole
    // match and there is no entry that has already come off the ladder.
    expect(snapshotPlayers(QF)).toEqual(['pl-alice', 'pl-bob']);
    for (const p of ['pl-alice', 'pl-bob']) {
      expect(store.db.ratings!.find((r) => r.player_id === p)!.singles_matches_played).toBe(31);
    }
  });

  it('reverses exactly once when the void is retried', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    store.faults.push({
      table: 'ratings', op: 'update', message: 'deadlock detected',
      when: ({ filters }) => filters.some(([c, v]) => c === 'player_id' && v === 'pl-alice'),
    });
    expect((await voidMatch(QF, 'first attempt')).ok).toBe(false);

    store.faults = [];
    const res = await voidMatch(QF, 'second attempt');

    expect(res.ok).toBe(true);
    expect(ratingOf('pl-alice')).toBe(1000);
    expect(ratingOf('pl-bob')).toBe(1000);
    expect(match(QF).elo_snapshot).toBeNull();
    expect(match(QF).status).toBe('voided');
    for (const p of ['pl-alice', 'pl-bob']) {
      const row = store.db.ratings!.find((r) => r.player_id === p)!;
      expect(row.singles_matches_played).toBe(30);
      expect(row.singles_points_scored).toBe(0);
    }
    expect(store.db.ratings!.find((r) => r.player_id === 'pl-alice')!.singles_wins).toBe(0);
    expect(store.db.ratings!.find((r) => r.player_id === 'pl-bob')!.singles_losses).toBe(0);
    expect(store.db.reliability_metrics!.find((r) => r.player_id === 'pl-alice')!.matches_completed).toBe(5);
  });

  it('is a no-op the second time, rather than subtracting the deltas twice', async () => {
    // The failure this whole change exists to prevent, reduced to its core: the
    // snapshot and the reversal commit together, so a match with nothing left to
    // reverse reverses nothing. Before 00078 a surviving snapshot over
    // already-reversed ratings sent the second attempt through the same
    // subtraction again — Elo, match count, wins, points and games all.
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    await reverseEloSnapshot(createAdminClient(), QF);
    await reverseEloSnapshot(createAdminClient(), QF);
    await reverseEloSnapshot(createAdminClient(), QF);

    const alice = store.db.ratings!.find((r) => r.player_id === 'pl-alice')!;
    expect(alice.singles_elo).toBe(1000);
    expect(alice.singles_matches_played).toBe(30);
    expect(alice.singles_wins).toBe(0);
    expect(alice.singles_points_scored).toBe(0);
    expect(store.db.reliability_metrics!.find((r) => r.player_id === 'pl-alice')!.matches_completed).toBe(5);
  });
});

describe('current streak survives an undo', () => {
  // Reversal used to step the streak one toward zero and stop, because nothing
  // recorded where it had been. A player on a three-match losing run who won and
  // had that win undone came out on 0 — their losing run erased.
  function streak(playerId: string) {
    return store.db.ratings!.find((r) => r.player_id === playerId)!.current_singles_streak;
  }

  it('restores a losing run exactly, instead of leaving the player on zero', async () => {
    Object.assign(store.db.ratings!.find((r) => r.player_id === 'pl-alice')!, { current_singles_streak: -3 });

    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    expect(streak('pl-alice')).toBe(1); // a win resets the run and starts a new one

    expect((await voidMatch(QF, 'Wrong court')).ok).toBe(true);

    expect(streak('pl-alice')).toBe(-3); // was 0 before 00078
  });

  it('restores a winning run for the loser of the undone match', async () => {
    Object.assign(store.db.ratings!.find((r) => r.player_id === 'pl-bob')!, { current_singles_streak: 6 });

    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    expect(streak('pl-bob')).toBe(-1);

    await voidMatch(QF, 'Wrong court');

    expect(streak('pl-bob')).toBe(6); // was 0 before 00078
  });

  it('steps toward zero instead when a later match has moved the streak since', async () => {
    // The exactness is only safe while the undone match is still the player's
    // most recent rated one. Otherwise restoring the stored value would erase
    // every result played in between, which is worse than the old imprecision —
    // so the stored streak_after is compared with what is actually in the row.
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    expect(streak('pl-alice')).toBe(1);

    // Alice wins again somewhere else.
    Object.assign(store.db.ratings!.find((r) => r.player_id === 'pl-alice')!, { current_singles_streak: 2 });

    await voidMatch(QF, 'Scoresheet lost');

    expect(streak('pl-alice')).toBe(1);
  });

  it('KNOWN BOUND: restores anyway when later matches happen to land on the same streak', async () => {
    // Pinning a limitation, not asserting a desirable outcome. The "is this
    // still their most recent rated match" test is streak equality, and streak
    // values repeat: a win to +1, a loss to -1, a win back to +1 puts the row
    // back on the stored streak_after, and the restore then rewinds over both
    // later matches. Telling that apart needs a per-match streak ledger, which
    // is a bigger change than 00078; the pre-00078 step-toward-zero was wrong
    // here too, just differently. Only current_*_streak is affected — the Elo,
    // the counts and the reliability figure all reverse from the entry's own
    // numbers and are unaffected.
    Object.assign(store.db.ratings!.find((r) => r.player_id === 'pl-alice')!, { current_singles_streak: -3 });

    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    expect(streak('pl-alice')).toBe(1);

    // Two later matches elsewhere: a loss, then a win — back on 1.
    Object.assign(store.db.ratings!.find((r) => r.player_id === 'pl-alice')!, { current_singles_streak: 1 });

    await voidMatch(QF, 'Scoresheet lost');

    // Ideally 1 (the two later matches from a base of -3). Documented as -3.
    expect(streak('pl-alice')).toBe(-3);
  });

  it('leaves a pre-00070 snapshot\'s streak alone entirely', async () => {
    // No `won` key means the match never moved the statistics at all, streak
    // included. Three such rows are live in production.
    Object.assign(store.db.ratings!.find((r) => r.player_id === 'pl-alice')!, {
      singles_elo: 1026, current_singles_streak: 4,
    });
    match(QF).status = 'completed';
    match(QF).winner_participant_id = 'p-alice';
    match(QF).loser_participant_id = 'p-bob';
    match(QF).elo_snapshot = {
      discipline: 'singles',
      entries: [{ player_id: 'pl-alice', before: 1000, after: 1026, delta: 26 }],
    };

    expect((await voidMatch(QF, 'Legacy row')).ok).toBe(true);

    expect(ratingOf('pl-alice')).toBe(1000);
    expect(streak('pl-alice')).toBe(4);
  });

  it('steps toward zero for a 00070-era snapshot, which carries no prior streak', async () => {
    // The middle tier: statistics were applied, so they must reverse, but the
    // prior streak was never recorded and cannot be invented.
    Object.assign(store.db.ratings!.find((r) => r.player_id === 'pl-alice')!, {
      singles_elo: 1026, singles_matches_played: 31, singles_wins: 1, current_singles_streak: 1,
    });
    match(QF).status = 'completed';
    match(QF).winner_participant_id = 'p-alice';
    match(QF).loser_participant_id = 'p-bob';
    match(QF).elo_snapshot = {
      discipline: 'singles',
      entries: [{
        player_id: 'pl-alice', before: 1000, after: 1026, delta: 26,
        won: true, points_scored: 42, points_allowed: 32, games_won: 2, games_lost: 0,
      }],
    };

    expect((await voidMatch(QF, '00070-era row')).ok).toBe(true);

    expect(ratingOf('pl-alice')).toBe(1000);
    expect(store.db.ratings!.find((r) => r.player_id === 'pl-alice')!.singles_matches_played).toBe(30);
    expect(streak('pl-alice')).toBe(0);
  });
});

describe('sweep margin multiplier', () => {
  // apply_match_result passes get_margin_multiplier(games_won, games_lost) for
  // every challenge; this path passed nothing. K=36, format weight 1.25,
  // event multiplier 1, both players on 1000 so expected = 0.5:
  //   went the distance -> round(36 * 1.25 * 0.5)        = 23
  //   clean sweep       -> round(36 * 1.25 * 1.15 * 0.5) = 26
  it('leaves a match that went the distance unscaled', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 17, b: 21 }, { a: 21, b: 18 }], 'a');

    expect(ratingOf('pl-alice')).toBe(1023);
    expect(ratingOf('pl-bob')).toBe(977);
  });

  it('scales a 2-0 by the sweep multiplier, the way a challenge already did', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(ratingOf('pl-alice')).toBe(1026);
    expect(ratingOf('pl-bob')).toBe(974);
  });

  it('scales the loser by the same factor — a sweep is a sweep for both sides', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    const gained = ratingOf('pl-alice') - 1000;
    const lost = 1000 - ratingOf('pl-bob');
    // Asymmetry here would inject net rating into the ladder.
    expect(gained).toBe(lost);
  });

  it('reads sweep_margin_multiplier from platform_settings, not the constant', async () => {
    setRatingDefault('sweep_margin_multiplier', 2);

    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(ratingOf('pl-alice')).toBe(1045); // round(36 * 1.25 * 2 * 0.5)
  });

  it('bounds a wild setting to 2.0, matching get_margin_multiplier in SQL', async () => {
    setRatingDefault('sweep_margin_multiplier', 50);

    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(ratingOf('pl-alice')).toBe(1045);
  });
});

describe('finalizeEvent', () => {
  // A one-match event: the semi is removed so the final IS the whole draw.
  beforeEach(async () => {
    store.db.tournament_matches = [match(QF)];
    match(QF).winner_to_match_id = null;
    match(QF).winner_to_position = null;
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
  });

  it('leaves the event live when a final_position write fails, so it can be retried', async () => {
    store.faults.push({
      table: 'tournament_participants', op: 'update', message: 'permission denied for table tournament_participants',
      when: ({ payload }) => payload.final_position === 2,
    });

    await expect(finalizeEvent('e1')).rejects.toThrow(/final_position/);

    // The old code flipped the event to completed regardless, and finalizeEvent
    // refuses anything that is not live — so a half-positioned event could not
    // be repaired from the console at all.
    expect(event().status).toBe('live');
    expect(participant('p-alice').final_position).toBe(1);
    expect(participant('p-bob').final_position).toBeNull();
  });

  it('finishes the job on retry, because positions and points are absolute writes', async () => {
    store.faults.push({
      table: 'tournament_participants', op: 'update', message: 'deadlock detected',
      when: ({ payload }) => payload.final_position === 2,
    });
    await expect(finalizeEvent('e1')).rejects.toThrow();

    store.faults = [];
    await finalizeEvent('e1');

    expect(event().status).toBe('completed');
    expect(participant('p-alice').final_position).toBe(1);
    expect(participant('p-bob').final_position).toBe(2);
    expect(participant('p-alice').points).toBe(100);
    expect(participant('p-bob').points).toBe(75);
  });

  it('surfaces a failed points write without completing the event', async () => {
    store.faults.push({
      table: 'tournament_participants', op: 'update', message: 'permission denied',
      when: ({ payload }) => 'points' in payload,
    });

    await expect(finalizeEvent('e1')).rejects.toThrow(/points/);
    expect(event().status).toBe('live');
  });
});

describe('late withdrawal cascade', () => {
  // A round-robin shape: Bob owes two matches, so a rating failure on the first
  // forfeit leaves the second one still open. Single elimination cannot show
  // this — an entry only ever has one live match at a time.
  const RR1 = 'match-rr1';
  const RR2 = 'match-rr2';

  beforeEach(() => {
    event().format = 'round_robin';
    store.db.tournament_participants!.push({
      id: 'p-carol', event_id: 'e1', player_id: 'pl-carol', elo_before: 1000,
      elo_after: null, elo_change: null, final_position: null, points: null, status: 'checked_in',
    });
    store.db.ratings!.push({
      player_id: 'pl-carol', singles_elo: 1000, singles_provisional: false, singles_matches_played: 30,
    });
    store.db.tournament_matches = [
      {
        id: RR1, event_id: 'e1', status: 'ready', is_bye: false,
        participant_a_id: 'p-alice', participant_b_id: 'p-bob',
        winner_participant_id: null, loser_participant_id: null,
        winner_to_match_id: null, winner_to_position: null,
        round_number: 1, scores: null, elo_snapshot: null, notes: null,
      },
      {
        id: RR2, event_id: 'e1', status: 'ready', is_bye: false,
        participant_a_id: 'p-carol', participant_b_id: 'p-bob',
        winner_participant_id: null, loser_participant_id: null,
        winner_to_match_id: null, winner_to_position: null,
        round_number: 2, scores: null, elo_snapshot: null, notes: null,
      },
    ];
  });

  it('stops the cascade on a failed rating write and lets a retry finish it', async () => {
    store.faults.push({
      table: 'ratings', op: 'update', message: 'permission denied for table ratings',
      when: ({ filters }) => filters.some(([c, v]) => c === 'player_id' && v === 'pl-alice'),
    });

    const first = await withdrawParticipant('p-bob', 'Sprained ankle');
    expect(first.ok).toBe(false);

    // Bob is out, but NEITHER match was forfeited: the first one's rating failed,
    // and recordWalkover now takes the walkover back off rather than leaving a
    // forfeited-but-unrated match that no later action could reach — the cascade
    // skips anything that is no longer open, so it would have been stranded.
    expect(participant('p-bob').status).toBe('withdrawn');
    expect(match(RR1).status).toBe('ready');
    expect(match(RR1).walkover_winner ?? null).toBeNull();
    expect(match(RR2).status).toBe('ready');

    store.faults = [];
    const second = await withdrawParticipant('p-bob', 'Sprained ankle');

    // The old guard refused this outright with "Already withdrawn", leaving the
    // remaining matches live against someone who had gone home. Now the retry
    // forfeits BOTH — including the one the failed attempt rolled back.
    expect(second.ok).toBe(true);
    expect(second.ok === true && second.data.forfeited).toBe(2);
    expect(match(RR1).status).toBe('walkover');
    expect(match(RR2).status).toBe('walkover');
    // Rated exactly once each, not once per attempt.
    expect(store.db.ratings!.find((r) => r.player_id === 'pl-alice')!.singles_matches_played).toBe(31);
    expect(store.db.ratings!.find((r) => r.player_id === 'pl-bob')!.singles_matches_played).toBe(32);
  });

  it('still refuses a plain second press when there is nothing left to forfeit', async () => {
    await withdrawParticipant('p-bob', 'Sprained ankle');

    const again = await withdrawParticipant('p-bob', 'Sprained ankle');
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.error).toMatch(/already withdrawn/i);
  });
});

describe('placement bonuses', () => {
  beforeEach(() => {
    event().status = 'completed';
    event().placement_bonus_enabled = true;
    participant('p-alice').final_position = 1;
    participant('p-bob').final_position = 2;
  });

  it('clamps to the configured ceiling, not the hardcoded 1500', async () => {
    // Live max_elo is 3001. With the hardcoded bound this player would be
    // pushed DOWN to 1500 by winning the event.
    store.db.ratings!.find((r) => r.player_id === 'pl-alice')!.singles_elo = 2000;

    await applyPlacementBonuses('e1');

    expect(ratingOf('pl-alice')).toBe(2032); // champion bonus is 32
  });

  it('still clamps at the configured ceiling', async () => {
    setRatingDefault('max_elo', 1200);
    store.db.ratings!.find((r) => r.player_id === 'pl-alice')!.singles_elo = 1190;

    await applyPlacementBonuses('e1');

    expect(ratingOf('pl-alice')).toBe(1200);
  });

  it('raises a partial failure and pays nobody twice when it is retried', async () => {
    store.faults.push({
      table: 'ratings', op: 'update', message: 'permission denied for table ratings',
      when: ({ filters }) => filters.some(([c, v]) => c === 'player_id' && v === 'pl-bob'),
    });

    await expect(applyPlacementBonuses('e1')).rejects.toThrow(/pl-bob/);
    expect(ratingOf('pl-alice')).toBe(1032);
    expect(ratingOf('pl-bob')).toBe(1000);

    store.faults = [];
    await applyPlacementBonuses('e1');

    // The retry finishes the job. Alice is NOT paid a second time — the read-
    // modify-write has no idempotency of its own, so the ledger has to supply it.
    expect(ratingOf('pl-alice')).toBe(1032);
    expect(ratingOf('pl-bob')).toBe(1020); // finalist bonus is 20
    expect(participant('p-alice').elo_change).toBe(32);
    expect(participant('p-bob').elo_change).toBe(20);
  });

  it('refuses to award anything when the ledger cannot be read', async () => {
    store.faults.push({ table: 'tournament_audit_log', op: 'select', message: 'permission denied' });

    await expect(applyPlacementBonuses('e1')).rejects.toThrow(/would double every rating/);
    expect(ratingOf('pl-alice')).toBe(1000);
  });

  it('warns loudly when the bonuses landed but the record of them did not', async () => {
    store.faults.push({ table: 'tournament_audit_log', op: 'insert', message: 'disk full' });

    await expect(applyPlacementBonuses('e1')).rejects.toThrow(/Do NOT re-run placement bonuses/);
  });
});

// ============================================================
// Third-place playoff (00080)
// ============================================================
//
// A 4-entry singles draw: two semi-finals feed the final with their winners and
// the playoff with their losers. Built by hand rather than by running the
// generator so each test can start from a known bracket and break exactly one
// thing about it.
const SF1 = 'm-sf1';
const SF2 = 'm-sf2';
const FINAL = 'm-final';
const THIRD = 'm-third';

function seedFourDraw() {
  const entry = (id: string, playerId: string) => ({
    id, event_id: 'e1', player_id: playerId, elo_before: 1000, elo_after: null,
    elo_change: null, final_position: null, points: null, status: 'checked_in',
  });
  const players = ['pl-alice', 'pl-bob', 'pl-cara', 'pl-dan'];
  store.db.tournament_participants = [
    entry('p-alice', 'pl-alice'), entry('p-bob', 'pl-bob'),
    entry('p-cara', 'pl-cara'), entry('p-dan', 'pl-dan'),
  ];
  store.db.ratings = players.map((player_id) => ({
    player_id, singles_elo: 1000, singles_provisional: false, singles_matches_played: 30,
  }));
  store.db.reliability_metrics = players.map((player_id) => ({ player_id, matches_completed: 5 }));

  const shell = (id: string, round: number) => ({
    id, event_id: 'e1', status: 'pending', is_bye: false, is_third_place: false,
    participant_a_id: null, participant_b_id: null,
    winner_participant_id: null, loser_participant_id: null,
    winner_to_match_id: null, winner_to_position: null,
    loser_to_match_id: null, loser_to_position: null,
    round_number: round, scores: null, elo_snapshot: null, notes: null,
  });

  store.db.tournament_matches = [
    {
      ...shell(SF1, 1), status: 'ready',
      participant_a_id: 'p-alice', participant_b_id: 'p-bob',
      winner_to_match_id: FINAL, winner_to_position: 'a',
      loser_to_match_id: THIRD, loser_to_position: 'a',
    },
    {
      ...shell(SF2, 1), status: 'ready',
      participant_a_id: 'p-cara', participant_b_id: 'p-dan',
      winner_to_match_id: FINAL, winner_to_position: 'b',
      loser_to_match_id: THIRD, loser_to_position: 'b',
    },
    shell(FINAL, 2),
    // Same round_number as the final — scheduled alongside it — and it feeds
    // nothing, so winner_to_match_id stays null.
    { ...shell(THIRD, 2), is_third_place: true },
  ];
}

// The tests below seed the finished draw by hand, which proves what the
// CORRECTIVE actions do with it but says nothing about whether the generator
// builds that shape. These two close that gap: everything after them is
// checking a fixture that this describe block proves is real.
describe('generating a draw with a third-place playoff', () => {
  function seedField(n: number) {
    store.db.tournament_matches = [];
    store.db.tournament_participants = Array.from({ length: n }, (_, i) => ({
      id: `p-${i}`, event_id: 'e1', player_id: `pl-${i}`, elo_before: 1500 - i * 10,
      elo_after: null, elo_change: null, seed_number: i + 1,
      final_position: null, points: null, status: 'checked_in',
    }));
    Object.assign(event(), { status: 'checkin', draw_locked: false });
  }
  const thirdPlaceMatches = () =>
    store.db.tournament_matches!.filter((m) => m.is_third_place);
  const roundOf = (n: number) =>
    store.db.tournament_matches!
      .filter((m) => m.round_number === n && !m.is_third_place)
      .sort((a, b) => (a.bracket_position as number) - (b.bracket_position as number));

  it('creates one playoff and points BOTH semi-finals at it, on distinct sides', async () => {
    // The wiring the hand-seeded fixtures assume. If the generator read the
    // wrong entry of matchesByRound, or gave both semi-finals the same
    // loser_to_position, every other test here would still pass while the live
    // draw sent one loser into a slot and then overwrote them with the other.
    seedField(4);

    expect((await generateSingleEliminationBracket('e1', true)).ok).toBe(true);

    const playoffs = thirdPlaceMatches();
    expect(playoffs).toHaveLength(1);
    const playoff = playoffs[0]!;

    const semis = roundOf(1);
    expect(semis).toHaveLength(2);
    expect(semis.map((m) => m.loser_to_match_id)).toEqual([playoff.id, playoff.id]);
    expect(semis.map((m) => m.loser_to_position)).toEqual(['a', 'b']);
    // Both semi-finals still feed the final with their winners.
    const final = roundOf(2)[0]!;
    expect(semis.map((m) => m.winner_to_match_id)).toEqual([final.id, final.id]);

    // The playoff feeds NOTHING. A winner_to_match_id here is the bug the whole
    // UI treatment exists to avoid claiming.
    expect(playoff.winner_to_match_id).toBeNull();
    expect(playoff.winner_to_position).toBeNull();
    // Scheduled alongside the final — same round, its own bracket position.
    expect(playoff.round_number).toBe(final.round_number);
    expect(playoff.bracket_position).not.toBe(final.bracket_position);
    expect(playoff.round_name).toBe('3rd Place Playoff');
    // Numbered after the final, so the final keeps the number it would have had
    // without this feature.
    expect(playoff.match_number as number).toBeGreaterThan(final.match_number as number);
  });

  it('builds the ordinary draw untouched when the playoff is not asked for', async () => {
    seedField(4);

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

    expect(thirdPlaceMatches()).toHaveLength(0);
    expect(roundOf(1).every((m) => m.loser_to_match_id === null || m.loser_to_match_id === undefined)).toBe(true);
    expect(store.db.tournament_matches).toHaveLength(3);
  });

  it('skips the playoff on a 2-entry draw rather than failing the generation', async () => {
    // A 2-entry draw is a final and nothing else: there is no semi-final round
    // to lose. Refusing the whole generation over a ticked box would leave the
    // exec with no draw at all, so the skip is recorded in the audit instead.
    seedField(2);

    expect((await generateSingleEliminationBracket('e1', true)).ok).toBe(true);

    expect(thirdPlaceMatches()).toHaveLength(0);
    expect(store.db.tournament_matches).toHaveLength(1);
    const audit = store.db.tournament_audit_log!.find((r) => r.action === 'bracket_generated')!;
    expect((audit.details as Row).third_place_match).toBe('skipped_no_semi_finals');
  });
});

// ============================================================
// Regenerating a draw that already exists
// ============================================================
//
// The exec-facing gap the club owner hit: "once the bracket is generated theres
// no way to regenerate a bracket." The BUTTON was the missing part
// (participant-controls.ts / EventHeader), but opening that door made a
// second-press path reachable for the first time, and it did not work.
describe('regenerating a draw that already exists', () => {
  function seedField(n: number) {
    store.db.tournament_matches = [];
    store.db.tournament_participants = Array.from({ length: n }, (_, i) => ({
      id: `p-${i}`, event_id: 'e1', player_id: `pl-${i}`, elo_before: 1500 - i * 10,
      elo_after: null, elo_change: null, seed_number: i + 1,
      final_position: null, points: null, status: 'checked_in',
    }));
    Object.assign(event(), { status: 'checkin', draw_locked: false });
  }
  const byes = () => store.db.tournament_matches!.filter((m) => m.is_bye);
  const playoffs = () => store.db.tournament_matches!.filter((m) => m.is_third_place);
  /** Round one in bracket order — the whole draw, since everything else follows. */
  const round1 = () => store.db.tournament_matches!
    .filter((m) => m.round_number === 1 && !m.is_third_place)
    .sort((a, b) => (a.bracket_position as number) - (b.bracket_position as number));
  /** The draw as one comparable string per match, for "did it change?" tests. */
  const layout = () => round1().map((m) => `${m.participant_a_id}/${m.participant_b_id}`);
  const matchIndexOf = (r1: Row[], id: string) =>
    r1.findIndex((m) => m.participant_a_id === id || m.participant_b_id === id);
  /** Which half of the draw an entrant is in: they can only meet across it in the final. */
  const halfOf = (r1: Row[], id: string) => (matchIndexOf(r1, id) < r1.length / 2 ? 0 : 1);
  /** Which quarter: two entrants sharing one must meet by the semi-finals. */
  const quarterOf = (r1: Row[], id: string) =>
    Math.floor(matchIndexOf(r1, id) / Math.max(1, r1.length / 4));

  it('lets a draw WITH BYES be redrawn — a bye is not a result', async () => {
    // THE BUG THIS FEATURE WOULD HAVE SHIPPED WITH. Generation writes
    // status:'completed' onto every bye, and assertNoResultsEntered counted
    // exactly that set of statuses, so any field that is not a power of two
    // produced a draw the guard then called "results already entered" — about
    // matches with no score, no Elo and no opponent to void. Three of the four
    // staging events sitting at bracket_generated have byes and nothing else
    // completed, so this was three refusals out of four.
    //
    // Five entries: an 8-slot draw with 3 byes.
    seedField(5);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    expect(byes().length).toBeGreaterThan(0);
    expect(event().status).toBe('bracket_generated');
    const firstIds = store.db.tournament_matches!.map((m) => m.id);

    const res = await generateSingleEliminationBracket('e1', false);

    expect(res.ok).toBe(true);
    // Genuinely rebuilt, not left alone: every match is a new row.
    const secondIds = store.db.tournament_matches!.map((m) => m.id);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
    expect(event().status).toBe('bracket_generated');
  });

  it('still refuses once a real result is in, and names why', async () => {
    // The other half of the same assertion: excluding byes must not have made
    // the guard vacuous. A played match is exactly what regeneration would
    // erase, and it is the reason the guard exists.
    seedField(4);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    const semi = store.db.tournament_matches!.find((m) => m.round_number === 1)!;
    Object.assign(semi, { status: 'completed', is_bye: false });

    const res = await generateSingleEliminationBracket('e1', false);

    expect(res.ok).toBe(false);
    // NAMES THE NUMBER. The refusal is now reachable from a live event, where
    // the exec cannot see at a glance what has been played, so "results have
    // already been entered" on a 128-match draw is not something anybody can
    // act on.
    expect(res.ok === false && res.error).toMatch(/1 match in this event has a result/);
    expect(res.ok === false && res.error).toMatch(/Byes do not count/);
    // Refused before the delete — the draw people are reading is still there.
    expect(store.db.tournament_matches!.length).toBeGreaterThan(0);
  });

  it('refuses to redraw a FINALISED knockout event', async () => {
    // 1922133 wired assertNotFinalised into the round-robin generator and not
    // this one. It matters more here, if anything: finalizeEvent reads
    // final_position off the bracket, so a completed knockout event whose
    // matches had all been voided could be redrawn on top of a placement-bonus
    // ledger that had already paid the old finishers.
    seedField(4);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    Object.assign(event(), { status: 'completed' });
    // Voided, so assertNoResultsEntered has nothing to object to — which is
    // precisely the hole: this used to be the way past the block.
    for (const m of store.db.tournament_matches!) Object.assign(m, { status: 'voided', is_bye: false });

    const res = await generateSingleEliminationBracket('e1', false);

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/finalised/);
  });

  it('refuses to redraw a locked draw', async () => {
    seedField(4);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    Object.assign(event(), { draw_locked: true });

    const res = await generateSingleEliminationBracket('e1', false);

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/Draw is locked/);
  });

  it('takes the third-place choice made at THIS regeneration, in both directions', async () => {
    // The choice is not stored on tournament_events — the generated match IS
    // the record — so the redraw has to be told, every time. A regenerate that
    // reused a stale flag would silently drop or add a bronze match that nobody
    // chose, which is why the confirm dialog asks again and pre-ticks from the
    // draw that exists.
    seedField(4);
    expect((await generateSingleEliminationBracket('e1', true)).ok).toBe(true);
    expect(playoffs()).toHaveLength(1);

    // Drop it.
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    expect(playoffs()).toHaveLength(0);

    // And add it back.
    expect((await generateSingleEliminationBracket('e1', true)).ok).toBe(true);
    expect(playoffs()).toHaveLength(1);
  });

  it('redraws from the field as it is NOW, not the one the first draw saw', async () => {
    // The usual reason to redraw. A withdrawal between bracket_generated and
    // going live is not forfeited (participants.ts defers that to go-live
    // precisely so the draw can be regenerated without it), so the entry is
    // still sitting in the bracket until somebody redraws.
    seedField(4);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    expect(store.db.tournament_matches!.filter((m) => m.round_number === 1)).toHaveLength(2);

    Object.assign(participant('p-3'), { status: 'withdrawn' });

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

    // Three left, so a 4-slot draw with one bye — and the withdrawn entry is in
    // none of it.
    const seeded = store.db.tournament_matches!.flatMap((m) => [m.participant_a_id, m.participant_b_id]);
    expect(seeded).not.toContain('p-3');
    expect(byes()).toHaveLength(1);
  });

  // ------------------------------------------------------------
  // REDRAWING A LIVE EVENT
  // ------------------------------------------------------------
  //
  // The owner pressed "Start Tournament" and the Regenerate button vanished
  // with no way back. Three of the four events sitting at `live` on staging
  // have nothing played at all, so this is the common live event and not a
  // corner of one.

  it('REDRAWS A LIVE EVENT AND LEAVES IT LIVE', async () => {
    // THE BUG THIS FEATURE WOULD HAVE SHIPPED WITH, and it is not in the guard.
    // Both generators ended with an unconditional
    // `.update({ status: 'bracket_generated' })`, which was the forward step
    // while the only caller was the check-in press. Reached from a live event
    // it becomes the only write in the console that sends an event BACKWARDS:
    // the header's primary button reverts from "Finalize Tournament" to "Start
    // Tournament", and pressing it re-runs the go-live forfeit sweep.
    // setEventStatus's transition table is forward-only precisely so that
    // cannot happen, and this went around it.
    seedField(5);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    Object.assign(event(), { status: 'live' });
    const firstIds = store.db.tournament_matches!.map((m) => m.id);

    const res = await generateSingleEliminationBracket('e1', false);

    expect(res.ok).toBe(true);
    expect(event().status).toBe('live');
    // Genuinely rebuilt, not quietly skipped: every match is a new row.
    const secondIds = store.db.tournament_matches!.map((m) => m.id);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
    // ...and the byes came back, so the guard did not mistake them for results
    // on the way through.
    expect(byes().length).toBeGreaterThan(0);
  });

  it('leaves a live round robin live too', async () => {
    // The same unconditional write sat at the bottom of the other generator.
    Object.assign(event(), { format: 'round_robin' });
    seedField(4);
    Object.assign(event(), { format: 'round_robin' });
    expect((await generateRoundRobinMatches('e1')).ok).toBe(true);
    Object.assign(event(), { status: 'live' });

    expect((await generateRoundRobinMatches('e1')).ok).toBe(true);

    expect(event().status).toBe('live');
  });

  it('still refuses a live event the moment anything has been played', async () => {
    // The status is not the authority — the match rows are. A live event with a
    // real result must refuse exactly as a bracket_generated one does, and
    // nothing may be deleted on the way to the refusal.
    seedField(4);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    Object.assign(event(), { status: 'live' });
    const played = store.db.tournament_matches!.find((m) => m.round_number === 1)!;
    Object.assign(played, { status: 'completed', is_bye: false });
    const before = store.db.tournament_matches!.length;

    const res = await generateSingleEliminationBracket('e1', false);

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/1 match in this event has a result/);
    expect(store.db.tournament_matches!).toHaveLength(before);
    expect(event().status).toBe('live');
  });

  it('refuses a live event that has a WALKOVER, which the go-live sweep records', async () => {
    // A walkover is rated (recordWalkover -> applyTournamentMatchElo), so it is
    // a result in every sense that matters here even though nobody played. This
    // is the case the old "never at live" rule was written around, and it is
    // still refused — it is just no longer the reason to hide the button.
    seedField(4);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    Object.assign(event(), { status: 'live' });
    const m = store.db.tournament_matches!.find((x) => x.round_number === 1)!;
    Object.assign(m, { status: 'walkover', is_bye: false });

    const res = await generateSingleEliminationBracket('e1', false);

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/1 match in this event has a result/);
  });

  /**
   * THE LIVE REDRAW THAT HAS REAL CONTENT, and the reason a partial redraw was
   * not built instead of this.
   *
   * An entrant with a first-round BYE withdraws once the event is live. The
   * forfeit sweep cannot settle them: their only open match is the round-two
   * one, whose other slot is still TBD, so forfeitOpenMatchesForEntry counts it
   * `unresolved` and writes nothing (there is nobody to award a walkover to).
   * The event is therefore live, has a withdrawal, and has NO result rows —
   * so the guard permits the redraw, and the redraw is the only thing that can
   * take them out of the bracket.
   *
   * A partial redraw — hold the played matches, reshuffle the rest — could not
   * have done this. It has to preserve the bracket's shape, so it can permute
   * entrants between open slots but cannot remove one; the withdrawn entry
   * would have stayed in the draw with a free pass to round two.
   */
  it('drops an entrant who withdrew from a LIVE event without leaving a result behind', async () => {
    // Five entries: an 8-slot draw, so the top seeds have byes.
    seedField(5);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    Object.assign(event(), { status: 'live' });
    // The top seed — seeded first, so it is the one holding a bye.
    const bye = byes()[0]!;
    const withdrawing = (bye.participant_a_id ?? bye.participant_b_id) as string;
    Object.assign(participant(withdrawing), { status: 'withdrawn' });
    // No walkover was recorded: this is the state the sweep leaves behind.
    expect(store.db.tournament_matches!.some((m) => m.status === 'walkover')).toBe(false);

    const res = await generateSingleEliminationBracket('e1', false);

    expect(res.ok).toBe(true);
    expect(event().status).toBe('live');
    // Four left, so a 4-slot draw — and the withdrawn entry is nowhere in it.
    const seeded = store.db.tournament_matches!.flatMap((m) => [m.participant_a_id, m.participant_b_id]);
    expect(seeded).not.toContain(withdrawing);
    expect(store.db.tournament_matches!.filter((m) => m.round_number === 1)).toHaveLength(2);
    expect(byes()).toHaveLength(0);
  });

  /**
   * EVERY ENTRANT IS IN THE DRAW, whatever numbers they are carrying.
   *
   * The bug the test above uncovered. Seeds are never renumbered when somebody
   * leaves, and the placement loop looked entrants up BY STORED SEED against
   * getStandardSeedPositions, which only ever emits 1..bracketSize. Withdraw
   * the top seed of a 5-entry event and the survivors are seeds 2,3,4,5 in a
   * 4-slot draw: seed 5 was never looked up and that player disappeared from
   * their own event, seed 1 was looked up and found nothing and left a phantom
   * bye. Nothing anywhere said so — the draw simply had one fewer person in it.
   *
   * The assertion that matters is the FIELD, not the shape: every entry that is
   * still in the event appears exactly once in round one.
   */
  it('puts every remaining entrant in the draw when the seeds have holes in them', async () => {
    seedField(5);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    // The TOP seed leaves, so the survivors are seeds 2,3,4,5 — every one of
    // them out of range of the 4-slot draw they now belong in except by rank.
    Object.assign(participant('p-0'), { status: 'withdrawn' });

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

    const drawn = store.db.tournament_matches!
      .filter((m) => m.round_number === 1)
      .flatMap((m) => [m.participant_a_id, m.participant_b_id])
      .filter((id): id is string => Boolean(id));
    expect(drawn.sort()).toEqual(['p-1', 'p-2', 'p-3', 'p-4']);
    // Four entrants in a 4-slot draw is no byes at all. The phantom bye was the
    // visible symptom of the missing player.
    expect(byes()).toHaveLength(0);
  });

  it('seats an entrant once when two entries share a seed number', async () => {
    // The mirror of the same defect: `.find` returns the first match for both
    // lookups, so one entrant took two slots and another took none. There is no
    // unique index on seed_number in either table and the seed cell is
    // hand-editable, so this is reachable without anything going wrong.
    seedField(4);
    Object.assign(participant('p-2'), { seed_number: 2 });

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

    const drawn = store.db.tournament_matches!
      .filter((m) => m.round_number === 1)
      .flatMap((m) => [m.participant_a_id, m.participant_b_id])
      .filter((id): id is string => Boolean(id));
    expect(drawn.sort()).toEqual(['p-0', 'p-1', 'p-2', 'p-3']);
  });

  it('seeds a hand-seeded field exactly where its seed numbers say', async () => {
    // MANUAL SEEDING IS THE ONE DRAW THAT IS NOT DRAWN. An exec who typed every
    // seed in by hand asked for the bracket those numbers describe and has to
    // keep getting it, redraw after redraw — so this is the one case where an
    // exact arrangement is still the right assertion.
    //
    // The standard positions themselves are pinned in draw-randomisation.test.ts
    // against getStandardSeedPositions directly, so exact placement stays
    // nailed down even if what `manual` means ever changes.
    seedField(8);
    Object.assign(event(), { seeding_method: 'manual' });

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

    const r1 = round1();
    expect(r1).toHaveLength(4);
    // Standard positions for an 8-draw: 1v8, 4v5 | 2v7, 3v6. Seeds 1 and 2 sit
    // in opposite halves and cannot meet before the final, which is the entire
    // point of seeding and the property a rank/seed mix-up would break.
    expect(r1.map((m) => [m.participant_a_id, m.participant_b_id])).toEqual([
      ['p-0', 'p-7'],
      ['p-3', 'p-4'],
      ['p-1', 'p-6'],
      ['p-2', 'p-5'],
    ]);
    // Said as the property, not just the arrangement: the top two seeds feed
    // different semi-finals.
    expect(halfOf(r1, 'p-0')).not.toBe(halfOf(r1, 'p-1'));

    // And it is still that draw the second time, which is what "manual" means.
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    expect(layout()).toEqual([
      'p-0/p-7', 'p-3/p-4', 'p-1/p-6', 'p-2/p-5',
    ]);
    const audit = store.db.tournament_audit_log!.filter((r) => r.action === 'bracket_generated').at(-1)!;
    expect((audit.details as Row).draw_randomised).toBe(false);
    expect((audit.details as Row).draw_seed).toBeNull();
  });

  /**
   * "REGENERATE DRAW DOESNT CHANGE ANYTHING" — the club owner's report, as a
   * test. It was true: placement was a pure function of the stored seeds
   * against getStandardSeedPositions, so the same field produced a
   * byte-identical bracket however many times the button was pressed. There was
   * nothing to see, and no way to tell that apart from the button being broken.
   */
  it('gives a different draw when an ordinary field is redrawn', async () => {
    seedField(8);
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
      seen.add(layout().join(' | '));
    }
    // An 8-draw has 48 possible draws (2 for seeds 3-4, 24 for seeds 5-8), so
    // 30 presses landing on one arrangement would take a 48^-29 coincidence.
    expect(seen.size).toBeGreaterThan(1);
  });

  /**
   * THE INVARIANT THE RANDOMISATION IS ALLOWED TO KEEP AND NOTHING ELSE: two
   * entrants of the same seeding tier can never meet before the round their
   * tier implies. Asserted through the real generator here, and over thousands
   * of draws against the placement itself in draw-randomisation.test.ts.
   */
  it('keeps the seeding tiers apart however the draw falls', async () => {
    seedField(8);
    for (let i = 0; i < 30; i++) {
      expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
      const r1 = round1();
      // Seeds 1 and 2 in opposite halves — they cannot meet before the final.
      expect(halfOf(r1, 'p-0')).not.toBe(halfOf(r1, 'p-1'));
      // Seeds 1-4 one per quarter — none of them can meet before the semis. In
      // an 8-draw a quarter IS a first-round match, so this says they are four
      // different matches.
      const quarters = ['p-0', 'p-1', 'p-2', 'p-3'].map((id) => quarterOf(r1, id));
      expect(new Set(quarters).size).toBe(4);
      // Everybody drawn, nobody drawn twice.
      const drawn = r1.flatMap((m) => [m.participant_a_id, m.participant_b_id]);
      expect([...drawn].sort()).toEqual(['p-0', 'p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6', 'p-7']);
    }
  });

  /**
   * BYES STAY WITH THE TOP OF THE FIELD ON EVERY REDRAW.
   *
   * The draw shuffles ENTRANTS inside a tier, not rank slots between positions,
   * and this is the difference. A 5-entry field leaves ranks 6, 7 and 8 of an
   * 8-draw empty; shuffling slots could have moved an empty rank up into the
   * 5-8 band and handed seed 4 a bye while seed 1 played, which is not a draw,
   * it is a favour. Seeds 1 and 2 hold a bye every time, the third goes to one
   * of the 3-4 tier — that one IS the draw's business, because a tier is by
   * definition a set the draw treats as interchangeable — and seed 5 never has
   * one.
   */
  it('leaves the byes with the top of the field on every redraw', async () => {
    seedField(5);
    const thirdByeWentTo = new Set<string>();
    for (let i = 0; i < 30; i++) {
      expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
      const withBye = byes()
        .map((m) => (m.participant_a_id ?? m.participant_b_id) as string)
        .sort();
      expect(withBye).toHaveLength(3);
      expect(withBye).toContain('p-0');
      expect(withBye).toContain('p-1');
      expect(withBye).not.toContain('p-4');
      thirdByeWentTo.add(withBye.find((id) => id !== 'p-0' && id !== 'p-1')!);
    }
    // Only ever a member of the 3-4 tier.
    expect([...thirdByeWentTo].sort().every((id) => id === 'p-2' || id === 'p-3')).toBe(true);
  });

  /**
   * A DRAW THAT CAN BE EXPLAINED. "It was random" is not an answer to a player
   * asking why they landed in the top seed's half, so the seed the draw was
   * made from goes into the bracket_generated audit row — no column, no
   * migration, and re-drawing from it reproduces the identical bracket.
   */
  it('records the seed it drew from, and that seed reproduces the bracket', async () => {
    seedField(8);
    // newDrawSeed is the only entropy in the feature, so pinning Math.random
    // pins the draw — which is exactly the claim being tested.
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0.4242);

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    const first = layout();
    const audit = store.db.tournament_audit_log!.filter((r) => r.action === 'bracket_generated').at(-1)!;
    const seed = (audit.details as Row).draw_seed;
    expect((audit.details as Row).draw_randomised).toBe(true);
    expect(typeof seed).toBe('number');
    expect(seed).toBe(Math.floor(0.4242 * 4294967296));

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    expect(layout()).toEqual(first);

    // And an unpinned redraw is free to differ again.
    rand.mockRestore();
  });

  /**
   * A POOL-SEEDED DRAW IS NOT REDRAWN, and that is deliberate rather than an
   * oversight. buildFieldFromPool refuses a half-played pool precisely so the
   * bracket matches what everyone just played for; drawing the qualifiers again
   * would put the pool's third finisher into the second seed's half on a coin
   * flip, which is the outcome pool seeding exists to prevent. There is no
   * seeding_method opt-out on that path, so the path itself is the rule.
   */
  it('does not redraw a pool-seeded event', async () => {
    store.db.tournament_events!.push({
      id: 'e0', tournament_id: 't1', status: 'completed', event_type: 'mens_singles',
      format: 'round_robin', match_format: 'best_of_3_to_21', elo_multiplier: 1,
      placement_bonus_enabled: false,
    });
    Object.assign(event(), {
      status: 'checkin', draw_locked: false,
      seeded_from_event_id: 'e0', seed_by: 'wins', max_participants: 4,
    });
    const pool = ['a', 'b', 'c', 'd'];
    store.db.tournament_participants = pool.map((k, i) => ({
      id: `q-${k}`, event_id: 'e0', player_id: `pl-${k}`, elo_before: 1200,
      elo_after: 1200 + (3 - i) * 10, elo_change: null, seed_number: null,
      final_position: null, points: null, status: 'checked_in',
    }));
    let n = 0;
    store.db.tournament_matches = [];
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        store.db.tournament_matches.push({
          id: `pm-${++n}`, event_id: 'e0', status: 'completed', is_bye: false,
          is_third_place: false, round_number: 1, bracket_position: n,
          participant_a_id: `q-${pool[i]}`, participant_b_id: `q-${pool[j]}`,
          winner_participant_id: `q-${pool[i]}`, loser_participant_id: `q-${pool[j]}`,
          winner_to_match_id: null, winner_to_position: null,
          scores: [{ a: 21, b: 10 }, { a: 21, b: 12 }], elo_snapshot: null, notes: null,
        });
      }
    }

    const layouts = new Set<string>();
    for (let i = 0; i < 20; i++) {
      expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
      layouts.add(
        store.db.tournament_matches!
          .filter((m) => m.event_id === 'e1' && m.round_number === 1)
          .sort((a, b) => (a.bracket_position as number) - (b.bracket_position as number))
          .map((m) => `${m.participant_a_id}/${m.participant_b_id}`)
          .join(' | '),
      );
    }
    // One arrangement over twenty draws: the pool's finishing order, every time.
    expect(layouts.size).toBe(1);
    const audit = store.db.tournament_audit_log!.filter((r) => r.action === 'bracket_generated').at(-1)!;
    expect((audit.details as Row).draw_randomised).toBe(false);
    expect((audit.details as Row).draw_seed).toBeNull();
  });

  it('does not treat a VOIDED match as something that was played', async () => {
    // Voiding takes the result and its Elo back off (voidMatch -> reverse
    // snapshot), so a voided match is history that no longer counts. It is the
    // remedy the refusal above points the exec at, and it has to actually work.
    seedField(4);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    Object.assign(event(), { status: 'live' });
    const m = store.db.tournament_matches!.find((x) => x.round_number === 1)!;
    Object.assign(m, { status: 'voided', is_bye: false });

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    expect(event().status).toBe('live');
  });

  /**
   * A POOL-SEEDED EVENT'S FIELD ARRIVES AT GENERATION, so regenerating one runs
   * the promotion a second time. buildFieldFromPool inserts a qualifier only
   * when it is not already entered here — `existing`, keyed by player id (or an
   * order-independent pair key) — and the whole point of that lookup is this
   * case. Reading the code says it holds; this makes it a fact, because a
   * duplicate promotion would enter the same person twice, hand them two slots
   * in the draw, and be invisible until somebody counted the entry list.
   */
  it('promotes each pool qualifier ONCE, however many times the draw is redone', async () => {
    // A finished 4-player pool ('e0'), and a bracket that seeds from it ('e1')
    // with nobody entered yet — the shape the feature exists for.
    store.db.tournament_events!.push({
      id: 'e0', tournament_id: 't1', status: 'completed', event_type: 'mens_singles',
      format: 'round_robin', match_format: 'best_of_3_to_21', elo_multiplier: 1,
      placement_bonus_enabled: false,
    });
    Object.assign(event(), {
      status: 'checkin', draw_locked: false,
      seeded_from_event_id: 'e0', seed_by: 'wins', max_participants: 4,
    });
    const pool = ['a', 'b', 'c', 'd'];
    store.db.tournament_participants = pool.map((k, i) => ({
      id: `q-${k}`, event_id: 'e0', player_id: `pl-${k}`, elo_before: 1200,
      elo_after: 1200 + (3 - i) * 10, elo_change: null, seed_number: null,
      final_position: null, points: null, status: 'checked_in',
    }));
    // Every pairing played, decided in entry order so the standings are a
    // strict a > b > c > d. buildFieldFromPool refuses a half-finished pool, so
    // nothing may be left pending.
    let n = 0;
    store.db.tournament_matches = [];
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        store.db.tournament_matches.push({
          id: `pm-${++n}`, event_id: 'e0', status: 'completed', is_bye: false,
          is_third_place: false, round_number: 1, bracket_position: n,
          participant_a_id: `q-${pool[i]}`, participant_b_id: `q-${pool[j]}`,
          winner_participant_id: `q-${pool[i]}`, loser_participant_id: `q-${pool[j]}`,
          winner_to_match_id: null, winner_to_position: null,
          scores: [{ a: 21, b: 10 }, { a: 21, b: 12 }], elo_snapshot: null, notes: null,
        });
      }
    }

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    const afterFirst = store.db.tournament_participants!.filter((p) => p.event_id === 'e1');
    expect(afterFirst).toHaveLength(4);
    // Promoted in the pool's finishing order — the whole reason this path skips
    // the Elo re-sort.
    expect(afterFirst.map((p) => p.player_id)).toEqual(['pl-a', 'pl-b', 'pl-c', 'pl-d']);

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

    const afterSecond = store.db.tournament_participants!.filter((p) => p.event_id === 'e1');
    // The assertion. Four qualifiers, four entries, twice.
    expect(afterSecond).toHaveLength(4);
    expect(afterSecond.map((p) => p.id).sort()).toEqual(afterFirst.map((p) => p.id).sort());
    // And the redrawn bracket is a real 4-draw over exactly those entries.
    const drawn = store.db.tournament_matches!
      .filter((m) => m.event_id === 'e1' && m.round_number === 1)
      .flatMap((m) => [m.participant_a_id, m.participant_b_id]);
    expect(drawn.filter(Boolean).sort()).toEqual(afterSecond.map((p) => p.id).sort());
  });
});

describe('third-place playoff', () => {
  beforeEach(seedFourDraw);

  it('routes each semi-final LOSER into the playoff and each winner into the final', async () => {
    // Guards the whole feature: before loser_to_match_id existed, a match sent
    // only its winner anywhere, so a third-place match could never be filled by
    // playing the bracket — it would sit on TBD/TBD forever and block finalise.
    expect((await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a')).ok).toBe(true);

    expect(match(FINAL).participant_a_id).toBe('p-alice');
    expect(match(THIRD).participant_a_id).toBe('p-bob');
    // One side only, so neither downstream match is claimed READY yet.
    expect(match(THIRD).status).toBe('pending');

    expect((await enterMatchResult(SF2, [{ a: 21, b: 12 }, { a: 21, b: 14 }], 'a')).ok).toBe(true);

    expect(match(FINAL).participant_b_id).toBe('p-cara');
    expect(match(THIRD).participant_b_id).toBe('p-dan');
    expect(match(THIRD).status).toBe('ready');
    expect(match(FINAL).status).toBe('ready');
  });

  it('is rated exactly like any other match', async () => {
    // The decision recorded in brackets.ts. Nothing in the rating path keys off
    // the round, so this asserts no carve-out has crept in: a played playoff
    // moves Elo, the counts and the reliability figure, and leaves a reversible
    // snapshot behind.
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    await enterMatchResult(SF2, [{ a: 21, b: 12 }, { a: 21, b: 14 }], 'a');
    // Measured against where losing the semi-final left them, not against the
    // 1000 they started on — both are already down a semi-final's delta.
    const bobBefore = ratingOf('pl-bob');
    const danBefore = ratingOf('pl-dan');
    const played = (p: string) =>
      store.db.ratings!.find((r) => r.player_id === p)!.singles_matches_played as number;
    expect(played('pl-bob')).toBe(31);

    expect((await enterMatchResult(THIRD, [{ a: 21, b: 19 }, { a: 21, b: 18 }], 'a')).ok).toBe(true);

    expect(match(THIRD).elo_snapshot).not.toBeNull();
    expect(snapshotPlayers(THIRD).sort()).toEqual(['pl-bob', 'pl-dan']);
    expect(ratingOf('pl-bob')).toBeGreaterThan(bobBefore);
    expect(ratingOf('pl-dan')).toBeLessThan(danBefore);
    // The statistics and the reliability count move too — a playoff is a match.
    expect(played('pl-bob')).toBe(32);
    expect(store.db.reliability_metrics!.find((r) => r.player_id === 'pl-bob')!.matches_completed).toBe(7);
  });

  it('routes nobody from a BYE semi-final, rather than a phantom entry', async () => {
    // The "an event with byes may not have two real semi-final losers" case. A
    // bye is completed with a winner and NO loser, so advanceLoser has nothing
    // to send. Writing the null through would have blanked the slot the other
    // semi-final had already filled — silently un-filling a real player.
    Object.assign(match(SF2), {
      is_bye: true, status: 'completed', participant_b_id: null,
      winner_participant_id: 'p-cara', loser_participant_id: null,
    });
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(match(THIRD).participant_a_id).toBe('p-bob');
    expect(match(THIRD).participant_b_id).toBeNull();
    // Still 'pending', not 'ready' — 'ready' asserts both sides are known.
    expect(match(THIRD).status).toBe('pending');
  });

  it('refuses to void a semi-final once the playoff has been played', async () => {
    // assertDownstreamUndecided used to look at winner_to_match_id ALONE. With
    // the final still unplayed it would have allowed this void, erasing the
    // semi-final underneath a third-place match that carries a real result and a
    // real Elo delta attributed to its loser.
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    await enterMatchResult(SF2, [{ a: 21, b: 12 }, { a: 21, b: 14 }], 'a');
    await enterMatchResult(THIRD, [{ a: 21, b: 19 }, { a: 21, b: 18 }], 'a');

    const res = await voidMatch(SF1, 'Wrong court');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/third-place match already has a result/);
    // Refused before anything moved.
    expect(match(SF1).status).toBe('completed');
    expect(match(SF1).elo_snapshot).not.toBeNull();
  });

  it('clears the playoff slot when a semi-final is voided before it is played', async () => {
    // The other half of the same rule. Voiding used to clear only the winner's
    // slot, so the erased semi-final's loser stayed parked in the playoff — a
    // bracket advertising a match for third between a real player and a result
    // that no longer exists.
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    await enterMatchResult(SF2, [{ a: 21, b: 12 }, { a: 21, b: 14 }], 'a');
    expect(match(THIRD).status).toBe('ready');

    expect((await voidMatch(SF1, 'Scores belonged to another match')).ok).toBe(true);

    expect(match(THIRD).participant_a_id).toBeNull();
    expect(match(THIRD).participant_b_id).toBe('p-dan');
    expect(match(THIRD).status).toBe('pending');
    expect(match(FINAL).participant_a_id).toBeNull();
  });

  it('does not evict an entry somebody placed into the playoff by hand', async () => {
    // clearRoutedEntry decides whether to clear from a READ, then clears. The
    // filter on the update is what makes the clear itself safe: between the two,
    // a desk can void the OTHER semi-final and place its replacement by hand into
    // the same slot. Without `.eq(field, entryId)` the void below would null out
    // that placement and the audit row would still claim it cleared its own
    // loser.
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    expect(match(THIRD).participant_a_id).toBe('p-bob');
    // Somebody else has since replaced the occupant of that slot.
    match(THIRD).participant_a_id = 'p-cara';

    expect((await voidMatch(SF1, 'Wrong court')).ok).toBe(true);

    expect(match(THIRD).participant_a_id).toBe('p-cara');
    const row = store.db.tournament_audit_log!.find((r) => r.action === 'match_voided')!;
    expect((row.details as Row).cleared_third_place_slot).toBe(false);
  });

  it('clears the playoff slot when a semi-final result is undone', async () => {
    // undoMatchResult shared clearAdvancedEntry with voidMatch, so it had the
    // identical hole: the winner came back out of the final and the loser was
    // left in the playoff.
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect((await undoMatchResult(SF1)).ok).toBe(true);

    expect(match(THIRD).participant_a_id).toBeNull();
    expect(match(FINAL).participant_a_id).toBeNull();
  });

  it('re-routes the playoff slot when a semi-final winner is corrected', async () => {
    // Flipping a semi-final's winner also flips who plays for third. Writing
    // only the winner slot would have left the new FINALIST also sitting in the
    // playoff, entered in two matches at once.
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    expect(match(FINAL).participant_a_id).toBe('p-alice');
    expect(match(THIRD).participant_a_id).toBe('p-bob');

    const res = await editMatchResult(SF1, [{ a: 15, b: 21 }, { a: 17, b: 21 }], 'b', 'Sides transposed on the sheet');

    expect(res.ok).toBe(true);
    expect(match(FINAL).participant_a_id).toBe('p-bob');
    expect(match(THIRD).participant_a_id).toBe('p-alice');
  });

  it('awards 3rd and 4th from the playoff, and never 2nd to its loser', async () => {
    // The highest-risk interaction. The playoff shares round_number with the
    // final, so finalizeEvent's "roundsFromFinal === 0 means the loser is 2nd"
    // rule would hand SECOND place to the player who came fourth, and its
    // champion line — which uses set(), not first-write-wins — would overwrite
    // the actual winner of the event with the winner of the playoff.
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    await enterMatchResult(SF2, [{ a: 21, b: 12 }, { a: 21, b: 14 }], 'a');
    await enterMatchResult(FINAL, [{ a: 21, b: 18 }, { a: 21, b: 19 }], 'a');
    await enterMatchResult(THIRD, [{ a: 21, b: 19 }, { a: 21, b: 18 }], 'a');

    await finalizeEvent('e1');

    expect(participant('p-alice').final_position).toBe(1);
    expect(participant('p-cara').final_position).toBe(2);
    expect(participant('p-bob').final_position).toBe(3);
    expect(participant('p-dan').final_position).toBe(4);
    // Points follow the positions: 3rd and 4th both land in the "<= 4" band.
    expect(participant('p-bob').points).toBe(50);
    expect(participant('p-dan').points).toBe(50);
  });

  it('still gives both semi-final losers joint 3rd when there is no playoff', async () => {
    // The behaviour every existing event depends on. It must not change just
    // because the code now knows what a third-place match is.
    store.db.tournament_matches = store.db.tournament_matches!.filter((m) => m.id !== THIRD);
    for (const id of [SF1, SF2]) {
      Object.assign(match(id), { loser_to_match_id: null, loser_to_position: null });
    }
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    await enterMatchResult(SF2, [{ a: 21, b: 12 }, { a: 21, b: 14 }], 'a');
    await enterMatchResult(FINAL, [{ a: 21, b: 18 }, { a: 21, b: 19 }], 'a');

    await finalizeEvent('e1');

    expect(participant('p-bob').final_position).toBe(3);
    expect(participant('p-dan').final_position).toBe(3);
  });
});

// ============================================================
// Admin override — changing an already-resolved result
// ============================================================

describe('changing a resolved result', () => {
  beforeEach(seedFourDraw);

  it('re-rates through the 00078 reversal RPC exactly once, never by hand', async () => {
    // The defect this whole path is fenced against: a second reversal route is
    // how the same delta came off the ladder twice. A correction must clear the
    // snapshot via reverse_tournament_match_rating and then re-apply, so the
    // rating reflects the corrected result ONLY — not the old one, not the sum,
    // and not the old one reversed twice.
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    const aliceAfterWin = ratingOf('pl-alice');
    expect(aliceAfterWin).toBeGreaterThan(1000);

    const res = await editMatchResult(SF1, [{ a: 15, b: 21 }, { a: 17, b: 21 }], 'b', 'Winner recorded on the wrong side');
    expect(res.ok).toBe(true);

    // Both started level, so the corrected result is the mirror image: exactly
    // one delta each, the other way round.
    expect(ratingOf('pl-alice')).toBe(2000 - aliceAfterWin);
    expect(ratingOf('pl-bob')).toBe(aliceAfterWin);
    const alice = store.db.ratings!.find((r) => r.player_id === 'pl-alice')!;
    expect(alice.singles_matches_played).toBe(31);
    expect(alice.singles_wins).toBe(0);
    expect(alice.singles_losses).toBe(1);
    expect(store.db.reliability_metrics!.find((r) => r.player_id === 'pl-alice')!.matches_completed).toBe(6);
    // Re-rated, not left bare.
    expect(match(SF1).elo_snapshot).not.toBeNull();
  });

  it('records the old AND the new winner in the audit trail', async () => {
    // Six months on, the audit row is the only thing that says the board ever
    // read differently. Recording only the scores — which is all it used to do —
    // leaves "who was credited with the win" unrecoverable for a walkover, where
    // there is no scoreline at all.
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    await editMatchResult(SF1, [{ a: 15, b: 21 }, { a: 17, b: 21 }], 'b', 'Scoresheet transcribed backwards');

    const row = store.db.tournament_audit_log!.find((r) => r.action === 'result_edited')!;
    const details = row.details as Row;
    expect(details.old_winner_entry_id).toBe('p-alice');
    expect(details.new_winner_entry_id).toBe('p-bob');
    expect(details.old_loser_entry_id).toBe('p-bob');
    expect(details.new_loser_entry_id).toBe('p-alice');
    expect(details.winner_changed).toBe(true);
    expect(details.reason).toBe('Scoresheet transcribed backwards');
    expect(details.old_scores).toEqual([{ a: 21, b: 15 }, { a: 21, b: 17 }]);
    expect(details.new_scores).toEqual([{ a: 15, b: 21 }, { a: 17, b: 21 }]);
    expect(details.reversed_elo).toBe(true);
  });

  it('refuses without a reason, before anything is reversed', async () => {
    // The override is meant to be explicit. Checking the reason AFTER reversing
    // the rating would leave the match unrated on a refusal — a refusal that
    // changed something is worse than no guard at all.
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    const snapshotBefore = match(SF1).elo_snapshot;

    const res = await editMatchResult(SF1, [{ a: 15, b: 21 }, { a: 17, b: 21 }], 'b', '   ');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/has to say why/);
    expect(match(SF1).elo_snapshot).toBe(snapshotBefore);
    expect(match(SF1).winner_participant_id).toBe('p-alice');
  });

  it('refuses on a match that has no result to change', async () => {
    // Without this the correction path was a way to stamp a winner onto a
    // PENDING match: winner/loser were written unconditionally and the re-rate
    // was skipped, leaving a match that reads as decided to every downstream
    // reader while enterMatchResult still considered it playable.
    const res = await editMatchResult(FINAL, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a', 'Nudging it along');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/no result yet/);
    expect(match(FINAL).winner_participant_id).toBeNull();
    expect(match(FINAL).status).toBe('pending');
  });

  it('refuses on a voided match, which is restored rather than edited', async () => {
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    await voidMatch(SF1, 'Wrong court');

    const res = await editMatchResult(SF1, [{ a: 15, b: 21 }, { a: 17, b: 21 }], 'b', 'Fixing it');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/voided/);
  });

  it('refuses when the next round has been decided by WALKOVER, not just completed', async () => {
    // The hand-rolled downstream check this replaced tested
    // `status === 'completed'` alone. A late withdrawal settles the next round
    // as a WALKOVER — rated, with a real snapshot — and that shape walked
    // straight through, letting the semi-final be rewritten underneath it.
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    await enterMatchResult(SF2, [{ a: 21, b: 12 }, { a: 21, b: 14 }], 'a');
    expect((await enterWalkover(FINAL, 'a', 'Opponent withdrew')).ok).toBe(true);
    expect(match(FINAL).status).toBe('walkover');

    const res = await editMatchResult(SF1, [{ a: 15, b: 21 }, { a: 17, b: 21 }], 'b', 'Sides transposed');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/next match already has a result/);
    expect(match(SF1).winner_participant_id).toBe('p-alice');
    expect(match(SF1).elo_snapshot).not.toBeNull();
  });

  it('returns the refusal as a value rather than throwing it', async () => {
    // Next.js sanitises anything thrown out of a Server Action in a production
    // build, so while editMatchResult threw, every guard above reached the
    // browser as "An error occurred in the Server Components render" — a refusal
    // indistinguishable from a crash, on the one path where the difference
    // decides what the exec does next.
    await expect(
      editMatchResult('no-such-match', [{ a: 21, b: 15 }], 'a', 'Reason'),
    ).resolves.toMatchObject({ ok: false });
  });

  it('refuses on a BYE, which is "completed" but was never played', async () => {
    // A bye passes the has-a-result check — it is status 'completed' with a
    // winner the generator placed there — so without an explicit refusal the
    // override was a way to write a scoreline and a LOSER onto a match with one
    // empty side, and then rate it. voidMatch and setMatchEntry both refuse a
    // bye; this is the third door into the same room.
    Object.assign(match(SF2), {
      is_bye: true, status: 'completed', participant_b_id: null,
      winner_participant_id: 'p-cara', loser_participant_id: null,
    });

    const res = await editMatchResult(SF2, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a', 'Filling it in');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/A bye is not a played match/);
    expect(match(SF2).scores).toBeNull();
    expect(match(SF2).elo_snapshot).toBeNull();
  });

  it('refuses rather than proceeding when the downstream check cannot be read', async () => {
    // The guard used to drop the read's { error }, which left `nextMatch` null
    // and the check silently satisfied — so a transient read failure was a way
    // PAST the one rule standing between a correction and an already-played
    // final. A refusal is recoverable; a wrongly-permitted rewrite is not.
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    store.faults.push({
      table: 'tournament_matches', op: 'select', message: 'connection reset',
      when: ({ filters }) => filters.some(([c, v]) => c === 'id' && v === FINAL),
    });

    const res = await editMatchResult(SF1, [{ a: 15, b: 21 }, { a: 17, b: 21 }], 'b', 'Sides transposed');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/not safe to change this result/);
    // Nothing moved: the rating is still the one the original result applied.
    expect(match(SF1).elo_snapshot).not.toBeNull();
    expect(match(SF1).winner_participant_id).toBe('p-alice');
  });

  it('turns a corrected walkover into a played match instead of leaving it half-one', async () => {
    // Correcting a walkover by typing the real scores used to leave status
    // 'walkover' and walkover_winner 'a' on a row whose winner had just become
    // B — three fields disagreeing about who won, with the bracket rendering
    // "⚠ WALKOVER" over a scoreline.
    await enterWalkover(SF1, 'a', 'Opponent did not appear');
    expect(match(SF1).status).toBe('walkover');

    const res = await editMatchResult(SF1, [{ a: 15, b: 21 }, { a: 17, b: 21 }], 'b', 'They did turn up and lost');

    expect(res.ok).toBe(true);
    expect(match(SF1).status).toBe('completed');
    expect(match(SF1).walkover_winner).toBeNull();
    expect(match(SF1).walkover_reason).toBeNull();
    expect(match(SF1).winner_participant_id).toBe('p-bob');
  });

  it('keeps a scoreless walkover a walkover, and moves the side it was awarded to', async () => {
    // The other direction, and the one the UI could not reach at all while the
    // Save button was gated on a winner derived from the scores: a walkover has
    // no scoreline, so there was nothing to derive.
    await enterWalkover(SF1, 'a', 'Opponent did not appear');

    const res = await editMatchResult(SF1, [], 'b', 'Awarded to the wrong side');

    expect(res.ok).toBe(true);
    expect(match(SF1).status).toBe('walkover');
    expect(match(SF1).walkover_winner).toBe('b');
    expect(match(SF1).winner_participant_id).toBe('p-bob');
    expect(match(SF1).loser_participant_id).toBe('p-alice');
  });

  it('lets a correction be made after the event is finalised', async () => {
    // A wrong result is most often spotted on the results screen, which only
    // exists once the event is completed. assertEventResultsMutable allows
    // 'completed' for exactly this reason, and gating the correction on 'live'
    // would have hidden it where it is most wanted.
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    await enterMatchResult(SF2, [{ a: 21, b: 12 }, { a: 21, b: 14 }], 'a');
    await enterMatchResult(FINAL, [{ a: 21, b: 18 }, { a: 21, b: 19 }], 'a');
    await enterMatchResult(THIRD, [{ a: 21, b: 19 }, { a: 21, b: 18 }], 'a');
    await finalizeEvent('e1');
    expect(event().status).toBe('completed');

    const res = await editMatchResult(THIRD, [{ a: 19, b: 21 }, { a: 18, b: 21 }], 'b', 'Third-place score reversed');

    expect(res.ok).toBe(true);
    expect(match(THIRD).winner_participant_id).toBe('p-dan');
  });
});
