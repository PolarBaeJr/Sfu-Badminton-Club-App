// PINNING THE TWO SEASON FILTERS BEHIND THE TOURNAMENT CALENDAR.
//
// *** WHY THIS FILE EXISTS. ***
//
// /tournaments reads its calendar two different ways on purpose, and the whole
// value of the season picker is in the difference.
//
// The BARE path goes through scopeToActiveSeason, which is loose by design: it
// admits rows whose season_id IS NULL, and with no active season it drops the
// filter entirely and returns every tournament the club has ever held. That is
// the right answer to "what is on the calendar now", where an unassigned
// tournament still belongs somewhere.
//
// An EXPLICIT `?season=<uuid>` is a member naming a term. Reusing the loose
// filter there silently widens the page: a past season would be shown with
// today's unassigned rows mixed into it, and the moment no season is active it
// would list every tournament in the database under the name of one term. So
// that branch is a strict `.eq` and this file exists to keep the two apart,
// because they are one refactor away from being collapsed into a single call
// that "does the same thing".
//
// It also pins that neither branch ever lists a draft: tournaments_select is
// USING (TRUE), so the status filter in the query is the only thing keeping an
// unpublished tournament off a member's calendar.
//
// Nothing else catches it. Select strings are unchecked string literals
// (supabase-server.ts: "typed clients are deliberately off"), and a PostgREST
// read that comes back 400/403 RESOLVES rather than rejecting, so a wrong or
// missing filter arrives as data and renders as a plausible page.
//
// NO NETWORK AND NO CREDENTIALS. `global.fetch` is replaced with a stub that
// records the URL and answers `[]`, and the client is constructed against a
// fake host with a fake key. Nothing leaves the process.

import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { tournamentCalendarQuery } from '@/lib/tournament-index';

const ACTIVE = '11111111-1111-4111-8111-111111111111';
const PICKED = '22222222-2222-4222-8222-222222222222';

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
  return new URL(first).searchParams;
}

/**
 * The calendar read, imported from lib/tournament-index.ts, the same builder
 * page.tsx calls, so what is pinned here is the code that runs and not a copy.
 */
function calendarRead(
  client: ReturnType<typeof recordingClient>['client'],
  season: { pickedId: string | null; activeId: string | null },
) {
  return tournamentCalendarQuery(client, season);
}

describe('the tournament calendar read', () => {
  it('never lists a draft, on either branch', async () => {
    for (const season of [
      { pickedId: null, activeId: ACTIVE },
      { pickedId: PICKED, activeId: ACTIVE },
      { pickedId: null, activeId: null },
    ]) {
      const { client, urls } = recordingClient();
      await calendarRead(client, season);
      expect(onlyQuery(urls).get('status')).toBe('neq.draft');
    }
  });

  it('is loose on the bare path, including rows with no season', async () => {
    const { client, urls } = recordingClient();
    await calendarRead(client, { pickedId: null, activeId: ACTIVE });

    const q = onlyQuery(urls);

    // The `is.null` arm is the point: an undated tournament still shows on the
    // calendar rather than being stranded on no page at all.
    expect(q.get('or')).toBe(`(season_id.eq.${ACTIVE},season_id.is.null)`);
    expect(q.get('season_id')).toBeNull();
  });

  it('is strict on an explicit pick, with no or= arm at all', async () => {
    const { client, urls } = recordingClient();
    await calendarRead(client, { pickedId: PICKED, activeId: ACTIVE });

    const q = onlyQuery(urls);

    expect(q.get('season_id')).toBe(`eq.${PICKED}`);
    expect(q.get('or')).toBeNull();

    // Neither the active season nor the unassigned rows leak into a term the
    // member named. Asserted on the whole query string, because an `or` arm is
    // not the only way one could get back in.
    expect(q.toString()).not.toContain(ACTIVE);
    expect(q.toString()).not.toContain('is.null');
  });

  it('sends genuinely different requests for the two, one filter each', async () => {
    const bare = recordingClient();
    await calendarRead(bare.client, { pickedId: null, activeId: ACTIVE });
    const picked = recordingClient();
    await calendarRead(picked.client, { pickedId: PICKED, activeId: ACTIVE });

    const bareQuery = onlyQuery(bare.urls);
    const pickedQuery = onlyQuery(picked.urls);

    // A refactor that folds the branch into one call satisfies one of these
    // two shapes and fails the other, whichever way it goes.
    expect(bareQuery.toString()).not.toBe(pickedQuery.toString());
    expect([bareQuery.has('or'), bareQuery.has('season_id')]).toEqual([true, false]);
    expect([pickedQuery.has('or'), pickedQuery.has('season_id')]).toEqual([false, true]);
  });

  it('drops the filter entirely when no season is active, on the bare path only', async () => {
    const { client, urls } = recordingClient();
    await calendarRead(client, { pickedId: null, activeId: null });

    const q = onlyQuery(urls);

    // Unfiltered, and deliberately so (active-season.ts): a club that forgot to
    // activate a season gets too much rather than an empty schedule. It is also
    // exactly the state the strict branch exists to keep an explicit pick out
    // of, which is why the pick never consults the active season at all.
    expect(q.get('or')).toBeNull();
    expect(q.get('season_id')).toBeNull();
  });
});
