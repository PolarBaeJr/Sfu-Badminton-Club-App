import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * CONSOLE COMMANDS ON DISCORD: the read route. Same door as the writes, and
 * each read asks the console's own gate for its capability BEFORE any query.
 */

const resolveDiscordActor = vi.fn();
vi.mock('@/lib/discord-actor', async () => {
  const store = await import('@/lib/discord-actor-store');
  return { ...store, resolveDiscordActor: (...a: unknown[]) => resolveDiscordActor(...a) };
});

const state = vi.hoisted(() => ({
  capabilityCalls: [] as { capability: string; actorId: string | undefined }[],
  refusal: null as Error | null,
  queried: [] as string[],
  rows: [] as Record<string, unknown>[],
  readError: null as { message: string } | null,
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/supabase-server', async () => {
  const { discordActorStore } = await import('@/lib/discord-actor-store');
  const builder = (table: string) => {
    state.queried.push(table);
    const self: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'gte', 'in', 'order', 'limit']) self[method] = () => self;
    self.maybeSingle = async () => ({ data: state.rows[0] ?? null, error: state.readError });
    self.then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: state.readError ? null : state.rows, error: state.readError, count: 0 });
    return self;
  };
  return {
    createAdminClient: () => ({ from: builder }),
    requireCapability: async (capability: string) => {
      state.capabilityCalls.push({ capability, actorId: discordActorStore.getStore()?.playerId });
      if (state.refusal) throw state.refusal;
      return { id: 'exec-1' };
    },
  };
});

const { GET } = await import('../[name]/route');

const SECRET = 'test-service-secret';
const DISCORD_ID = '123456789012345678';

function call(name: string, query = '', secret: string | null = SECRET) {
  const request = new Request(`https://console.example.invalid/api/discord/reads/${name}${query}`, {
    headers: {
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      'x-discord-user-id': DISCORD_ID,
    },
  });
  return GET(request, { params: Promise.resolve({ name }) });
}

function coded(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = SECRET;
  state.capabilityCalls = [];
  state.refusal = null;
  state.queried = [];
  state.rows = [];
  state.readError = null;
  resolveDiscordActor.mockReset();
  resolveDiscordActor.mockResolvedValue({ playerId: 'exec-1' });
});

describe('GET /api/discord/reads/[name]', () => {
  it('is a 401 without the service secret', async () => {
    const res = await call('sessions', '', null);
    expect(res.status).toBe(401);
    expect(state.queried).toEqual([]);
  });

  it('is a 404 for an unknown read', async () => {
    expect((await call('players')).status).toBe(404);
    expect((await call('__proto__')).status).toBe(404);
  });

  it('names an unlinked caller', async () => {
    resolveDiscordActor.mockResolvedValue('not_linked');
    expect(await (await call('sessions')).json()).toEqual({ ok: false, refusal: 'not_linked' });
  });

  it.each([
    ['sessions', 'sessions.page'],
    ['session-attendance', 'sessions.page'],
    ['locations', 'sessions.page'],
    ['events', 'events.page'],
    ['event-signups', 'events.signups.read'],
  ])('asks for the capability behind %s, as the linked exec', async (name, capability) => {
    await call(name);
    expect(state.capabilityCalls).toEqual([{ capability, actorId: 'exec-1' }]);
  });

  it('reads nothing when the capability is refused, and says why', async () => {
    state.refusal = coded('Your permissions do not include this. Ask an admin.', 'AUTH-104');
    const res = await call('sessions');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'Your permissions do not include this. Ask an admin.',
      code: 'AUTH-104',
    });
    expect(state.queried).toEqual([]);
  });

  it('turns the passkey policy refusal into passkey_required', async () => {
    state.refusal = coded('x', 'AUTH-105');
    expect(await (await call('events')).json()).toEqual({ ok: false, refusal: 'passkey_required' });
  });

  it('is a 503 when the read is refused by the database', async () => {
    state.readError = { message: 'boom' };
    expect((await call('sessions')).status).toBe(503);
  });

  it('hands back an edit input the console action takes', async () => {
    state.rows = [
      {
        id: '11111111-2222-4333-8444-555555555555',
        name: 'Club night',
        date: '2026-10-20',
        start_time: '19:00:00',
        end_time: null,
        location: 'Gym',
        notes: null,
        track: 'all',
        status: 'open',
      },
    ];
    const body = await (await call('sessions')).json();
    expect(body.ok).toBe(true);
    expect(body.data.sessions[0].editInput).toEqual({
      name: 'Club night',
      date: '2026-10-20',
      time: '19:00',
      location: 'Gym',
      track: 'all',
    });
  });
});
