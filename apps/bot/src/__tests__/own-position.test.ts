import { describe, it, expect, vi } from 'vitest';
import { DiscordApi } from '../discord-api.js';

/** A fetch stub that records every path it is asked for. */
function recordingFetch(table: Record<string, { status: number; body?: unknown }>) {
  const seen: string[] = [];
  const impl = vi.fn(async (url: string | URL | Request) => {
    const href = typeof url === 'string' ? url : url.toString();
    const path = href.replace('https://discord.com/api/v10', '');
    seen.push(path);
    const hit = table[path] ?? { status: 404 };
    return new Response(hit.body === undefined ? null : JSON.stringify(hit.body), {
      status: hit.status,
    });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

const GUILD = '999';
const BOT_ID = '42';

const HAPPY = {
  '/users/@me': { status: 200, body: { id: BOT_ID } },
  [`/guilds/${GUILD}/members/${BOT_ID}`]: { status: 200, body: { roles: ['r1', 'r2'] } },
  [`/guilds/${GUILD}/roles`]: {
    status: 200,
    body: [
      { id: 'everyone', name: '@everyone', position: 0, managed: false, permissions: '0' },
      { id: 'r1', name: 'low', position: 3, managed: false, permissions: '0' },
      { id: 'r2', name: 'high', position: 7, managed: false, permissions: '0' },
      { id: 'other', name: 'not mine', position: 20, managed: false, permissions: '0' },
    ],
  },
};

describe('getOwnRolePosition', () => {
  // The bug this pins: the member lookup used `@me` as the final path segment.
  // `@me` is only valid on /users/@me. On /guilds/{id}/members/{user_id}
  // Discord parses that segment as a number and answers 400
  // NUMBER_TYPE_COERCE -- which the caller then reported as a missing
  // Manage Roles permission, sending an admin to re-grant a permission the
  // bot already held.
  it('never puts @me in the guild members path', async () => {
    const { impl, seen } = recordingFetch(HAPPY);
    const api = new DiscordApi({ token: 't', fetchImpl: impl, sleep: async () => {} });

    await api.getOwnRolePosition(GUILD);

    const memberCalls = seen.filter((p) => p.includes('/members/'));
    expect(memberCalls.length).toBeGreaterThan(0);
    for (const path of memberCalls) {
      expect(path).not.toContain('@me');
    }
    expect(seen).toContain(`/guilds/${GUILD}/members/${BOT_ID}`);
  });

  it('returns the highest position among the roles the bot actually holds', async () => {
    const { impl } = recordingFetch(HAPPY);
    const api = new DiscordApi({ token: 't', fetchImpl: impl, sleep: async () => {} });

    // 7, not 20: `other` is higher but the bot does not hold it.
    expect(await api.getOwnRolePosition(GUILD)).toBe(7);
  });

  it('resolves its own id once and reuses it across guilds', async () => {
    const { impl, seen } = recordingFetch({
      ...HAPPY,
      '/guilds/888/members/42': { status: 200, body: { roles: ['r1'] } },
      '/guilds/888/roles': {
        status: 200,
        body: [{ id: 'r1', name: 'low', position: 3, managed: false, permissions: '0' }],
      },
    });
    const api = new DiscordApi({ token: 't', fetchImpl: impl, sleep: async () => {} });

    await api.getOwnRolePosition(GUILD);
    await api.getOwnRolePosition('888');

    expect(seen.filter((p) => p === '/users/@me')).toHaveLength(1);
  });

  it('reports a member-lookup failure rather than swallowing it', async () => {
    const { impl } = recordingFetch({
      '/users/@me': { status: 200, body: { id: BOT_ID } },
      [`/guilds/${GUILD}/members/${BOT_ID}`]: { status: 403 },
      [`/guilds/${GUILD}/roles`]: { status: 200, body: [] },
    });
    const api = new DiscordApi({ token: 't', fetchImpl: impl, sleep: async () => {} });

    await expect(api.getOwnRolePosition(GUILD)).rejects.toThrow(/403/);
  });

  it('fails loudly when /users/@me gives back no id', async () => {
    const { impl } = recordingFetch({ '/users/@me': { status: 200, body: {} } });
    const api = new DiscordApi({ token: 't', fetchImpl: impl, sleep: async () => {} });

    await expect(api.getOwnRolePosition(GUILD)).rejects.toThrow(/no id/);
  });
});
