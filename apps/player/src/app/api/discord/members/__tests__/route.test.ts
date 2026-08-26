import { describe, it, expect, vi, beforeEach } from 'vitest';

// The app is the ONLY thing that decides what a Discord role means, so this
// route is the boundary the whole design rests on. Two things are pinned here:
// that a read failure never masquerades as "nobody is linked", and that the
// state it publishes matches what the console actually gates on.

// Table-aware, because the route now reads two: the live links and the
// tombstones left behind by links that were deleted. `select` stays the
// links mock so the tests that predate the tombstone read unchanged.
const select = vi.fn();
const selectRevocations = vi.fn();
const deleteIn = vi.fn();

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({
    from: (table: string) =>
      table === 'discord_role_revocations'
        ? { select: selectRevocations, delete: () => ({ in: deleteIn }) }
        : { select },
  }),
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
  selectRevocations.mockReset();
  deleteIn.mockReset();
  // No pending revocations unless a test says otherwise.
  selectRevocations.mockResolvedValue({ data: [], error: null });
  deleteIn.mockResolvedValue({ error: null });
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

describe('revocation tombstones', () => {
  // WHY THIS EXISTS AT ALL: the sweep's input is the link table, so it only
  // ever visits accounts that still have a row. When merge_players deletes the
  // losing player the cascade takes the link with it — and that Discord account
  // keeps every role it was granted, forever, because nothing will ever look at
  // it again. The tombstone is what puts it back in front of the sweep.

  it('publishes a tombstoned account as state: null', async () => {
    select.mockResolvedValue({ data: [], error: null });
    selectRevocations.mockResolvedValue({ data: [{ discord_user_id: 'gone' }], error: null });

    const { GET } = await import('../route');
    const body = (await (await GET(request())).json()) as {
      members: { discordUserId: string; state: unknown }[];
    };

    // state: null is exactly what reconcile already reads as "strip
    // everything", so the tombstone needs no new code path in the bot.
    expect(body.members).toEqual([{ discordUserId: 'gone', state: null }]);
  });

  it('a live link wins over a stale tombstone for the same account', async () => {
    // Only reachable as a race between the two reads — the trigger drops the
    // tombstone on re-link. Stripping an account that currently belongs to
    // somebody is the worse of the two mistakes, so the link wins.
    select.mockResolvedValue({ data: [linkRow()], error: null });
    selectRevocations.mockResolvedValue({ data: [{ discord_user_id: 'd1' }], error: null });

    const { GET } = await import('../route');
    const body = (await (await GET(request())).json()) as {
      members: { discordUserId: string; state: unknown }[];
    };

    expect(body.members).toHaveLength(1);
    expect(body.members[0]?.state).not.toBeNull();
  });

  it('reports a failed tombstone read as 503, not as no tombstones', async () => {
    // Same trap as the links read: an empty list would look like "nothing to
    // revoke" and the stale roles would survive silently.
    select.mockResolvedValue({ data: [], error: null });
    selectRevocations.mockResolvedValue({ data: null, error: { message: 'boom' } });

    const { GET } = await import('../route');
    expect((await GET(request())).status).toBe(503);
  });
});

describe('DELETE /api/discord/members', () => {
  function del(body: unknown) {
    return new Request('http://localhost/api/discord/members', {
      method: 'DELETE',
      ...AUTH,
      body: JSON.stringify(body),
    });
  }

  it('refuses without the service secret', async () => {
    const { DELETE } = await import('../route');
    const response = await DELETE(
      new Request('http://localhost/api/discord/members', {
        method: 'DELETE',
        body: JSON.stringify({ discordUserIds: ['a'] }),
      })
    );
    expect(response.status).toBe(401);
    expect(deleteIn).not.toHaveBeenCalled();
  });

  it('clears the ids the sweep finished', async () => {
    const { DELETE } = await import('../route');
    const response = await DELETE(del({ discordUserIds: ['a', 'b'] }));
    expect(response.status).toBe(200);
    expect(deleteIn).toHaveBeenCalledWith('discord_user_id', ['a', 'b']);
  });

  it('rejects a body that is not a list of strings', async () => {
    // A non-string slipping through would become an `in` filter on something
    // PostgREST interprets, and this endpoint deletes rows.
    const { DELETE } = await import('../route');
    for (const bad of [{}, { discordUserIds: 'a' }, { discordUserIds: [1] }]) {
      expect((await DELETE(del(bad))).status).toBe(400);
    }
    expect(deleteIn).not.toHaveBeenCalled();
  });
});