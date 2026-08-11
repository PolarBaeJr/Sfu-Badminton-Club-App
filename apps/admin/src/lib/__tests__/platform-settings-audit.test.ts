import { describe, it, expect, beforeEach, vi } from 'vitest';

// EVERY PLATFORM SETTING CHANGE CARRIES A TYPED REASON, FROM EITHER SCREEN.
//
// updatePlatformSettings gained the reason as an OPTIONAL parameter when
// /ratings was rebuilt, so /ratings passed one and /accounts — which mounts the
// generic PlatformSettingsForm — did not. The same audited action was therefore
// reasoned or auto-captioned depending on which page the officer happened to
// open, which is the one property an audit log cannot have.
//
// The floor is the server's, not the Save button's: a stale tab or a direct
// call to the action reaches the same write. These tests are on the action.

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  actor: { id: 'aaaaaaaa-0000-4000-8000-000000000001' } as Row,
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
        const hit = matching();
        for (const r of hit) Object.assign(r, payload);
        return { data: hit, error: null };
      }
      return { data: matching(), error: null };
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

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('../supabase-server', () => ({ createAdminClient: makeClient }));
vi.mock('../actions/_shared', () => ({
  requireCapability: async () => store.actor,
}));

import { updatePlatformSettings } from '../actions/settings';
import { REASON_MIN } from '../audit-reason';

const KEY = 'elo_settings';
const settings = () => store.db.platform_settings ?? [];
const audits = () => store.db.audit_logs ?? [];

beforeEach(() => {
  store.db = {
    platform_settings: [{ key: KEY, value: { k_factor: 32 } }],
    audit_logs: [],
  };
});

describe('updatePlatformSettings — the reason is the boundary', () => {
  it('writes nothing at all when the reason is too short', async () => {
    await expect(
      updatePlatformSettings([{ key: KEY, value: { k_factor: 40 } }], 'oops'),
    ).rejects.toThrow(new RegExp(`at least ${REASON_MIN} characters`));

    expect(settings()[0]!.value).toEqual({ k_factor: 32 });
    expect(audits()).toHaveLength(0);
  });

  it('refuses whitespace that only looks like a reason', async () => {
    await expect(
      updatePlatformSettings([{ key: KEY, value: { k_factor: 40 } }], '        '),
    ).rejects.toThrow();
    expect(audits()).toHaveLength(0);
  });

  it('names the setting rather than one of the two screens it can be changed from', async () => {
    // The message used to say "the rating settings", which stopped being true
    // the moment /accounts could reach the same action.
    await expect(
      updatePlatformSettings([{ key: KEY, value: {} }], ''),
    ).rejects.toThrow(/platform setting/i);
  });

  it('stores the key first and the typed reason after it', async () => {
    await updatePlatformSettings(
      [{ key: KEY, value: { k_factor: 40 } }],
      '  Provisional players were moving too slowly  ',
    );

    expect(settings()[0]!.value).toEqual({ k_factor: 40 });
    expect(audits()).toHaveLength(1);
    // The key leads because target_id is null for a settings row, and /ratings
    // reads these back by the prefix. The reason is trimmed.
    expect(audits()[0]!.reason).toBe(
      `${KEY} — Provisional players were moving too slowly`,
    );
    expect(audits()[0]!.action_type).toBe('platform_setting_updated');
  });

  it('puts the same reason on every key changed in one save', async () => {
    store.db.platform_settings!.push({ key: 'account_settings', value: { auto_approve: false } });

    await updatePlatformSettings(
      [
        { key: KEY, value: { k_factor: 40 } },
        { key: 'account_settings', value: { auto_approve: true } },
      ],
      'Exec meeting 2026-08-11',
    );

    expect(audits().map((a) => a.reason)).toEqual([
      `${KEY} — Exec meeting 2026-08-11`,
      'account_settings — Exec meeting 2026-08-11',
    ]);
  });
});
