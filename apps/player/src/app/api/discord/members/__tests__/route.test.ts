import { describe, it, expect, vi, beforeEach } from 'vitest';

// The app is the ONLY thing that decides what a Discord role means, so this
// route is the boundary the whole design rests on. Two things are pinned here:
// that a read failure never masquerades as "nobody is linked", and that the
// state it publishes matches what the console actually gates on.

const select = vi.fn();
vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({ from: () => ({ select }) }),
}));

const AUTH = { headers: { authorization: 'Bearer test-secret' } };

function request() {
  return new Request('http://localhost/api/discord/members', AUTH);
}

function linkRow(overrides: Record<string, unknown> = {}) {
  return {
    discord_user_id: 'd1',
    player_id: 'p1',
    players: {
      status: 'recreational',
      membership_type: 'internal',
      is_exec: false,
      is_trainer: false,
      is_banned: false,
      role: 'player',
      permission_role: null,
      permission_grants: [],
      permission_revokes: [],
      ...overrides,
    },
  };
}

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
  select.mockReset();
});

describe('GET /api/discord/members', () => {
  it('refuses without the service secret', async () => {
    const { GET } = await import('../route');
    const response = await GET(new Request('http://localhost/api/discord/members'));
    expect(response.status).toBe(401);
  });

  it('reports a read failure as 503, NOT as an empty roster', async () => {
    // THE POINT. Until 00165 is applied the table does not exist, and a failed
    // PostgREST read comes back as an empty list rather than an exception. A
    // route that returned { members: [] } here would make the sweep look like a
    // quiet success while it silently stripped nobody and synced nobody.
    select.mockResolvedValue({ data: null, error: { message: 'relation does not exist' } });

    const { GET } = await import('../route');
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'members_unavailable' });
  });

  it('publishes an ordinary member', async () => {
    select.mockResolvedValue({ data: [linkRow()], error: null });

    const { GET } = await import('../route');
    const body = (await (await GET(request())).json()) as {
      members: { discordUserId: string; state: Record<string, unknown> | null }[];
    };

    expect(body.members).toHaveLength(1);
    expect(body.members[0]?.discordUserId).toBe('d1');
    expect(body.members[0]?.state).toMatchObject({
      status: 'recreational',
      membershipType: 'internal',
      isExec: false,
      isBanned: false,
      permissionRole: null,
    });
    // A plain member holds no console capabilities at all.
    expect((body.members[0]?.state as { capabilities: string[] }).capabilities).toEqual([]);
  });

  it('gives an admin the capabilities the console gives them', async () => {
    select.mockResolvedValue({
      data: [linkRow({ role: 'admin', is_exec: true })],
      error: null,
    });

    const { GET } = await import('../route');
    const body = (await (await GET(request())).json()) as {
      members: { state: { capabilities: string[] } }[];
    };

    const caps = body.members[0]?.state.capabilities ?? [];
    // Not an assertion about a number, which would just pin today's list — an
    // assertion that the resolver ran and admin reaches the session pair the
    // Session Staff role is defined by.
    expect(caps).toContain('sessions.attendance.write');
    expect(caps).toContain('sessions.checkin.token.write');
  });

  it('passes a ban through rather than resolving it away', async () => {
    // The route reports; roles.ts decides. Stripping here as well would put the
    // rule in two places, and the two would drift.
    select.mockResolvedValue({ data: [linkRow({ is_banned: true })], error: null });

    const { GET } = await import('../route');
    const body = (await (await GET(request())).json()) as {
      members: { state: { isBanned: boolean } }[];
    };
    expect(body.members[0]?.state.isBanned).toBe(true);
  });

  it('treats a link the app cannot resolve as no state at all', async () => {
    // A deleted account, or a duplicate merged away. The sweep reads null as
    // "strip everything", which is the same path /unlink takes.
    select.mockResolvedValue({
      data: [{ discord_user_id: 'd1', player_id: 'p1', players: null }],
      error: null,
    });

    const { GET } = await import('../route');
    const body = (await (await GET(request())).json()) as { members: { state: null }[] };
    expect(body.members[0]?.state).toBeNull();
  });

  it('defaults a null membership_type to internal, like the app does', async () => {
    select.mockResolvedValue({ data: [linkRow({ membership_type: null })], error: null });

    const { GET } = await import('../route');
    const body = (await (await GET(request())).json()) as {
      members: { state: { membershipType: string } }[];
    };
    expect(body.members[0]?.state.membershipType).toBe('internal');
  });
});
