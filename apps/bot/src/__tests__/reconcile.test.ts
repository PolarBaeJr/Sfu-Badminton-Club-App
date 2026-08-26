import { describe, it, expect, vi, afterEach } from 'vitest';
import { DiscordApi } from '../discord-api.js';
import { reconcile, type LinkedMember } from '../reconcile.js';
import { parseGuildRegistry, type MemberState } from '../roles.js';
import { isAuthorizedService } from '../service-auth.js';

function state(overrides: Partial<MemberState> = {}): MemberState {
  return {
    status: 'recreational',
    membershipType: 'internal',
    isExec: false,
    isBanned: false,
    permissionRole: null,
    capabilities: [],
    ...overrides,
  };
}

function api(handler: (method: string, path: string) => { status: number; body?: unknown }) {
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = (typeof url === 'string' ? url : url.toString())
      .replace('https://discord.com/api/v10', '');
    const { status, body } = handler(init?.method ?? 'GET', path);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return new DiscordApi({ token: 't', fetchImpl, sleep: async () => {} });
}

const REGISTRY = parseGuildRegistry('{"g1":{"linked":"1","executives":"2","internal":"3"}}');

describe('reconcile', () => {
  it('syncs every member and totals the result', async () => {
    const a = api((method) =>
      method === 'GET' ? { status: 200, body: { roles: [] } } : { status: 204 }
    );
    const members: LinkedMember[] = [
      { discordUserId: 'u1', state: state() },
      { discordUserId: 'u2', state: state({ isExec: true }) },
    ];

    const summary = await reconcile(a, REGISTRY, members, () => {});
    expect(summary.members).toBe(2);
    // u1: linked+internal = 2. u2: linked+internal+executives = 3.
    expect(summary.added).toBe(5);
    expect(summary.failed).toBe(0);
  });

  it('strips roles from a member the app can no longer resolve', async () => {
    const a = api((method) =>
      method === 'GET' ? { status: 200, body: { roles: ['1', '2', '3'] } } : { status: 204 }
    );
    const summary = await reconcile(a, REGISTRY, [{ discordUserId: 'u1', state: null }], () => {});
    expect(summary.removed).toBe(3);
    expect(summary.added).toBe(0);
  });

  // ---- THE TOMBSTONE CONTRACT ----
  //
  // A revocation may only be deleted once the account is genuinely clean in
  // every guild. Deleting one early is a stale privilege that nothing will ever
  // revisit, because the link row it came from is already gone.

  it('reports a fully stripped tombstone as cleared', async () => {
    const a = api((method) =>
      method === 'GET' ? { status: 200, body: { roles: ['1', '2', '3'] } } : { status: 204 }
    );
    const summary = await reconcile(a, REGISTRY, [{ discordUserId: 'u1', state: null }], () => {});
    expect(summary.cleared).toEqual(['u1']);
  });

  it('does NOT clear a tombstone Discord refused to strip', async () => {
    // The case that matters: the account outranks the bot, every DELETE is a
    // 403, and the roles are all still there. Clearing here loses the pending
    // revocation permanently.
    const a = api((method) =>
      method === 'GET' ? { status: 200, body: { roles: ['1', '2', '3'] } } : { status: 403 }
    );
    const summary = await reconcile(a, REGISTRY, [{ discordUserId: 'u1', state: null }], () => {});
    expect(summary.forbidden).toBe(3);
    expect(summary.removed).toBe(0);
    expect(summary.cleared).toEqual([]);
  });

  it('does NOT clear a tombstone when a strip failed outright', async () => {
    const a = api((method) =>
      method === 'GET' ? { status: 200, body: { roles: ['1', '2', '3'] } } : { status: 500 }
    );
    const summary = await reconcile(a, REGISTRY, [{ discordUserId: 'u1', state: null }], () => {});
    expect(summary.cleared).toEqual([]);
  });

  it('counts an absent tombstone as cleared', async () => {
    // Not in the guild at all: roles they do not hold cannot be stale, so the
    // revocation is satisfied and must not be retried forever.
    const a = api(() => ({ status: 404 }));
    const summary = await reconcile(a, REGISTRY, [{ discordUserId: 'u1', state: null }], () => {});
    expect(summary.absent).toBe(1);
    expect(summary.cleared).toEqual(['u1']);
  });

  it('never clears a live member', async () => {
    const a = api((method) =>
      method === 'GET' ? { status: 200, body: { roles: [] } } : { status: 204 }
    );
    const summary = await reconcile(a, REGISTRY, [{ discordUserId: 'u1', state: state() }], () => {});
    expect(summary.added).toBeGreaterThan(0);
    expect(summary.cleared).toEqual([]);
  });

  it('one member failing does not end the sweep for the rest', async () => {
    const a = api((method, path) => {
      if (path.includes('/members/u1')) return { status: 500 };
      if (method === 'GET') return { status: 200, body: { roles: [] } };
      return { status: 204 };
    });
    const summary = await reconcile(
      a, REGISTRY,
      [{ discordUserId: 'u1', state: state() }, { discordUserId: 'u2', state: state() }],
      () => {}
    );
    expect(summary.members).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.added).toBe(2); // u2 still synced
  });

  it('an exec who outranks the bot is counted, not fatal', async () => {
    const a = api((method, path) => {
      if (method === 'GET') return { status: 200, body: { roles: [] } };
      if (path.endsWith('/roles/2')) return { status: 403 };
      return { status: 204 };
    });
    const summary = await reconcile(
      a, REGISTRY, [{ discordUserId: 'u1', state: state({ isExec: true }) }], () => {}
    );
    expect(summary.forbidden).toBe(1);
    expect(summary.added).toBe(2);
    expect(summary.failed).toBe(0);
  });

  it('says so when no guilds are registered instead of reporting a silent success', async () => {
    const lines: string[] = [];
    const a = api(() => ({ status: 200, body: { roles: [] } }));
    const summary = await reconcile(a, parseGuildRegistry(''), [
      { discordUserId: 'u1', state: state() },
    ], (l) => lines.push(l));
    expect(summary.members).toBe(0);
    expect(lines.join(' ')).toMatch(/no guilds registered/);
  });

  it('stays quiet about members who needed no change', async () => {
    const lines: string[] = [];
    const a = api((method) =>
      method === 'GET' ? { status: 200, body: { roles: ['1', '3'] } } : { status: 204 }
    );
    await reconcile(a, REGISTRY, [{ discordUserId: 'u1', state: state() }], (l) => lines.push(l));
    // Only the closing summary line, no per-member noise.
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/swept 1 members/);
  });
});

describe('isAuthorizedService', () => {
  const original = process.env.DISCORD_SERVICE_SECRET;
  afterEach(() => {
    if (original === undefined) delete process.env.DISCORD_SERVICE_SECRET;
    else process.env.DISCORD_SERVICE_SECRET = original;
  });

  it('fails closed when no secret is configured', () => {
    delete process.env.DISCORD_SERVICE_SECRET;
    expect(isAuthorizedService('Bearer anything')).toBe(false);
  });

  it('accepts the configured secret and nothing else', () => {
    process.env.DISCORD_SERVICE_SECRET = 'correct-horse';
    expect(isAuthorizedService('Bearer correct-horse')).toBe(true);
    expect(isAuthorizedService('Bearer wrong')).toBe(false);
    expect(isAuthorizedService('Bearer correct-horse-extra')).toBe(false);
    expect(isAuthorizedService('correct-horse')).toBe(false);
    expect(isAuthorizedService(undefined)).toBe(false);
    expect(isAuthorizedService('')).toBe(false);
  });
});
