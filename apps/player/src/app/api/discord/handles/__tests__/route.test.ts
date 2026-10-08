import { describe, it, expect, vi, beforeEach } from 'vitest';

// The privacy invariant behind the /profile picker, asserted rather than left
// to review.
//
// The route must read get_leaderboard(), the same function resolveProfile's
// handle lookup reads, and must never read players.handle. Reading the table
// directly is faster, looks like a simplification, and would start naming
// members who set hide_from_leaderboard — in a dropdown, to everybody in the
// server. That is exactly the disclosure /profile's "no member on the club
// ladder has that handle" is worded to prevent, and nothing about the change
// would look wrong in a diff.

const rpc = vi.fn();
const from = vi.fn();

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({ rpc, from }),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

const LADDER = [
  { id: 'p1', name: 'Ada Lam', handle: 'ada', doubles_elo: 1200 },
  { id: 'p2', name: 'Bruce Tan', handle: null, doubles_elo: 1100 },
];

function request(authorization?: string) {
  return new Request('http://localhost/api/discord/handles', {
    headers: authorization ? { authorization } : {},
  });
}

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
  rpc.mockReset();
  from.mockReset();
  rpc.mockResolvedValue({ data: LADDER, error: null });
});

describe('GET /api/discord/handles', () => {
  it('refuses without the service secret', async () => {
    const { GET } = await import('../route');

    expect((await GET(request())).status).toBe(401);
    expect((await GET(request('Bearer wrong-secret'))).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('reads the ladder function and never the players table', async () => {
    // THE PROPERTY. A member off the public ladder has no row in
    // get_leaderboard(), so no suggestion can name them.
    const { GET } = await import('../route');
    await GET(request('Bearer test-secret'));

    expect(rpc).toHaveBeenCalledWith('get_leaderboard');
    expect(from).not.toHaveBeenCalled();
  });

  it('publishes names and handles only, dropping members who have no handle', async () => {
    const { GET } = await import('../route');
    const body = (await (await GET(request('Bearer test-secret'))).json()) as {
      members: Record<string, unknown>[];
    };

    // A handle-less member is one nothing can be typed to find, so listing them
    // would only publish a name the picker could not act on.
    expect(body.members).toEqual([{ handle: 'ada', name: 'Ada Lam' }]);
  });

  it('answers 502 on a read failure rather than an empty list', async () => {
    // An empty 200 is indistinguishable, in the picker, from a club with no
    // handles in it — and would be cached as the last good copy by the bot.
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { GET } = await import('../route');
    const response = await GET(request('Bearer test-secret'));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'handles_unavailable' });
  });
});
