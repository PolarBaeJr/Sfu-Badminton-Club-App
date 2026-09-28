import { describe, it, expect, beforeEach, vi } from 'vitest';

// THE EXEC'S DOOR TO THE REPEAT CHALLENGE RULE OPENS ON THREE KEYS, NO MORE.
//
// updateRepeatChallengeSettings writes rating_defaults, the same row that holds
// the K-factors and the rating bounds, under matches.void.write rather than the
// admin-only platform.settings.write. So the properties that matter are the
// ones a hand-rolled POST would test: it can only move the three repeat keys,
// every value is range-checked on the server, a concurrent /ratings save is
// not reverted, and the audit row reads back on /ratings like any other
// settings change.

type Row = Record<string, unknown>;

const ACTOR = 'aaaaaaaa-0000-4000-8000-000000000001';
const STAMP = '2026-01-01T00:00:00.000000+00:00';

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  capabilities: [] as string[],
  // Simulates a /ratings save landing between this action's read and write.
  bumpBeforeWrite: false,
}));

const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    let op: 'select' | 'update' | 'insert' = 'select';
    let payload: Row = {};

    const matching = () =>
      (store.db[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));

    const run = (): { data: Row[] | null; error: { message: string } | null } => {
      if (op === 'insert') {
        (store.db[table] ??= []).push({ ...payload });
        return { data: [payload], error: null };
      }
      if (op === 'update') {
        if (store.bumpBeforeWrite) {
          for (const r of store.db[table] ?? []) r.updated_at = '2026-06-01T00:00:00.000000+00:00';
          store.bumpBeforeWrite = false;
        }
        const hit = matching();
        for (const r of hit) Object.assign(r, payload);
        return { data: hit, error: null };
      }
      return { data: matching().map((r) => ({ ...r })), error: null };
    };

    const api = {
      select() { return api; },
      insert(p: Row) { op = 'insert'; payload = p; return api; },
      update(p: Row) { op = 'update'; payload = p; return api; },
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      async single() {
        const res = run();
        return { data: res.data?.[0] ?? null, error: res.error };
      },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(run()).then(resolve); },
    };
    return api;
  }
  return { from: (table: string) => query(table) };
});

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({
  captureException: () => {},
  getCurrentScope: () => ({ setExtras: () => {} }),
}));
vi.mock('../supabase-server', () => ({ createAdminClient: makeClient }));
vi.mock('../actions/_shared', () => ({
  requireCapability: async (cap: string) => { store.capabilities.push(cap); return { id: ACTOR }; },
}));

const { updateRepeatChallengeSettings } = await import('../actions/matches');

const OTHER_KEYS = { singles_k_established: 36, max_elo: 3001, provisional_k_enabled: true };

const settings = () => store.db.platform_settings![0]!;
const audits = () => store.db.audit_logs ?? [];

beforeEach(() => {
  store.capabilities = [];
  store.bumpBeforeWrite = false;
  store.db = {
    platform_settings: [
      {
        key: 'rating_defaults',
        value: { ...OTHER_KEYS, repeat_decay_pct: 25, repeat_window_days: 30, repeat_min_factor: 0.1 },
        updated_at: STAMP,
      },
    ],
    audit_logs: [],
  };
});

describe('updateRepeatChallengeSettings', () => {
  it('asks for matches.void.write, the capability an exec can hold', async () => {
    await updateRepeatChallengeSettings({ decayPct: 30, windowDays: 21, minFactor: 0.15 }, 'Farming again');
    expect(store.capabilities).toEqual(['matches.void.write']);
  });

  it('moves the three repeat keys and leaves every other key as it was', async () => {
    const r = await updateRepeatChallengeSettings(
      { decayPct: 30, windowDays: 21, minFactor: 0.15 },
      'Farming again',
    );
    expect(r.ok).toBe(true);
    expect(settings().value).toEqual({
      ...OTHER_KEYS,
      repeat_decay_pct: 30,
      repeat_window_days: 21,
      repeat_min_factor: 0.15,
    });
    expect(settings().updated_by).toBe(ACTOR);
  });

  it('ignores any extra field a hand-rolled POST adds', async () => {
    const input = { decayPct: 30, windowDays: 21, minFactor: 0.15, max_elo: 9999 } as unknown as {
      decayPct: number; windowDays: number; minFactor: number;
    };
    await updateRepeatChallengeSettings(input, 'Farming again');
    expect((settings().value as Row).max_elo).toBe(3001);
  });

  it('writes an audit row /ratings reads back as a rating_defaults change', async () => {
    await updateRepeatChallengeSettings({ decayPct: 30, windowDays: 21, minFactor: 0.15 }, '  Farming again  ');
    expect(audits()).toHaveLength(1);
    const row = audits()[0]!;
    expect(row.action_type).toBe('platform_setting_updated');
    expect(row.target_id).toBeNull();
    // The separator /ratings splits on, spelled as an escape so the source
    // carries no literal em dash.
    expect(row.reason).toBe('rating_defaults \u2014 Farming again');
    expect((row.old_value as Row).repeat_decay_pct).toBe(25);
    expect((row.new_value as Row).repeat_decay_pct).toBe(30);
  });

  it('refuses when the row changed between the read and the write', async () => {
    store.bumpBeforeWrite = true;
    const r = await updateRepeatChallengeSettings({ decayPct: 30, windowDays: 21, minFactor: 0.15 }, 'Farming again');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/reload/i);
    expect((settings().value as Row).repeat_decay_pct).toBe(25);
    expect(audits()).toHaveLength(0);
  });

  it('accepts the edges of every range, and a floor of 0', async () => {
    const r = await updateRepeatChallengeSettings({ decayPct: 90, windowDays: 365, minFactor: 0 }, 'Edge values');
    expect(r.ok).toBe(true);
    const r2 = await updateRepeatChallengeSettings({ decayPct: 0, windowDays: 1, minFactor: 1 }, 'Edge values');
    expect(r2.ok).toBe(true);
  });

  it.each([
    ['a reduction above 90', { decayPct: 95, windowDays: 30, minFactor: 0.1 }],
    ['a negative reduction', { decayPct: -5, windowDays: 30, minFactor: 0.1 }],
    ['a fractional reduction', { decayPct: 12.5, windowDays: 30, minFactor: 0.1 }],
    ['a window of 0', { decayPct: 25, windowDays: 0, minFactor: 0.1 }],
    ['a window above 365', { decayPct: 25, windowDays: 366, minFactor: 0.1 }],
    ['a fractional window', { decayPct: 25, windowDays: 7.5, minFactor: 0.1 }],
    ['a floor above 1', { decayPct: 25, windowDays: 30, minFactor: 1.1 }],
    ['a negative floor', { decayPct: 25, windowDays: 30, minFactor: -0.1 }],
    ['a floor with three decimals', { decayPct: 25, windowDays: 30, minFactor: 0.125 }],
    ['a string', { decayPct: '25', windowDays: 30, minFactor: 0.1 }],
    ['NaN', { decayPct: Number.NaN, windowDays: 30, minFactor: 0.1 }],
  ])('refuses %s and writes nothing', async (_label, input) => {
    const r = await updateRepeatChallengeSettings(
      input as unknown as { decayPct: number; windowDays: number; minFactor: number },
      'Farming again',
    );
    expect(r.ok).toBe(false);
    expect((settings().value as Row).repeat_decay_pct).toBe(25);
    expect(audits()).toHaveLength(0);
  });

  it('refuses a missing input object and a short reason', async () => {
    const r = await updateRepeatChallengeSettings(
      null as unknown as { decayPct: number; windowDays: number; minFactor: number },
      'Farming again',
    );
    expect(r.ok).toBe(false);
    const r2 = await updateRepeatChallengeSettings({ decayPct: 30, windowDays: 21, minFactor: 0.15 }, ' ok ');
    expect(r2.ok).toBe(false);
    expect(audits()).toHaveLength(0);
  });
});
