import { describe, it, expect, vi, beforeEach } from 'vitest';

// The guild map is what turns "this member should have @Internal" into a role
// id. The failure this file exists to prevent: a read error arriving as an
// empty list, published as "no guilds", and read by the bot as a successful
// sweep over nothing.

const selectGuilds = vi.fn();
const selectRoles = vi.fn();
const selectSettings = vi.fn();

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => ({
      select:
        table === 'discord_guilds'
          ? selectGuilds
          : table === 'discord_guild_roles'
            ? selectRoles
            : selectSettings,
    }),
  }),
}));

function request() {
  return new Request('http://localhost/api/discord/config', {
    headers: { authorization: 'Bearer test-secret' },
  });
}

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
  selectGuilds.mockReset();
  selectRoles.mockReset();
  selectSettings.mockReset();
  selectGuilds.mockResolvedValue({ data: [{ guild_id: 'g1', enabled: true }], error: null });
  selectRoles.mockResolvedValue({
    data: [
      { guild_id: 'g1', role_name: 'linked', role_id: '111' },
      { guild_id: 'g1', role_name: 'internal', role_id: '222' },
    ],
    error: null,
  });
  selectSettings.mockResolvedValue({
    data: [{ key: 'audit_channel_id', value: 'chan1' }],
    error: null,
  });
});

describe('GET /api/discord/config', () => {
  it('refuses a request without the service secret', async () => {
    const { GET } = await import('../route');
    const res = await GET(new Request('http://localhost/api/discord/config'));
    expect(res.status).toBe(401);
  });

  it('groups roles under their guild', async () => {
    const { GET } = await import('../route');
    const body = await (await GET(request())).json();
    expect(body.guilds).toEqual([
      { guildId: 'g1', roles: { linked: '111', internal: '222' } },
    ]);
    expect(body.auditChannelId).toBe('chan1');
  });

  it('omits a disabled guild and its roles', async () => {
    selectGuilds.mockResolvedValue({ data: [{ guild_id: 'g1', enabled: false }], error: null });
    const { GET } = await import('../route');
    const body = await (await GET(request())).json();
    expect(body.guilds).toEqual([]);
  });

  // "manage this server, apply nothing" strips every managed role from
  // everybody in it, so a guild with no role rows must not be published.
  it('omits a guild that has no roles rather than sending an empty map', async () => {
    selectRoles.mockResolvedValue({ data: [], error: null });
    const { GET } = await import('../route');
    const body = await (await GET(request())).json();
    expect(body.guilds).toEqual([]);
  });

  it('reports a missing audit channel as null', async () => {
    selectSettings.mockResolvedValue({ data: [], error: null });
    const { GET } = await import('../route');
    const body = await (await GET(request())).json();
    expect(body.auditChannelId).toBeNull();
  });

  // Each of the three reads independently, because a failed PostgREST read
  // arrives as an empty list and any one of them going quiet would publish a
  // config that looks valid and is not.
  it.each([
    ['guilds', () => selectGuilds],
    ['roles', () => selectRoles],
    ['settings', () => selectSettings],
  ])('reports a failed %s read as 503, not as empty config', async (_name, pick) => {
    pick().mockResolvedValue({ data: null, error: { message: 'relation does not exist' } });
    const { GET } = await import('../route');
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('config_unavailable');
  });
});
