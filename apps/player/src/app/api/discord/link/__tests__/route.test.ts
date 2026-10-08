import { describe, it, expect, vi, beforeEach } from 'vitest';

const eq = vi.fn();
const select = vi.fn();
vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({
    from: () => ({ delete: () => ({ eq }) }),
  }),
}));

function req(body: unknown, auth = 'Bearer test-secret') {
  return new Request('http://localhost/api/discord/link', {
    method: 'DELETE',
    headers: { authorization: auth },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
  eq.mockReset();
  select.mockReset();
  eq.mockReturnValue({ select });
  select.mockResolvedValue({ data: [{ discord_user_id: '123456789' }], error: null });
});

describe('DELETE /api/discord/link', () => {
  it('refuses without the service secret', async () => {
    const { DELETE } = await import('../route');
    expect((await DELETE(req({ discordUserId: '123456789' }, 'Bearer no'))).status).toBe(401);
    expect(eq).not.toHaveBeenCalled();
  });

  it('deletes by DISCORD id, so it can only ever unlink the caller', async () => {
    // There is deliberately no player_id parameter. The bot knows who ran the
    // command and nothing else, which is exactly the authority it should have.
    const { DELETE } = await import('../route');
    const response = await DELETE(req({ discordUserId: '123456789' }));

    expect(eq).toHaveBeenCalledWith('discord_user_id', '123456789');
    expect(await response.json()).toEqual({ unlinked: true });
  });

  it('reports false when nothing was linked', async () => {
    // Feeds the bot's decision not to strip roles or clear a tombstone for an
    // account it never had a link for.
    select.mockResolvedValue({ data: [], error: null });
    const { DELETE } = await import('../route');
    expect(await (await DELETE(req({ discordUserId: '123456789' }))).json()).toEqual({
      unlinked: false,
    });
  });

  it('rejects a discord id that is not a snowflake', async () => {
    const { DELETE } = await import('../route');
    for (const bad of [undefined, 'abc', '', 12345]) {
      expect((await DELETE(req({ discordUserId: bad }))).status).toBe(400);
    }
    expect(eq).not.toHaveBeenCalled();
  });
});
