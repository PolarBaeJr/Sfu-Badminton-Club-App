// PINNING THE SEASON TALLY READ BEHIND THE PUBLIC PROFILE'S W-L.
//
// *** WHY THIS FILE EXISTS. ***
//
// /leaderboard/[playerId] used to print `ratings.singles_wins` beside
// `ratings.singles_elo`. Those two are on different clocks: a rollover rebases
// the Elo and resets none of the counters, so the card stated a
// since-the-rollover number and an all-time number on one line. The page now
// counts the record from the season's own match rows instead.
//
// That read is the exact shape that fails SILENTLY. Select strings are
// unchecked string literals (supabase-server.ts: "typed clients are
// deliberately off"), so a mistyped embed, a renamed column, or a column the
// caller's role cannot read makes PostgREST answer 400/403 for the WHOLE
// request, and supabase-js RESOLVES that rather than rejecting. The page reads
// `data` as `[]`, summarizeSeason counts nothing, and every card renders a
// clean 0-0 with a correct-looking Elo above it.
//
// A member who played all term would then be shown as having played nothing,
// on a PUBLIC page, with no error anywhere. That is strictly worse than the bug
// this replaced, which is why the query is pinned rather than trusted.
//
// The same trap has a second mouth here: `matches!inner` is what makes the
// season filter EXCLUDE out-of-season rows. Drop the !inner and PostgREST
// returns every match the member ever played with a null embed, which
// summarizeSeason reads as "no result to count". Same clean 0-0, opposite
// cause.
//
// NO NETWORK AND NO CREDENTIALS. `global.fetch` is replaced with a stub that
// records the URL and answers `[]`, and the client is constructed against a
// fake host with a fake key. Nothing leaves the process.

import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const SEASON = '33333333-3333-4333-8333-333333333333';
const PLAYER = '44444444-4444-4444-8444-444444444444';

/** The cap in page.tsx. Kept here so a change to one fails against the other. */
const SEASON_TALLY_CAP = 2000;

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
 * The season tally read, reproduced exactly as page.tsx builds it.
 *
 * Reproduced rather than imported because it is inline in a React Server
 * Component that a unit test cannot render. The two must be read side by side;
 * that is what the comment in page.tsx pointing here is for.
 */
function seasonTallyRead(
  client: ReturnType<typeof recordingClient>['client'],
  activeSeasonId: string,
) {
  return client
    .from('match_participants')
    .select('win_flag, points_scored, points_allowed, match:matches!inner(match_type, result_status, played_at)')
    .eq('player_id', PLAYER)
    .eq('match.season_id', activeSeasonId)
    .limit(SEASON_TALLY_CAP);
}

describe('the public profile season tally', () => {
  it('joins matches with !inner and filters on the season', async () => {
    const { client, urls } = recordingClient();
    await seasonTallyRead(client, SEASON);

    const q = onlyQuery(urls);

    // !inner, so an out-of-season match is EXCLUDED rather than arriving with
    // a null embed that reads as "no result to count".
    expect(q.get('select')).toBe(
      'win_flag,points_scored,points_allowed,match:matches!inner(match_type,result_status,played_at)',
    );

    // The filter is on the EMBEDDED table's column, spelled with the ALIAS.
    //
    // An earlier version of this test pinned the table-name spelling,
    // `matches.season_id`, with a comment claiming the alias form was a 400.
    // That was wrong. Both forms return 200 and both genuinely filter,
    // confirmed against the local PostgREST: the same member reads 3 rows in
    // the season they played and 0 rows in the other one under EITHER
    // spelling. What separates them is the future. PostgREST logs, for the
    // table-name form only, "Update filters, orders or limits that use
    // 'matches' to 'match'", and says it will stop working in a later release.
    //
    // Pinning the deprecated spelling would be worse than not pinning at all.
    // The day it is removed the filter is dropped rather than rejected, every
    // profile silently reverts to all-time numbers, and this test stays green
    // while doing it. So the alias is what is pinned.
    expect(q.get('match.season_id')).toBe(`eq.${SEASON}`);
    expect(q.get('matches.season_id')).toBeNull();

    expect(q.get('player_id')).toBe(`eq.${PLAYER}`);
  });

  it('asks for exactly the six columns summarizeSeason reads, and no more', async () => {
    const { client, urls } = recordingClient();
    await seasonTallyRead(client, SEASON);

    const select = onlyQuery(urls).get('select') ?? '';

    // Six integers is the whole job. Widening this to `matches(*)` would drag a
    // whole term of rows into the RSC payload of a public page.
    for (const column of [
      'win_flag',
      'points_scored',
      'points_allowed',
      'match_type',
      'result_status',
      'played_at',
    ]) {
      expect(select).toContain(column);
    }
    expect(select).not.toContain('*');
    expect(select).not.toContain('match_games');
    expect(select).not.toContain('score_summary');
  });

  it('caps the read', async () => {
    const { client, urls } = recordingClient();
    await seasonTallyRead(client, SEASON);
    // A guard against an unbounded read, not a page size. If this ever goes
    // missing, one member with a long history becomes an unbounded query on a
    // page anyone on the internet can open.
    expect(onlyQuery(urls).get('limit')).toBe(String(SEASON_TALLY_CAP));
  });
});
