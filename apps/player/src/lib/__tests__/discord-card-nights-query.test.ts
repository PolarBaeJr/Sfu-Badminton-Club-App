// PINNING THE NIGHTS COUNT THE DISCORD PROFILE CARD SENDS.
//
// *** WHY THIS FILE EXISTS. ***
//
// The NIGHTS panel counted every night the member had ever attended while the
// comment beside it in discord-card.tsx asserted "It is a season-long figure
// like the three beside it". `sessions` carries `season_id` and was simply
// never joined, so a three-year member's card read NIGHTS 214 under a rail that
// frames the card as this season.
//
// The join that fixes it is the exact shape that fails SILENTLY. Select strings
// are unchecked string literals (supabase-server.ts: "typed clients are
// deliberately off"), so a mistyped embed or a column the `authenticated` role
// cannot read makes PostgREST answer 400/403 for the WHOLE request, and
// supabase-js RESOLVES that rather than rejecting. A failed COUNT arrives as
// `count: null`, which the card renders as 0. "NIGHTS 0" is indistinguishable
// from a member who never turns up, and it is baked into a cached PNG that
// stays in channel history forever.
//
// So the embed path is pinned here rather than trusted. If you change the
// nights read in discord-profile.ts, this file must change with it, and the
// point of that friction is that changing it makes you re-check the grant.
//
// NO NETWORK AND NO CREDENTIALS. `global.fetch` is replaced with a stub that
// records the URL and answers `[]`, and the client is constructed against a
// fake host with a fake key. Nothing leaves the process.

import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { PRESENT_STATUSES } from '../schedule';

const SEASON = '11111111-1111-4111-8111-111111111111';
const PLAYER = '22222222-2222-4222-8222-222222222222';

/** Builds a client whose fetch records the request URL instead of making it. */
function recordingClient() {
  const urls: string[] = [];
  const client = createClient('http://pinned.invalid', 'not-a-real-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: ((input: RequestInfo | URL) => {
        urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        return Promise.resolve(
          new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
        );
      }) as typeof fetch,
    },
  });
  return { client, urls };
}

function queryOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

/**
 * The query string of the single request that was recorded.
 *
 * Indexing is checked rather than asserted with `!`: the root type-check runs
 * with noUncheckedIndexedAccess and vitest itself type-checks nothing, so an
 * unguarded urls[0] passes the test run and fails the build.
 */
function onlyQuery(urls: readonly string[]): URLSearchParams {
  expect(urls).toHaveLength(1);
  const [first] = urls;
  if (first === undefined) throw new Error('no request was recorded');
  return queryOf(first);
}

/**
 * The nights read, reproduced exactly as discord-profile.ts builds it.
 *
 * Reproduced rather than imported because loadForm is not exported and pulling
 * it out to make it testable would be a bigger change than the fix. The two
 * must be read side by side; that is what the comment in discord-profile.ts
 * pointing here is for.
 */
function nightsRead(
  client: ReturnType<typeof recordingClient>['client'],
  activeSeasonId: string | null,
) {
  const base = client
    .from('session_attendance')
    .select(activeSeasonId ? 'id, session:sessions!inner(season_id)' : 'id', {
      count: 'exact',
      head: true,
    })
    .eq('player_id', PLAYER)
    .in('status', [...PRESENT_STATUSES]);
  return activeSeasonId ? base.eq('sessions.season_id', activeSeasonId) : base;
}

describe('the Discord card nights count', () => {
  it('joins sessions and filters on the active season', async () => {
    const { client, urls } = recordingClient();
    await nightsRead(client, SEASON);

    const q = onlyQuery(urls);

    // !inner, so the season filter EXCLUDES the attendance row rather than
    // nulling the embed. Without it every night comes back and the filter is
    // decoration.
    expect(q.get('select')).toBe('id,session:sessions!inner(season_id)');

    // The filter is on the EMBEDDED table's column, spelled with the table
    // name and not the alias. `session.season_id` would be a 400.
    expect(q.get('sessions.season_id')).toBe(`eq.${SEASON}`);

    expect(q.get('player_id')).toBe(`eq.${PLAYER}`);
  });

  it('counts present statuses only, and never no_show or excused', async () => {
    const { client, urls } = recordingClient();
    await nightsRead(client, SEASON);

    const status = onlyQuery(urls).get('status') ?? '';
    // A night on the record is not a night attended. If this ever starts
    // including no_show the card rewards not turning up.
    expect(status).not.toContain('no_show');
    expect(status).not.toContain('excused');
    for (const s of PRESENT_STATUSES) expect(status).toContain(s);
  });

  it('asks for a head count, never a row payload', async () => {
    const { client, urls } = recordingClient();
    await nightsRead(client, SEASON);
    // head:true means no rows cross the wire. A member with 200 nights must
    // not ship 200 rows into a card render.
    expect(onlyQuery(urls).has('limit')).toBe(false);
  });

  it('drops the join entirely when no season is active', async () => {
    const { client, urls } = recordingClient();
    await nightsRead(client, null);

    const q = onlyQuery(urls);
    // No season running is a fact about the CLUB. Filtering on a null id would
    // make every member read NIGHTS 0, which is a claim about the member.
    expect(q.get('select')).toBe('id');
    expect(q.has('sessions.season_id')).toBe(false);
    expect(q.get('player_id')).toBe(`eq.${PLAYER}`);
  });
});
