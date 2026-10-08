import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hashDiscordLinkToken } from '@badminton/shared';

const insert = vi.fn();
const maybeSingle = vi.fn();
// Two tables now: the precheck reads player_discord_links, the mint writes
// discord_link_tokens. Routed by name so a chain called on the wrong table
// fails loudly instead of quietly resolving.
vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({
    from: (table: string) =>
      table === 'player_discord_links'
        ? { select: () => ({ eq: () => ({ maybeSingle }) }) }
        : { insert },
  }),
}));

function req(body: unknown, auth = 'Bearer test-secret') {
  return new Request('http://localhost/api/discord/link-tokens', {
    method: 'POST',
    headers: { authorization: auth },
    body: JSON.stringify(body),
  });
}

// The limiter is a module-level map keyed by client IP and is NOT reset
// between tests, so a file with more tests than the 30/60s budget starts
// answering 429 partway through -- which reads as a broken route rather than
// an exhausted bucket. Each call here gets its own IP, so a test is limited
// only by what it does itself.
let bucket = 0;
function freshReq(body: unknown, auth = 'Bearer test-secret') {
  return new Request('http://localhost/api/discord/link-tokens', {
    method: 'POST',
    headers: { authorization: auth, 'x-forwarded-for': `10.0.0.${(bucket += 1)}` },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
  insert.mockReset();
  insert.mockResolvedValue({ error: null });
  maybeSingle.mockReset();
  // Default: this Discord account is not connected to anything.
  maybeSingle.mockResolvedValue({ data: null, error: null });
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

describe('POST /api/discord/link-tokens, already connected', () => {
  it('refuses with 409 and mints nothing', async () => {
    maybeSingle.mockResolvedValue({ data: { discord_user_id: '123456789' }, error: null });
    const { POST } = await import('../route');

    const response = await POST(freshReq({ discordUserId: '123456789' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'already_linked' });
    // The point of the guard: no token exists to be leaked or half-used.
    expect(insert).not.toHaveBeenCalled();
  });

  it('checks the CALLING account, which is what keeps an account move working', async () => {
    // 00165 documents moving to a new Discord account as running /link from
    // the NEW one. That account has no row, so the guard must not fire -- a
    // guard keyed on the player instead of the caller would break the move.
    const { POST } = await import('../route');

    const response = await POST(freshReq({ discordUserId: '999888777' }));

    expect(response.status).toBe(200);
    expect(insert).toHaveBeenCalled();
  });

  it('fails closed when the precheck itself errors', async () => {
    // A read that did not work is not evidence of "not linked". Falling
    // through would hand out a token on the strength of a failed query.
    maybeSingle.mockResolvedValue({ data: null, error: { message: 'relation does not exist' } });
    const { POST } = await import('../route');

    const response = await POST(freshReq({ discordUserId: '123456789' }));

    expect(response.status).toBe(503);
    expect(insert).not.toHaveBeenCalled();
  });
});

