import { describe, it, expect } from 'vitest';
import { listChallengeableOpponents } from '../challengeable-opponents';

// A stub PostgREST builder that records the filters applied to it and hands
// back a fixed payload. The point of these tests is WHICH FILTERS ARE SENT —
// the bug being fixed was a missing one — so the recording is the assertion.
function stubClient(result: { data?: unknown[]; error?: unknown } = { data: [] }) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const builder: any = {
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
  };
  for (const fn of ['select', 'eq', 'not', 'neq']) {
    builder[fn] = (...args: unknown[]) => {
      calls.push({ fn, args });
      return builder;
    };
  }
  return {
    calls,
    client: {
      from: (table: string) => {
        calls.push({ fn: 'from', args: [table] });
        return builder;
      },
    },
  };
}

describe('listChallengeableOpponents', () => {
  // THE REGRESSION TEST. `is_banned` is not readable by `authenticated` after
  // 00032, so this filter can only exist on the server — and it was missing
  // entirely, which is why a banned member showed up in the picker.
  it('filters out banned members', async () => {
    const { calls, client } = stubClient();
    await listChallengeableOpponents(undefined, client);
    expect(calls).toContainEqual({ fn: 'eq', args: ['is_banned', false] });
  });

  // The service-role client bypasses RLS, so every filter the browser used to
  // apply has to be re-applied here or the list gets WIDER, not narrower.
  it('keeps the filters the browser query already had', async () => {
    const { calls, client } = stubClient();
    await listChallengeableOpponents('me-id', client);
    expect(calls).toContainEqual({ fn: 'from', args: ['players'] });
    expect(calls).toContainEqual({ fn: 'eq', args: ['active_flag', true] });
    expect(calls).toContainEqual({ fn: 'not', args: ['status', 'in', '("pending_approval","suspended")'] });
    expect(calls).toContainEqual({ fn: 'neq', args: ['id', 'me-id'] });
  });

  // getCurrentPlayer() can return null. Sending `.neq('id', '')` — which is
  // what the old client did — is a filter against an empty string, so leaving
  // it off entirely is the honest version. Self-challenge is still refused by
  // validate_challenge_creation.
  it('omits the self-exclusion when the viewer id is unknown', async () => {
    const { calls, client } = stubClient();
    await listChallengeableOpponents(null, client);
    expect(calls.some((c) => c.fn === 'neq')).toBe(false);
  });

  it('never selects is_banned back out to the caller', async () => {
    const { calls, client } = stubClient();
    await listChallengeableOpponents(undefined, client);
    const select = calls.find((c) => c.fn === 'select');
    expect(String(select?.args[0])).not.toContain('is_banned');
  });

  it('flattens the embedded ratings row and seeds a missing one at 400', async () => {
    const { client } = stubClient({
      data: [
        { id: 'a', full_name: 'A', handle: 'a', ratings: [{ singles_elo: 1200, doubles_elo: 1100 }] },
        { id: 'b', full_name: 'B', handle: null, ratings: null },
      ],
    });
    expect(await listChallengeableOpponents(undefined, client)).toEqual([
      { id: 'a', full_name: 'A', handle: 'a', singles_elo: 1200, doubles_elo: 1100 },
      { id: 'b', full_name: 'B', handle: null, singles_elo: 400, doubles_elo: 400 },
    ]);
  });

  // The browser query it replaces selected avatar_url and then dropped it on
  // the floor, so the picker has always rendered with avatarUrl null on this
  // screen. Returning it would be an unrequested visual change.
  it('does not reintroduce avatar_url', async () => {
    const { calls, client } = stubClient({ data: [{ id: 'a', full_name: 'A', handle: null, ratings: null }] });
    const rows = await listChallengeableOpponents(undefined, client);
    expect(String(calls.find((c) => c.fn === 'select')?.args[0])).not.toContain('avatar_url');
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {})).not.toContain('avatar_url');
  });

  it('returns an empty list rather than throwing when the read fails', async () => {
    const { client } = stubClient({ error: { message: 'boom' } });
    expect(await listChallengeableOpponents(undefined, client)).toEqual([]);
  });

  // FIX-LIST #14. get_leaderboard() leaves an opted-out member off the ladder
  // entirely; this picker printed their Elo as a trailing label on every row,
  // which is the same number by a different route. The settings switch says
  // "Your rank will be visible to others", so it has to bind here too.
  it('withholds the rating of a member who has opted out of the leaderboard', async () => {
    const { client } = stubClient({
      data: [
        { id: 'a', full_name: 'A', handle: 'a', hide_from_leaderboard: false, ratings: [{ singles_elo: 1200, doubles_elo: 1100 }] },
        { id: 'b', full_name: 'B', handle: 'b', hide_from_leaderboard: true, ratings: [{ singles_elo: 1650, doubles_elo: 1580 }] },
      ],
    });
    const rows = await listChallengeableOpponents(undefined, client);

    // Still challengeable — this is a rating control, not a block list.
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(rows[0]).toMatchObject({ singles_elo: 1200, doubles_elo: 1100 });
    expect(rows[1]).toMatchObject({ singles_elo: null, doubles_elo: null });

    // NULL, NOT THE 400 SEED. "Opted out" and "never played" are different
    // statements, and defaulting would publish a plausible rating rather than
    // no rating — which is worse than the leak it replaces, because it reads
    // as true.
    expect(rows[1]!.singles_elo).not.toBe(400);
    expect(JSON.stringify(rows)).not.toContain('1650');
  });

  it('does not tell the browser WHO opted out', async () => {
    // The flag is a filter on what comes back, never a field that goes out —
    // the same shape is_banned is used in above. A picker that knew which
    // members had opted out would publish the choice itself, which is a
    // smaller leak of the same kind.
    const { calls, client } = stubClient({
      data: [{ id: 'b', full_name: 'B', handle: null, hide_from_leaderboard: true, ratings: null }],
    });
    const rows = await listChallengeableOpponents(undefined, client);
    expect(String(calls.find((c) => c.fn === 'select')?.args[0])).toContain('hide_from_leaderboard');
    expect(Object.keys(rows[0] ?? {})).not.toContain('hide_from_leaderboard');
  });
});
