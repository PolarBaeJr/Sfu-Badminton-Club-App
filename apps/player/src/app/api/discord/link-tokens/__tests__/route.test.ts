import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hashDiscordLinkToken } from '@badminton/shared';

const insert = vi.fn();
vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({ from: () => ({ insert }) }),
}));

function req(body: unknown, auth = 'Bearer test-secret') {
  return new Request('http://localhost/api/discord/link-tokens', {
    method: 'POST',
    headers: { authorization: auth },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
  insert.mockReset();
  insert.mockResolvedValue({ error: null });
});

describe('POST /api/discord/link-tokens', () => {
  it('refuses without the service secret', async () => {
    const { POST } = await import('../route');
    expect((await POST(req({ discordUserId: '123456' }, 'Bearer wrong'))).status).toBe(401);
    expect(insert).not.toHaveBeenCalled();
  });

  it('stores only the HASH, never the token', async () => {
    // THE POINT. The plaintext travels in a URL that passes through Discord,
    // the member's browser history and any link preview in between; a dump of
    // this table must not be replayable into a link.
    const { POST } = await import('../route');
    const body = (await (await POST(req({ discordUserId: '123456789' }))).json()) as {
      token: string;
    };

    const row = insert.mock.calls[0]?.[0] as { token_hash: string };
    expect(row.token_hash).toBe(await hashDiscordLinkToken(body.token));
    expect(row.token_hash).not.toBe(body.token);
    expect(JSON.stringify(row)).not.toContain(body.token);
  });

  it('mints a token of the shape every hop revalidates', async () => {
    const { POST } = await import('../route');
    const body = (await (await POST(req({ discordUserId: '123456789' }))).json()) as {
      token: string;
    };
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never repeats a token', async () => {
    const { POST } = await import('../route');
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const body = (await (await POST(req({ discordUserId: '123456789' }))).json()) as {
        token: string;
      };
      seen.add(body.token);
    }
    expect(seen.size).toBe(20);
  });

  it('rejects a discord id that is not a snowflake', async () => {
    const { POST } = await import('../route');
    for (const bad of [undefined, '', 'abc', '12', {}, 123456789]) {
      expect((await POST(req({ discordUserId: bad }))).status).toBe(400);
    }
    expect(insert).not.toHaveBeenCalled();
  });

  it('reports a failed insert as 503 rather than handing out a dead link', async () => {
    // Until 00165 is applied the table does not exist. Returning the token
    // anyway would give the member a link that can never work, and the failure
    // would surface as the migration's vague "expired or already used".
    insert.mockResolvedValue({ error: { message: 'relation does not exist' } });
    const { POST } = await import('../route');
    expect((await POST(req({ discordUserId: '123456789' }))).status).toBe(503);
  });
});
