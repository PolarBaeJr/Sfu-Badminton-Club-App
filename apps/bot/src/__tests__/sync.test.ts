import { describe, it, expect, vi } from 'vitest';
import { DiscordApi } from '../discord-api.js';
import { syncMemberInGuild, syncMemberEverywhere, describeOutcomes } from '../sync.js';
import { desiredRoles, parseGuildRegistry, type MemberState } from '../roles.js';

const GUILD = { linked: '1', executives: '2', internal: '3', competitive: '4' };

function member(overrides: Partial<MemberState> = {}): MemberState {
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

/** A fetch stub driven by a per-path status table. */
function fakeFetch(handler: (method: string, path: string) => { status: number; body?: unknown }) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url.toString();
    const path = href.replace('https://discord.com/api/v10', '');
    const { status, body } = handler(init?.method ?? 'GET', path);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

function apiWith(handler: Parameters<typeof fakeFetch>[0], sleep = async () => {}) {
  const fetchImpl = fakeFetch(handler);
  return { api: new DiscordApi({ token: 't', fetchImpl, sleep }), fetchImpl };
}

describe('syncMemberInGuild', () => {
  it('adds what is missing and removes what is no longer earned', async () => {
    const { api } = apiWith((method, path) => {
      if (method === 'GET') return { status: 200, body: { roles: ['2'] } };
      return { status: 204 };
    });

    const out = await syncMemberInGuild(
      api, 'g1', GUILD, 'u1',
      desiredRoles(member({ status: 'competitive' }))
    );

    // wants linked+internal+competitive, holds executives
    expect(out.added).toBe(3);
    expect(out.removed).toBe(1);
    expect(out.forbidden).toBe(0);
    expect(out.failed).toBe(0);
  });

  it('reports a member who is not in the guild without touching anything', async () => {
    const { api, fetchImpl } = apiWith(() => ({ status: 404 }));
    const out = await syncMemberInGuild(api, 'g1', GUILD, 'u1', desiredRoles(member()));
    expect(out.absent).toBe(true);
    expect(out.added).toBe(0);
    // Exactly one call: the member lookup. No role calls were attempted.
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('KEEPS GOING when Discord refuses a role because the member outranks the bot', async () => {
    // The whole point. An exec 403s on @Executives; @Internal must still land.
    const { api } = apiWith((method, path) => {
      if (method === 'GET') return { status: 200, body: { roles: [] } };
      if (path.endsWith('/roles/2')) return { status: 403 };
      return { status: 204 };
    });

    const out = await syncMemberInGuild(
      api, 'g1', GUILD, 'u1',
      desiredRoles(member({ isExec: true }))
    );

    expect(out.forbidden).toBe(1);
    // linked + internal still applied despite the refusal.
    expect(out.added).toBe(2);
    expect(out.failed).toBe(0);
  });

  it('strips every managed role when the member is not linked', async () => {
    const calls: string[] = [];
    const { api } = apiWith((method, path) => {
      calls.push(`${method} ${path}`);
      if (method === 'GET') return { status: 200, body: { roles: ['1', '2', '3', '99'] } };
      return { status: 204 };
    });

    const out = await syncMemberInGuild(api, 'g1', GUILD, 'u1', null);
    expect(out.removed).toBe(3);
    expect(out.added).toBe(0);
    // '99' is a role the registry does not name — never touched.
    expect(calls.some((c) => c.includes('/roles/99'))).toBe(false);
  });

  it('counts a hard failure without throwing', async () => {
    const { api } = apiWith((method) => {
      if (method === 'GET') return { status: 200, body: { roles: [] } };
      return { status: 500 };
    });
    const out = await syncMemberInGuild(api, 'g1', GUILD, 'u1', desiredRoles(member()));
    expect(out.failed).toBeGreaterThan(0);
    expect(out.added).toBe(0);
  });

  it('does not throw when the member lookup itself fails', async () => {
    const { api } = apiWith((method) => {
      if (method === 'GET') return { status: 500 };
      return { status: 204 };
    });
    const out = await syncMemberInGuild(api, 'g1', GUILD, 'u1', desiredRoles(member()));
    expect(out.failed).toBe(1);
    expect(out.absent).toBe(false);
  });

  it('does not treat a deleted role as a failure', async () => {
    const { api } = apiWith((method) => {
      if (method === 'GET') return { status: 200, body: { roles: [] } };
      return { status: 404 };
    });
    const out = await syncMemberInGuild(api, 'g1', GUILD, 'u1', desiredRoles(member()));
    expect(out.failed).toBe(0);
    expect(out.added).toBe(0);
  });
});

describe('rate limiting', () => {
  it('retries a 429 and then succeeds', async () => {
    let seen = 0;
    const sleep = vi.fn(async () => {});
    const { api } = apiWith((method) => {
      if (method === 'GET') return { status: 200, body: { roles: [] } };
      seen += 1;
      if (seen === 1) return { status: 429, body: { retry_after: 0.2 } };
      return { status: 204 };
    }, sleep);

    const out = await syncMemberInGuild(api, 'g1', { linked: '1' }, 'u1', desiredRoles(member()));
    expect(out.added).toBe(1);
    expect(sleep).toHaveBeenCalledWith(200);
  });

  it('gives up after the retry ceiling rather than stalling the sweep', async () => {
    const sleep = vi.fn(async () => {});
    const { api } = apiWith((method) => {
      if (method === 'GET') return { status: 200, body: { roles: [] } };
      return { status: 429, body: { retry_after: 0.1 } };
    }, sleep);

    const out = await syncMemberInGuild(api, 'g1', { linked: '1' }, 'u1', desiredRoles(member()));
    expect(out.failed).toBe(1);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not sleep forever on a malformed retry_after', async () => {
    const sleep = vi.fn(async () => {});
    const { api } = apiWith((method) => {
      if (method === 'GET') return { status: 200, body: { roles: [] } };
      return { status: 429, body: { retry_after: 'soon' } };
    }, sleep);

    await syncMemberInGuild(api, 'g1', { linked: '1' }, 'u1', desiredRoles(member()));
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('caps an absurd retry_after', async () => {
    const sleep = vi.fn(async () => {});
    const { api } = apiWith((method) => {
      if (method === 'GET') return { status: 200, body: { roles: [] } };
      return { status: 429, body: { retry_after: 99999 } };
    }, sleep);

    await syncMemberInGuild(api, 'g1', { linked: '1' }, 'u1', desiredRoles(member()));
    expect(sleep).toHaveBeenCalledWith(10_000);
  });
});

describe('syncMemberEverywhere', () => {
  it('visits every registered guild and no others', async () => {
    const registry = parseGuildRegistry('{"g1":{"linked":"1"},"g2":{"linked":"7"}}');
    const seen: string[] = [];
    const { api } = apiWith((method, path) => {
      seen.push(path);
      if (method === 'GET') return { status: 200, body: { roles: [] } };
      return { status: 204 };
    });

    const outcomes = await syncMemberEverywhere(api, registry, 'u1', desiredRoles(member()));
    expect(outcomes.map((o) => o.guildId)).toEqual(['g1', 'g2']);
    expect(seen.some((p) => p.includes('/guilds/g3/'))).toBe(false);
  });

  it('one guild failing does not stop the next', async () => {
    const registry = parseGuildRegistry('{"g1":{"linked":"1"},"g2":{"linked":"7"}}');
    const { api } = apiWith((method, path) => {
      if (path.includes('/guilds/g1/')) return { status: 500 };
      if (method === 'GET') return { status: 200, body: { roles: [] } };
      return { status: 204 };
    });

    const outcomes = await syncMemberEverywhere(api, registry, 'u1', desiredRoles(member()));
    expect(outcomes[0]?.failed).toBe(1);
    expect(outcomes[1]?.added).toBe(1);
  });
});

describe('describeOutcomes', () => {
  it('reports counts and never role ids', () => {
    const line = describeOutcomes('u1', [
      { guildId: 'g1', added: 2, removed: 1, forbidden: 1, failed: 0, absent: false },
      { guildId: 'g2', added: 0, removed: 0, forbidden: 0, failed: 0, absent: true },
    ]);
    expect(line).toBe('[sync] u1: +2 -1 forbidden=1 failed=0 absent=1');
  });
});
