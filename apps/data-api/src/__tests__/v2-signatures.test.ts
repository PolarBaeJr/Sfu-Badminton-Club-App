import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DATA_API_SCOPES } from '../scopes.js';
import { get, grant, newKey, startHarness, type Harness } from './helpers.js';

// PostgREST matches an RPC to a function by its argument NAMES, so a v2 reader
// whose parameters drift from what the service sends 404s exactly like a v2
// that does not exist yet, and the service would quietly serve v1 for ever.
// This reads 00277 off disk and holds the two together.

const TOURNAMENT = '22222222-0000-0000-0000-000000000001';
const EVENT = '33333333-0000-0000-0000-000000000001';

const sql = readFileSync(
  new URL('../../../../supabase/migrations/00277_the_data_api_serves_staged_draws.sql', import.meta.url),
  'utf8',
);

const V2_ARGS = new Map(
  [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+_v2)\(([^)]*)\)/g)].map(([, name, args]) => [
    name!,
    args!.split(',').map((a) => a.trim().split(/\s+/)[0]!).sort(),
  ]),
);

let h: Harness;
let key: string;

beforeEach(async () => {
  h = await startHarness();
  Object.assign(h.rpcs, {
    data_api_tournaments: () => [{ id: TOURNAMENT }],
    data_api_tournament_events_v2: () => [{ id: EVENT }],
    data_api_tournament_entrants_v2: () => [],
    data_api_tournament_draw_v2: () => [],
  });
  key = newKey();
  grant(h, key, [...DATA_API_SCOPES]);
});
afterEach(async () => {
  await h.close();
});

describe('the v2 readers in 00277', () => {
  it('defines the three the service calls', () => {
    expect([...V2_ARGS.keys()].sort()).toEqual([
      'data_api_tournament_draw_v2',
      'data_api_tournament_entrants_v2',
      'data_api_tournament_events_v2',
    ]);
  });

  it('take exactly the argument names the service sends', async () => {
    expect((await get(h, `/v1/tournaments/${TOURNAMENT}`, key)).status).toBe(200);
    expect((await get(h, `/v1/tournaments/${TOURNAMENT}/events/${EVENT}`, key)).status).toBe(200);
    for (const [name, args] of V2_ARGS) {
      const calls = h.calls.filter((c) => c.fn === name);
      expect(calls.length, name).toBeGreaterThan(0);
      for (const call of calls) expect(Object.keys(call.body).sort(), name).toEqual(args);
    }
  });
});
