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
    let orderBy: [string, boolean] | null = null;
    let cols = '*';
    let op: Op = 'select';
    let payload: Row = {};

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
          passesNot(r),
      );
      if (!orderBy) return rows;
      const [col, asc] = orderBy;
      return [...rows].sort((a, b) => (((a[col] as number) ?? 0) - ((b[col] as number) ?? 0)) * (asc ? 1 : -1));
    };

    const embed = (r: Row): Row =>
      cols.includes('tournament_events(')
        ? { ...r, event: (store.db.tournament_events ?? []).find((e) => e.id === r.event_id) ?? null }
        : r;

    const fault = () =>
      store.faults.find((f) => f.table === table && f.op === op && (!f.when || f.when({ filters, payload })));

    const run = () => {
      const f = fault();
      // The whole point: a Postgres error is a RESOLVED value, not a rejection.
      if (f) return { data: null, error: { message: f.message } };
      if (op === 'update') {
        for (const r of matching()) Object.assign(r, payload);
        return { data: null, error: null };
      }
      if (op === 'insert') {
        const rows = Array.isArray(payload) ? (payload as Row[]) : [payload];
        (store.db[table] ??= []).push(...rows.map((r) => ({ ...r })));
        return { data: null, error: null };
      }
      if (op === 'delete') {
        store.db[table] = (store.db[table] ?? []).filter((r) => !matching().includes(r));
        return { data: null, error: null };
      }
      return { data: matching().map(embed), error: null };
    };

    const api = {
      select(c: string) { cols = c; if (op === 'select') op = 'select'; return api; },
      update(p: Row) { op = 'update'; payload = p; return api; },
      insert(p: Row) { op = 'insert'; payload = p; return api; },
      delete() { op = 'delete'; return api; },
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      in(c: string, vs: unknown[]) { inFilters.push([c, vs]); return api; },
      not(c: string, o: string, v: unknown) { notFilters.push([c, o, v]); return api; },
      order(c: string, opts?: { ascending?: boolean }) { orderBy = [c, opts?.ascending !== false]; return api; },
      async single() {
        const f = fault();
        if (f) return { data: null, error: { message: f.message } };
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
  return { from: (table: string) => query(table) };
});

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('../supabase-server', () => ({ createAdminClient: makeClient }));
vi.mock('../actions/_shared', () => ({ getExecOrAdmin: async () => ({ id: 'admin-1' }) }));

import { enterMatchResult, voidMatch } from '../tournament-actions/results';
import { finalizeEvent, applyPlacementBonuses } from '../tournament-actions/finalize';
import { withdrawParticipant } from '../tournament-actions/participants';
import { settleWrites, assertWritesSucceeded } from '../tournament-actions/_internal';

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
  it('reports a rejected rating write instead of saying "result saved"', async () => {
    store.faults.push({
      table: 'ratings', op: 'update', message: 'permission denied for table ratings',
      when: ({ filters }) => filters.some(([c, v]) => c === 'player_id' && v === 'pl-bob'),
    });

    const res = await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/pl-bob/);
    expect(res.ok === false && res.error).toMatch(/permission denied/);
    // Alice's write landed and Bob's did not — which is the whole complaint:
    // before this, that difference was invisible to everyone.
    expect(ratingOf('pl-alice')).toBeGreaterThan(1000);
    expect(ratingOf('pl-bob')).toBe(1000);
  });

  it('snapshots only the ratings that actually moved, so undo cannot over-refund', async () => {
    store.faults.push({
      table: 'ratings', op: 'update', message: 'deadlock detected',
      when: ({ filters }) => filters.some(([c, v]) => c === 'player_id' && v === 'pl-bob'),
    });

    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(snapshotPlayers(QF)).toEqual(['pl-alice']);
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

  it('still records the participant-row failure even though the ratings landed', async () => {
    store.faults.push({
      table: 'tournament_participants', op: 'update', message: 'null value violates not-null constraint',
      when: ({ payload }) => 'elo_after' in payload,
    });

    const res = await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/elo_after/);
    // Ratings are the source of truth and they did move, so both are snapshotted.
    expect(snapshotPlayers(QF).sort()).toEqual(['pl-alice', 'pl-bob']);
  });
});

describe('Elo reversal', () => {
  it('refuses to call a match voided when the rating did not come back', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    const applied = ratingOf('pl-alice');

    store.faults.push({
      table: 'ratings', op: 'update', message: 'permission denied for table ratings',
      when: ({ filters }) => filters.some(([c, v]) => c === 'player_id' && v === 'pl-alice'),
    });

    const res = await voidMatch(QF, 'Court collapsed');

    expect(res.ok).toBe(false);
    expect(ratingOf('pl-alice')).toBe(applied);   // never came off the ladder
    expect(ratingOf('pl-bob')).toBe(1000);        // this half did reverse
    expect(match(QF).status).toBe('completed');   // so the void did not happen
    // The un-reversed delta stays on the snapshot, or nothing would point at it.
    expect(snapshotPlayers(QF)).toEqual(['pl-alice']);
  });

  it('reverses only the remainder when the void is retried', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    store.faults.push({
      table: 'ratings', op: 'update', message: 'deadlock detected',
      when: ({ filters }) => filters.some(([c, v]) => c === 'player_id' && v === 'pl-alice'),
    });
    await voidMatch(QF, 'first attempt');

    store.faults = [];
    const res = await voidMatch(QF, 'second attempt');

    expect(res.ok).toBe(true);
    // Bob was reversed on the first attempt and must NOT be reversed twice.
    expect(ratingOf('pl-alice')).toBe(1000);
    expect(ratingOf('pl-bob')).toBe(1000);
    expect(match(QF).elo_snapshot).toBeNull();
    expect(match(QF).status).toBe('voided');
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

    // Bob is out and his first match was forfeited, but the second never was.
    expect(participant('p-bob').status).toBe('withdrawn');
    expect(match(RR1).status).toBe('walkover');
    expect(match(RR2).status).toBe('ready');

    store.faults = [];
    const second = await withdrawParticipant('p-bob', 'Sprained ankle');

    // The old guard refused this outright with "Already withdrawn", leaving the
    // remaining match live against someone who had gone home.
    expect(second.ok).toBe(true);
    expect(second.ok === true && second.data.forfeited).toBe(1);
    expect(match(RR2).status).toBe('walkover');
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
