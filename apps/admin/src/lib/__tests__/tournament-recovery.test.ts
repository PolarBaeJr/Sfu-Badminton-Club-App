import { describe, it, expect, beforeEach, vi } from 'vitest';

// The recovery path (void -> restore -> replay) exists precisely so a match can
// be rated twice in a row without the ratings counting it twice. That invariant
// is impossible to eyeball, so these tests drive the real server actions against
// an in-memory stand-in for Postgres and assert on the resulting rating rows.

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({ db: {} as Record<string, Row[]> }));

// Minimal PostgREST-shaped query builder: enough of select/eq/in/update/insert
// for the results actions, and thenable so `await client.from(t).update(x).eq()`
// resolves the way the real client does.
const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    const inFilters: Array<[string, unknown[]]> = [];
    let cols = '*';
    let op: 'select' | 'update' | 'insert' = 'select';
    let payload: Row = {};

    const matching = () =>
      (store.db[table] ?? []).filter(
        (r) =>
          filters.every(([c, v]) => r[c] === v) &&
          inFilters.every(([c, vs]) => vs.includes(r[c])),
      );

    // `select('*, event:tournament_events(*)')` — the only embed these actions use.
    const embed = (r: Row): Row =>
      cols.includes('tournament_events(*)')
        ? { ...r, event: (store.db.tournament_events ?? []).find((e) => e.id === r.event_id) ?? null }
        : r;

    const run = () => {
      if (op === 'update') {
        for (const r of matching()) Object.assign(r, payload);
        return { data: null, error: null };
      }
      if (op === 'insert') {
        (store.db[table] ??= []).push({ ...payload });
        return { data: null, error: null };
      }
      return { data: matching().map(embed), error: null };
    };

    const api = {
      select(c: string) { cols = c; op = 'select'; return api; },
      update(p: Row) { op = 'update'; payload = p; return api; },
      insert(p: Row) { op = 'insert'; payload = p; return api; },
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      in(c: string, vs: unknown[]) { inFilters.push([c, vs]); return api; },
      async single() { const r = matching()[0]; return { data: r ? embed(r) : null, error: null }; },
      async maybeSingle() { const r = matching()[0]; return { data: r ? embed(r) : null, error: null }; },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(run()).then(resolve); },
    };
    return api;
  }
  return { from: (table: string) => query(table) };
});

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('../supabase-server', () => ({ createAdminClient: makeClient }));
vi.mock('../actions/_shared', () => ({ getExecOrAdmin: async () => ({ id: 'admin-1' }) }));

import { enterMatchResult, enterWalkover, voidMatch, unvoidMatch, setMatchEntry } from '../tournament-actions/results';

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
