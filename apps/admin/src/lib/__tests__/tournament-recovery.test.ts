import { describe, it, expect, beforeEach, vi } from 'vitest';

// The recovery path (void -> restore -> replay) exists precisely so a match can
// be rated twice in a row without the ratings counting it twice. That invariant
// is impossible to eyeball, so these tests drive the real server actions against
// an in-memory stand-in for Postgres and assert on the resulting rating rows.

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  /**
   * THE RACE WINDOW. Fires ONCE, immediately after the next single-row read of
   * `tournament_matches` and before the caller does anything with the answer —
   * which in voidMatchImpl and setMatchEntryImpl is the read every guard below
   * it is checked against. That is exactly where the other desk's write commits
   * in production, and it is the only way to reach these cases at all.
   *
   * Modelled on `store.beforeDeletePhase` in tournament-write-integrity.test.ts,
   * which does the same job for the redraw. Async, so a test can stage the race
   * by driving the REAL other-desk action rather than hand-writing the row it
   * would have left behind — a hand-written row proves the assertion, not the
   * behaviour.
   */
  afterMatchRead: null as null | (() => void | Promise<void>),
}));

// Minimal PostgREST-shaped query builder: enough of select/eq/in/update/insert
// for the results actions, and thenable so `await client.from(t).update(x).eq()`
// resolves the way the real client does.
const makeClient = vi.hoisted(() => () => {
  // Cleared BEFORE it runs, so the other desk's action — which reads matches
  // itself — cannot re-enter it. One race per test, at the first match read.
  async function fireRace(table: string) {
    if (table !== 'tournament_matches') return;
    const staged = store.afterMatchRead;
    if (!staged) return;
    store.afterMatchRead = null;
    await staged();
  }

  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    const inFilters: Array<[string, unknown[]]> = [];
    // `.is(col, null)` — a seeded row may omit the column, which stands for SQL
    // NULL here.
    const isFilters: Array<[string, unknown]> = [];
    let cols = '*';
    let op: 'select' | 'update' | 'insert' | 'upsert' | 'delete' = 'select';
    let payload: Row = {};
    // The conflict target of an upsert. Undefined for every other op.
    let onConflict: string | undefined;

    const matching = () =>
      (store.db[table] ?? []).filter(
        (r) =>
          filters.every(([c, v]) => r[c] === v) &&
          inFilters.every(([c, vs]) => vs.includes(r[c])) &&
          isFilters.every(([c, v]) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)),
      );

    // `select('*, event:tournament_events(*)')` — the only embed these actions
    // use. Always a COPY, because the real client decodes a row out of an HTTP
    // response: a caller that reads a row and then writes to it must still see
    // the pre-write values in its own copy.
    const embed = (r: Row): Row =>
      cols.includes('tournament_events(*)')
        ? { ...r, event: (store.db.tournament_events ?? []).find((e) => e.id === r.event_id) ?? null }
        : { ...r };

    const run = () => {
      if (op === 'update') {
        const hit = matching();
        for (const r of hit) Object.assign(r, payload);
        // PostgREST reports "matched no rows" as success, so a guarded write can
        // only be told apart from a no-op by its count.
        return { data: null, error: null, count: hit.length };
      }
      if (op === 'insert') {
        (store.db[table] ??= []).push({ ...payload });
        return { data: null, error: null };
      }
      // ONE ROW PER PARENT, matched on the conflict column rather than on the
      // filter chain — an upsert carries no `.eq()`. Added for 00118's private
      // note tables, which voidMatch and unvoidMatch now write alongside the
      // match row itself.
      if (op === 'upsert') {
        const bucket = (store.db[table] ??= []);
        // Copied to a const so it narrows inside the closure — `onConflict` is
        // a `let` in the enclosing scope, which tsc will not narrow across a
        // callback boundary.
        const key = onConflict;
        const existing = key ? bucket.find((e) => e[key] === payload[key]) : undefined;
        if (existing) Object.assign(existing, payload);
        else bucket.push({ ...payload });
        return { data: null, error: null };
      }
      // Clearing a note — unvoidMatch with an empty restore reason deletes the
      // row rather than storing ''.
      if (op === 'delete') {
        store.db[table] = (store.db[table] ?? []).filter((r) => !matching().includes(r));
        return { data: null, error: null };
      }
      return { data: matching().map(embed), error: null };
    };

    const api = {
      select(c: string) { cols = c; op = 'select'; return api; },
      update(p: Row) { op = 'update'; payload = p; return api; },
      insert(p: Row) { op = 'insert'; payload = p; return api; },
      upsert(p: Row, opts?: { onConflict?: string }) {
        op = 'upsert';
        payload = p;
        onConflict = opts?.onConflict;
        return api;
      },
      delete() { op = 'delete'; return api; },
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      in(c: string, vs: unknown[]) { inFilters.push([c, vs]); return api; },
      is(c: string, v: unknown) { isFilters.push([c, v]); return api; },
      // The answer is decoded BEFORE the race fires, because the real client
      // decodes a row out of an HTTP response: the caller holds the row as it
      // was, which is the whole premise of a compare-and-swap.
      async single() {
        const r = matching()[0];
        const out = { data: r ? embed(r) : null, error: null };
        await fireRace(table);
        return out;
      },
      async maybeSingle() {
        const r = matching()[0];
        const out = { data: r ? embed(r) : null, error: null };
        await fireRace(table);
        return out;
      },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(run()).then(resolve); },
    };
    return api;
  }

  // Stand-ins for apply_tournament_match_rating and
  // reverse_tournament_match_rating (migrations 00070 and 00078) — the two
  // single transactions that now perform every write a rated tournament match
  // causes, and every write undoing one causes. This harness has no fault
  // injection, so the only behaviour it needs is the happy path plus the
  // "already rated" refusal and the reversal no-op that together make replay
  // safe.
  const threshold = () => {
    const settings = (store.db.platform_settings ?? []).find((r) => r.key === 'rating_defaults')?.value as Row | undefined;
    return (settings?.provisional_threshold as number) ?? 8;
  };

  function applyRpc(args: Record<string, unknown>) {
    const matchId = args.p_match_id as string;
    const discipline = args.p_discipline as 'singles' | 'doubles';
    const entries = args.p_entries as Array<Record<string, unknown>>;

    const m = (store.db.tournament_matches ?? []).find((r) => r.id === matchId);
    if (!m) return Promise.resolve({ data: null, error: { message: `Tournament match not found: ${matchId}` } });
    if (m.elo_snapshot) {
      return Promise.resolve({ data: null, error: { message: `Tournament match ${matchId} is already rated` } });
    }

    const snapshotEntries: Row[] = [];

    for (const e of entries) {
      const row = (store.db.ratings ?? []).find((r) => r.player_id === e.player_id);
      if (!row) {
        return Promise.resolve({ data: null, error: { message: `No ratings row for player ${String(e.player_id)}` } });
      }
      // COALESCE(%I, 0): the seeded rows omit the statistics columns.
      const n = (k: string) => (row[k] as number | undefined) ?? 0;
      const won = e.won === true;
      const played = n(`${discipline}_matches_played`) + 1;
      const streakField = `current_${discipline}_streak`;
      const streakBefore = n(streakField);
      const streakAfter = won ? Math.max(streakBefore + 1, 1) : Math.min(streakBefore - 1, -1);

      row[`${discipline}_elo`] = e.after;
      row[`${discipline}_matches_played`] = played;
      row[`${discipline}_wins`] = n(`${discipline}_wins`) + (won ? 1 : 0);
      row[`${discipline}_losses`] = n(`${discipline}_losses`) + (won ? 0 : 1);
      row[`${discipline}_points_scored`] = n(`${discipline}_points_scored`) + ((e.points_scored as number) ?? 0);
      row[`${discipline}_points_allowed`] = n(`${discipline}_points_allowed`) + ((e.points_allowed as number) ?? 0);
      row[`${discipline}_games_won`] = n(`${discipline}_games_won`) + ((e.games_won as number) ?? 0);
      row[`${discipline}_games_lost`] = n(`${discipline}_games_lost`) + ((e.games_lost as number) ?? 0);
      row[streakField] = streakAfter;
      if (played >= threshold()) row[`${discipline}_provisional`] = false;

      const pid = e.player_id as string;
      const rel = (store.db.reliability_metrics ??= []).find((r) => r.player_id === pid);
      if (rel) rel.matches_completed = ((rel.matches_completed as number | undefined) ?? 0) + 1;
      else store.db.reliability_metrics.push({ player_id: pid, matches_completed: 1 });

      if (e.participant_id) {
        const p = (store.db.tournament_participants ?? []).find((r) => r.id === e.participant_id);
        if (p) Object.assign(p, { elo_after: e.after, elo_change: e.delta });
      }

      snapshotEntries.push({
        player_id: e.player_id, before: e.before, after: e.after, delta: e.delta,
        won: e.won, points_scored: e.points_scored ?? 0, points_allowed: e.points_allowed ?? 0,
        games_won: e.games_won ?? 0, games_lost: e.games_lost ?? 0,
        streak_before: streakBefore, streak_after: streakAfter,
      });
    }

    m.elo_snapshot = { discipline, entries: snapshotEntries };
    return Promise.resolve({ data: null, error: null });
  }

  function reverseRpc(args: Record<string, unknown>) {
    const matchId = args.p_match_id as string;
    const m = (store.db.tournament_matches ?? []).find((r) => r.id === matchId);
    if (!m) return Promise.resolve({ data: null, error: { message: `Tournament match not found: ${matchId}` } });

    const snapshot = m.elo_snapshot as { discipline: 'singles' | 'doubles'; entries: Row[] } | null;
    // An unrated match has nothing to reverse. Not an error — that no-op is what
    // makes a retry after an unclear outcome safe.
    if (!snapshot || !snapshot.entries?.length) return Promise.resolve({ data: null, error: null });

    const d = snapshot.discipline;
    const streakField = `current_${d}_streak`;

    for (const e of snapshot.entries) {
      const pid = e.player_id as string;
      const row = (store.db.ratings ?? []).find((r) => r.player_id === pid);
      if (!row) {
        return Promise.resolve({ data: null, error: { message: `No ratings row for player ${pid}` } });
      }
      const n = (k: string) => (row[k] as number | undefined) ?? 0;

      // The three snapshot tiers, discriminated by POSITIVE tests exactly as the
      // SQL does it, so an absent key falls through to the older branch.
      const hasStats = typeof e.won === 'boolean';
      const hasStreak = hasStats && typeof e.streak_before === 'number' && typeof e.streak_after === 'number';

      row[`${d}_elo`] = n(`${d}_elo`) - (e.delta as number);
      if (!hasStats) continue;

      const won = e.won === true;
      const played = Math.max(0, n(`${d}_matches_played`) - 1);
      row[`${d}_matches_played`] = played;
      row[won ? `${d}_wins` : `${d}_losses`] = Math.max(0, n(won ? `${d}_wins` : `${d}_losses`) - 1);
      row[`${d}_points_scored`] = Math.max(0, n(`${d}_points_scored`) - ((e.points_scored as number) ?? 0));
      row[`${d}_points_allowed`] = Math.max(0, n(`${d}_points_allowed`) - ((e.points_allowed as number) ?? 0));
      row[`${d}_games_won`] = Math.max(0, n(`${d}_games_won`) - ((e.games_won as number) ?? 0));
      row[`${d}_games_lost`] = Math.max(0, n(`${d}_games_lost`) - ((e.games_lost as number) ?? 0));
      row[streakField] = hasStreak && n(streakField) === e.streak_after
        ? e.streak_before
        : (won ? Math.max(0, n(streakField) - 1) : Math.min(0, n(streakField) + 1));
      if (played < threshold()) row[`${d}_provisional`] = true;

      if (hasStreak) {
        const rel = (store.db.reliability_metrics ?? []).find((r) => r.player_id === pid);
        if (rel) rel.matches_completed = Math.max(0, ((rel.matches_completed as number | undefined) ?? 0) - 1);
      }
    }

    if (d === 'singles') {
      const participantIds = [m.winner_participant_id, m.loser_participant_id]
        .filter((x): x is string => typeof x === 'string' && x.length > 0);
      for (const p of (store.db.tournament_participants ?? []).filter((r) => participantIds.includes(r.id as string))) {
        Object.assign(p, { elo_after: null, elo_change: null });
      }
    }

    m.elo_snapshot = null;
    return Promise.resolve({ data: null, error: null });
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

import { enterMatchResult, enterWalkover, voidMatch, unvoidMatch, setMatchEntry, undoMatchResult, editMatchResult, recordDoubleNoShow } from '../tournament-actions/results';
import { reverseEloSnapshot } from '../tournament-actions/_internal';
import { createAdminClient } from '../supabase-server';

const QF = 'match-qf';
const SF = 'match-sf';

function ratingOf(playerId: string) {
  return store.db.ratings!.find((r) => r.player_id === playerId)!.singles_elo as number;
}

function match(id: string) {
  return store.db.tournament_matches!.find((m) => m.id === id)!;
}

// One quarter-final feeding position 'a' of a semi-final — the exact shape of
// the stuck bracket this recovery path was written for.
beforeEach(() => {
  store.afterMatchRead = null;
  store.db = {
    tournaments: [{ id: 't1', suspended_at: null, suspension_reason: null, name: 'Test Cup' }],
    tournament_events: [{
      id: 'e1', tournament_id: 't1', status: 'live', event_type: 'mens_singles',
      match_format: 'one_game_21', elo_multiplier: 1,
    }],
    tournament_participants: [
      { id: 'p-alice', event_id: 'e1', player_id: 'pl-alice', elo_before: 1000, elo_after: null, elo_change: null, status: 'checked_in' },
      { id: 'p-bob', event_id: 'e1', player_id: 'pl-bob', elo_before: 1000, elo_after: null, elo_change: null, status: 'checked_in' },
      { id: 'p-carol', event_id: 'e1', player_id: 'pl-carol', elo_before: 1000, elo_after: null, elo_change: null, status: 'checked_in' },
      { id: 'p-dan', event_id: 'e1', player_id: 'pl-dan', elo_before: 1000, elo_after: null, elo_change: null, status: 'withdrawn' },
    ],
    ratings: [
      { player_id: 'pl-alice', singles_elo: 1000, singles_provisional: false, singles_matches_played: 30 },
      { player_id: 'pl-bob', singles_elo: 1000, singles_provisional: false, singles_matches_played: 30 },
      { player_id: 'pl-carol', singles_elo: 1000, singles_provisional: false, singles_matches_played: 30 },
      { player_id: 'pl-dan', singles_elo: 1000, singles_provisional: false, singles_matches_played: 30 },
    ],
    tournament_matches: [
      {
        id: QF, event_id: 'e1', status: 'ready', is_bye: false,
        participant_a_id: 'p-alice', participant_b_id: 'p-bob',
        winner_participant_id: null, loser_participant_id: null,
        winner_to_match_id: SF, winner_to_position: 'a',
        scores: null, elo_snapshot: null, notes: null,
      },
      {
        id: SF, event_id: 'e1', status: 'pending', is_bye: false,
        participant_a_id: null, participant_b_id: null,
        winner_participant_id: null, loser_participant_id: null,
        winner_to_match_id: null, winner_to_position: null,
        scores: null, elo_snapshot: null, notes: null,
      },
    ],
    reliability_metrics: [
      { player_id: 'pl-alice', matches_completed: 0 },
      { player_id: 'pl-bob', matches_completed: 0 },
      { player_id: 'pl-carol', matches_completed: 0 },
      { player_id: 'pl-dan', matches_completed: 0 },
    ],
    platform_settings: [],
    notifications: [],
    tournament_audit_log: [],
  };
});

describe('void / restore / replay', () => {
  it('counts a replayed match exactly once', async () => {
    expect((await enterMatchResult(QF, [{ a: 21, b: 15 }], 'a')).ok).toBe(true);

    const afterFirstPlay = ratingOf('pl-alice');
    expect(afterFirstPlay).toBeGreaterThan(1000);
    expect(match(QF).elo_snapshot).toBeTruthy();

    // Voiding must hand the rating back — a voided match is unrated, and the
    // snapshot has to be cleared or the replay below would be refused outright
    // by applyTournamentMatchElo's idempotency guard and silently keep the
    // stale delta.
    expect((await voidMatch(QF, 'Court collapsed')).ok).toBe(true);
    expect(ratingOf('pl-alice')).toBe(1000);
    expect(ratingOf('pl-bob')).toBe(1000);
    expect(match(QF).elo_snapshot).toBeNull();

    expect((await unvoidMatch(QF, 'Replayed on court 3')).ok).toBe(true);
    expect(match(QF).status).toBe('ready');

    expect((await enterMatchResult(QF, [{ a: 21, b: 15 }], 'a')).ok).toBe(true);
    expect(ratingOf('pl-alice')).toBe(afterFirstPlay);
    // "Exactly once" has to mean the STATISTICS too, not just the Elo. The
    // tournament path now increments matches_played/wins/points, so a reversal
    // that moved only the rating would leave this cycle counting the match
    // twice — visible nowhere in the Elo assertion above.
    const alice = store.db.ratings!.find((r) => r.player_id === 'pl-alice')!;
    expect(alice.singles_matches_played).toBe(31);
    expect(alice.singles_wins).toBe(1);
    expect(alice.singles_points_scored).toBe(21);
    expect(alice.current_singles_streak).toBe(1);
    // ...and the reliability counter, which tournament matches now move too.
    expect(store.db.reliability_metrics!.find((r) => r.player_id === 'pl-alice')!.matches_completed).toBe(1);
  });

  it('pulls the voided winner back out of the next round', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }], 'a');
    expect(match(SF).participant_a_id).toBe('p-alice');

    await voidMatch(QF, 'Scoresheet lost');
    expect(match(SF).participant_a_id).toBeNull();
    expect(match(SF).status).toBe('pending');
  });

  it('refuses to void twice, and refuses to void under a played next round', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }], 'a');
    await voidMatch(QF, 'first');

    const second = await voidMatch(QF, 'again');
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.error).toMatch(/already voided/i);

    await unvoidMatch(QF, 'restore');
    await enterMatchResult(QF, [{ a: 21, b: 15 }], 'a');
    await setMatchEntry(SF, 'b', 'p-carol', 'other half collapsed');
    await enterMatchResult(SF, [{ a: 21, b: 10 }], 'a');

    const blocked = await voidMatch(QF, 'too late');
    expect(blocked.ok).toBe(false);
    expect(blocked.ok === false && blocked.error).toMatch(/next match already has a result/i);
  });

  // Matches voided before voidMatch learned to reverse Elo are sitting in
  // production right now with their delta still applied and their snapshot still
  // on the row. Restoring one has to clean that up, or the replay would be
  // refused by the idempotency guard and the stale delta would stand forever.
  it('reverses a legacy voided match that kept its applied delta', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }], 'a');
    const applied = ratingOf('pl-alice');
    const snapshot = match(QF).elo_snapshot;

    // Reproduce the old void: status flipped, everything else left alone.
    Object.assign(match(QF), { status: 'voided' });
    expect(match(QF).elo_snapshot).toEqual(snapshot);

    expect((await unvoidMatch(QF, 'Replayed')).ok).toBe(true);
    expect(ratingOf('pl-alice')).toBe(1000);
    expect(match(QF).elo_snapshot).toBeNull();

    await enterMatchResult(QF, [{ a: 21, b: 15 }], 'a');
    expect(ratingOf('pl-alice')).toBe(applied);
  });

  // The reversal RPC clears the ratings AND the snapshot in one transaction, but
  // resetting the match row is a later, separate write. If that reset fails — or
  // its response is lost — the match is left decided with no snapshot, which is
  // indistinguishable by shape from a genuinely pre-snapshot match.
  it('does not rewind an already-reversed match to its registration rating', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }], 'a');
    // Alice plays on elsewhere and climbs.
    store.db.ratings!.find((r) => r.player_id === 'pl-alice')!.singles_elo = 1400;

    // Reverse succeeds; the match reset that would follow it does not happen.
    await reverseEloSnapshot(createAdminClient(), QF);
    expect(match(QF).elo_snapshot).toBeNull();
    expect(match(QF).status).toBe('completed');
    const afterReversal = ratingOf('pl-alice');

    const res = await undoMatchResult(QF);

    expect(res.ok).toBe(true);
    // The legacy branch would have written elo_before (1000) over her CURRENT
    // rating, erasing every match she played after this one. elo_after is null
    // because the reversal cleared it, and that is the evidence the branch now
    // requires before rewinding anything.
    expect(ratingOf('pl-alice')).toBe(afterReversal);
    expect(ratingOf('pl-alice')).not.toBe(1000);
    expect(match(QF).status).toBe('ready');
  });

  it('still rewinds a genuinely pre-snapshot match, where elo_after is stamped', async () => {
    // The other half of that guard: a match rated before the snapshot column
    // existed has no snapshot but DOES carry elo_after, and must still reverse.
    Object.assign(match(QF), {
      status: 'completed', winner_participant_id: 'p-alice', loser_participant_id: 'p-bob',
      scores: [{ a: 21, b: 15 }], elo_snapshot: null,
    });
    store.db.tournament_participants!.find((p) => p.id === 'p-alice')!.elo_after = 1030;
    store.db.tournament_participants!.find((p) => p.id === 'p-bob')!.elo_after = 970;
    store.db.ratings!.find((r) => r.player_id === 'pl-alice')!.singles_elo = 1030;

    expect((await undoMatchResult(QF)).ok).toBe(true);

    expect(ratingOf('pl-alice')).toBe(1000); // back to elo_before
    expect(store.db.tournament_participants!.find((p) => p.id === 'p-alice')!.elo_after).toBeNull();
  });

  it('only restores a voided match', async () => {
    const res = await unvoidMatch(QF, 'nope');
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/only a voided match/i);
  });
});

describe('manual slot repair', () => {
  it('fills an orphaned slot and marks the match ready once both sides are known', async () => {
    expect((await setMatchEntry(SF, 'a', 'p-alice', 'QF voided')).ok).toBe(true);
    expect(match(SF).status).toBe('pending');

    expect((await setMatchEntry(SF, 'b', 'p-carol', 'QF voided')).ok).toBe(true);
    expect(match(SF).participant_b_id).toBe('p-carol');
    expect(match(SF).status).toBe('ready');
  });

  it('refuses withdrawn entries, self-matches and occupied slots', async () => {
    const withdrawn = await setMatchEntry(SF, 'a', 'p-dan', 'x');
    expect(withdrawn.ok).toBe(false);
    expect(withdrawn.ok === false && withdrawn.error).toMatch(/withdrawn/i);

    await setMatchEntry(SF, 'a', 'p-alice', 'x');

    const self = await setMatchEntry(SF, 'b', 'p-alice', 'x');
    expect(self.ok).toBe(false);
    expect(self.ok === false && self.error).toMatch(/cannot play itself/i);

    const occupied = await setMatchEntry(SF, 'a', 'p-carol', 'x');
    expect(occupied.ok).toBe(false);
    expect(occupied.ok === false && occupied.error).toMatch(/already filled/i);
  });

  it('will not edit a match that already has a result', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }], 'a');
    const res = await setMatchEntry(QF, 'b', 'p-carol', 'x');
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/already has a result/i);
  });
});

describe('unopposed advancement', () => {
  it('advances the lone occupant without moving any rating', async () => {
    await setMatchEntry(SF, 'a', 'p-alice', 'QF voided');

    expect((await enterWalkover(SF, 'a', 'Other half of the draw was voided')).ok).toBe(true);
    expect(match(SF).status).toBe('walkover');
    expect(match(SF).winner_participant_id).toBe('p-alice');
    // No opponent means no Elo — otherwise a voided branch would hand out free
    // rating points to whoever happened to be standing next to it.
    expect(match(SF).elo_snapshot).toBeNull();
    expect(ratingOf('pl-alice')).toBe(1000);
  });

  it('refuses to award a walkover to an empty side', async () => {
    await setMatchEntry(SF, 'a', 'p-alice', 'QF voided');

    const res = await enterWalkover(SF, 'b', 'nobody there');
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/nobody to award/i);
    expect(match(SF).status).toBe('pending');
  });
});

// ============================================================
// Overtaken by another desk
// ============================================================
//
// Every guard in voidMatchImpl and setMatchEntryImpl is checked against a row
// that is read and then let go of, and the write that followed named the id
// ALONE. PostgREST reports "matched no rows" as SUCCESS and supabase-js resolves
// rather than rejects, so nothing in either action could tell a write that fired
// from one that was overtaken — the loser of the race carried on and logged an
// audit row for work it had not done.
//
// `store.afterMatchRead` opens that window at the one instant it exists, and
// each test below drives the REAL action the other desk would have run, so what
// is asserted is the state the console actually produces rather than a row this
// file invented.
describe('overtaken by another desk', () => {
  describe('voiding', () => {
    it('refuses when the result is entered under it, leaving the result whole', async () => {
      // THE DEFECT. The void read `ready` and reversed nothing, because there was
      // nothing to reverse yet; by the time it wrote, the match was completed,
      // rated and advanced. It stamped `voided` over the top and logged
      // reversed_elo: false — truthfully, which is what makes it so hard to see:
      // the delta stayed on the ladder, Alice stayed in the semi-final, and the
      // row became the "voided but still carries an applied rating" shape that
      // summariseRedrawBlockers has to refuse to delete.
      store.afterMatchRead = async () => {
        expect((await enterMatchResult(QF, [{ a: 21, b: 15 }], 'a')).ok).toBe(true);
      };

      const res = await voidMatch(QF, 'Court collapsed');

      expect(res.ok).toBe(false);
      expect(res.ok === false && res.error).toMatch(/rating is already on the ladder/i);
      expect(res.ok === false && res.error).toMatch(/undo that result/i);

      // The result is untouched — the void did not happen.
      expect(match(QF).status).toBe('completed');
      expect(match(QF).elo_snapshot).not.toBeNull();
      expect(ratingOf('pl-alice')).toBeGreaterThan(1000);
      expect(match(SF).participant_a_id).toBe('p-alice');
      // And nothing claims it did. The audit row was the worst part of this:
      // it recorded a void that had erased nothing.
      expect(store.db.tournament_audit_log!.find((r) => r.action === 'match_voided')).toBeUndefined();
    });

    it('refuses the CONCURRENT double-void, which the read-time guard cannot see', async () => {
      // The status condition is the only one that catches this: nothing was
      // rated, so the snapshot stays null, and nobody touched the slots. The
      // "this match is already voided" guard above sees a row read before the
      // other desk wrote, so it waves this straight through — it catches the
      // SEQUENTIAL double-click (covered above), not two execs on the same match.
      //
      // Without the condition both voids wrote, both wrote a note over each
      // other's, and the audit log recorded the match being erased twice by two
      // different people.
      store.afterMatchRead = async () => {
        expect((await voidMatch(QF, 'the other desk got there first')).ok).toBe(true);
      };

      const res = await voidMatch(QF, 'Court collapsed');

      expect(res.ok).toBe(false);
      expect(res.ok === false && res.error).toMatch(/another desk voided this match first/i);
      // Exactly one void on record, with the reason the desk that actually did
      // it typed.
      const voided = store.db.tournament_audit_log!.filter((r) => r.action === 'match_voided');
      expect(voided).toHaveLength(1);
      expect((voided[0]!.details as Row).reason).toBe('the other desk got there first');
    });

    it('refuses when a correction re-rates the match under it', async () => {
      // The status condition CANNOT catch this one, which is why the write also
      // asserts the snapshot is null. editMatchResult reverses, re-applies and
      // leaves the status on `completed`, so a void of a completed-but-unrated
      // match — the shape a match is left in when the rating RPC failed after the
      // result was written — passes a status check and still voids a rated row.
      Object.assign(match(QF), {
        status: 'completed',
        winner_participant_id: 'p-alice',
        loser_participant_id: 'p-bob',
        scores: [{ a: 21, b: 15 }],
        elo_snapshot: null,
      });

      store.afterMatchRead = async () => {
        expect((await editMatchResult(QF, [{ a: 15, b: 21 }], 'b', 'Sides transposed')).ok).toBe(true);
      };

      const res = await voidMatch(QF, 'Scoresheet lost');

      expect(res.ok).toBe(false);
      expect(res.ok === false && res.error).toMatch(/rating is already on the ladder/i);
      expect(match(QF).status).toBe('completed');
      // The correction's delta is still applied and still reversible.
      expect(match(QF).elo_snapshot).not.toBeNull();
      expect(ratingOf('pl-bob')).toBeGreaterThan(1000);
      expect(store.db.tournament_audit_log!.find((r) => r.action === 'match_voided')).toBeUndefined();
    });

    it('refuses when the entries are swapped and the status lands back where it was', async () => {
      // The ABA the occupant conditions exist for. ready -> pending -> ready, so
      // the status this request read is true again and a status-only
      // compare-and-swap matches. The exec pressed Void on "Alice v Bob"; the
      // fixture is now "Alice v Carol", which is not the match they looked at.
      store.afterMatchRead = async () => {
        expect((await setMatchEntry(QF, 'b', null, 'wrong player on the sheet')).ok).toBe(true);
        expect((await setMatchEntry(QF, 'b', 'p-carol', 'the real opponent')).ok).toBe(true);
      };

      const res = await voidMatch(QF, 'Court collapsed');

      expect(res.ok).toBe(false);
      expect(res.ok === false && res.error).toMatch(/entries in it are not what the bracket showed you/i);
      expect(match(QF).status).toBe('ready');
      expect(match(QF).participant_b_id).toBe('p-carol');
      expect(store.db.tournament_audit_log!.find((r) => r.action === 'match_voided')).toBeUndefined();
    });

    it('still voids when nothing overtakes it', async () => {
      // The conditions have to leave the ordinary path alone. Three of them on
      // one write is three ways to refuse a void that should have happened.
      await enterMatchResult(QF, [{ a: 21, b: 15 }], 'a');

      expect((await voidMatch(QF, 'Court collapsed')).ok).toBe(true);
      expect(match(QF).status).toBe('voided');
      expect(match(QF).elo_snapshot).toBeNull();
      expect(ratingOf('pl-alice')).toBe(1000);
    });
  });

  describe('editing the draw', () => {
    it('refuses to stomp a settled match back to ready', async () => {
      // THE DEFECT. Both sides known and a walkover recorded, and this write put
      // `ready` back over it with the winner, the scores and the snapshot all
      // still on the row. Nothing downstream reads it as decided any more, so
      // finalizeEvent counts it among the "N match(es) still incomplete" and
      // refuses to finalise the event at all — a walkover the desk recorded
      // correctly, and an event that can never be closed.
      expect((await setMatchEntry(SF, 'b', 'p-carol', 'QF voided')).ok).toBe(true);
      expect(match(SF).status).toBe('pending');

      store.afterMatchRead = async () => {
        expect((await enterWalkover(SF, 'b', 'Other half of the draw was voided')).ok).toBe(true);
      };

      const res = await setMatchEntry(SF, 'a', 'p-alice', 'filling the orphaned slot');

      expect(res.ok).toBe(false);
      expect(res.ok === false && res.error).toMatch(/reload the bracket/i);
      expect(match(SF).status).toBe('walkover');
      expect(match(SF).winner_participant_id).toBe('p-carol');
      expect(match(SF).participant_a_id).toBeNull();
    });

    it('refuses to evict an entry another desk placed into the same empty slot', async () => {
      // Neither the "that slot is already filled" guard nor the status condition
      // reaches this: the guard was checked against a row read before Carol was
      // placed, and filling one side of a match whose other side is empty does
      // NOT move the status — pending -> pending — so the compare-and-swap on the
      // status alone matches. This is why both slots are pinned null-aware
      // instead of going through matchSlotFilter, which skips a null slot.
      store.afterMatchRead = async () => {
        expect((await setMatchEntry(SF, 'a', 'p-carol', 'other half collapsed')).ok).toBe(true);
      };

      const res = await setMatchEntry(SF, 'a', 'p-alice', 'other half collapsed');

      expect(res.ok).toBe(false);
      expect(res.ok === false && res.error).toMatch(/somebody else moved an entry into it/i);
      expect(match(SF).participant_a_id).toBe('p-carol');
      expect(match(SF).status).toBe('pending');
    });

    it('still fills, clears and re-fills a slot when nothing overtakes it', async () => {
      // The other side of the same coin: an empty slot must still be fillable,
      // and `.is(col, null)` is what makes that expressible — `.eq(col, null)`
      // renders as `col=eq.null` and would match nothing, reporting every
      // ordinary fill as a lost race.
      expect((await setMatchEntry(SF, 'a', 'p-alice', 'QF voided')).ok).toBe(true);
      expect((await setMatchEntry(SF, 'b', 'p-carol', 'QF voided')).ok).toBe(true);
      expect(match(SF).status).toBe('ready');

      expect((await setMatchEntry(SF, 'b', null, 'wrong entry')).ok).toBe(true);
      expect(match(SF).status).toBe('pending');
      expect((await setMatchEntry(SF, 'b', 'p-carol', 'put it back')).ok).toBe(true);
      expect(match(SF).status).toBe('ready');
    });
  });
  // The same defect, found in the two functions next door once the pattern was
  // named. Neither was in the original report.
  describe('the other two erasures', () => {
    it('refuses a double no-show that another desk voided out from under it', async () => {
      // recordDoubleNoShowImpl is voidMatchImpl by another name -- it reverses
      // the rating if there is a snapshot and writes `voided` -- and it wrote on
      // the id alone. So this erased a match a second time and filed a
      // `reversed_elo` claim about a snapshot that no longer described it.
      store.afterMatchRead = async () => {
        expect((await voidMatch(QF, 'the other desk got there first')).ok).toBe(true);
      };

      const res = await recordDoubleNoShow(QF, 'neither pair turned up');

      expect(res.ok).toBe(false);
      expect(res.ok === false && res.error).toMatch(/already voided/i);
      // Both entries stay as they were: a no-show that did not happen must not
      // feed check_noshow_threshold, which auto-flags at 3 and suspends at 5.
      const entries = store.db.tournament_participants!.filter((e) => e.status === 'no_show');
      expect(entries).toHaveLength(0);
    });

    it('refuses a restore of a match another desk already restored AND decided', async () => {
      expect((await voidMatch(QF, 'court flooded')).ok).toBe(true);

      // The read at the top of unvoidMatchImpl sees `voided`; by the time it
      // writes, the match has been restored and played. Without the status on
      // the write this reset stomped a completed match back to `ready` and wiped
      // its winner and scores -- item 20's failure by a different route.
      store.afterMatchRead = async () => {
        expect((await unvoidMatch(QF, 'court reopened')).ok).toBe(true);
        expect((await enterMatchResult(QF, [{ a: 21, b: 15 }], 'a')).ok).toBe(true);
      };

      const res = await unvoidMatch(QF, 'court reopened');

      expect(res.ok).toBe(false);
      expect(res.ok === false && res.error).toMatch(/no longer voided/i);
      // The result the other desk entered survives intact.
      expect(match(QF).status).toBe('completed');
      expect(match(QF).winner_participant_id).toBe('p-alice');
    });
  });
});
