import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@badminton/shared';

/**
 * The weekly-digest claim (F-019) rests entirely on one assumption about
 * supabase-js and PostgREST: that `.upsert(..., { ignoreDuplicates: true })
 * .select()` resolves to an EMPTY array — not the row that already exists —
 * when the key is taken. That empty array is the mutual exclusion; if the
 * existing row came back instead, every concurrent run would believe it won
 * and the club would be mailed twice.
 *
 * The fake client in weekly-digest.test.ts returns `[]` on conflict because it
 * was written to, which proves nothing about the real library. These tests pin
 * the real one: the request it emits, and how it reads an empty 201.
 *
 * The server half was verified separately against staging PostgREST — a
 * conflicting insert answers `201` with body `[]`.
 */
function capturingClient() {
  const seen: { url?: string; method?: string; prefer?: string | null } = {};
  const db = createClient<Database>('http://stub.invalid', 'stub-key', {
    auth: { persistSession: false },
    global: {
      fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
        seen.url = String(url);
        seen.method = init?.method;
        seen.prefer = new Headers(init?.headers).get('Prefer');
        return new Response('[]', {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    },
  });
  return { db, seen };
}

function claim(db: ReturnType<typeof capturingClient>['db']) {
  return db
    .from('digest_deliveries')
    .upsert(
      { week_start: '2030-01-07', player_id: 'p1', claimed_at: '2030-01-07T00:00:00.000Z' },
      { onConflict: 'week_start,player_id', ignoreDuplicates: true },
    )
    .select('player_id');
}

describe('digest delivery claim — the wire contract the fake assumes', () => {
  it('asks PostgREST to skip duplicates rather than overwrite them', async () => {
    const { db, seen } = capturingClient();
    await claim(db);

    // resolution=merge-duplicates here would turn the claim into an overwrite:
    // both invocations would "win" and both would mail.
    expect(seen.prefer).toContain('resolution=ignore-duplicates');
    // Without return=representation there is no row count to decide on at all.
    expect(seen.prefer).toContain('return=representation');
    expect(seen.method).toBe('POST');
  });

  it('conflicts on the full delivery key, not on the week alone', async () => {
    const { db, seen } = capturingClient();
    await claim(db);

    // on_conflict=week_start alone would let the first claimed member of a week
    // block every other member of that week from ever being mailed.
    expect(decodeURIComponent(seen.url ?? '')).toContain('on_conflict=week_start,player_id');
  });

  it('reports an empty result — not an error — when the key was already taken', async () => {
    const { db } = capturingClient();
    const { data, error } = await claim(db);

    // The route branches on `!claim || claim.length === 0`. An error here, or a
    // returned existing row, would each break it in a different direction.
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});
