import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * CONSOLE COMMANDS ON DISCORD: the write route, at its edges.
 *
 * No service secret is a 401 with nothing run; an unlinked caller is a named
 * refusal; an unknown name is a 404; arguments of the wrong shape (including a
 * misspelt key, which an update would read as "clear this") are a 400; and a
 * good call runs the console's action INSIDE the actor store, as the linked
 * exec, handing back its ActionResult. The actions are mocked.
 */

const resolveDiscordActor = vi.fn();
vi.mock('@/lib/discord-actor', async () => {
  const store = await import('@/lib/discord-actor-store');
  return { ...store, resolveDiscordActor: (...a: unknown[]) => resolveDiscordActor(...a) };
});
vi.mock('@/lib/supabase-server', () => ({ createAdminClient: () => ({}) }));

const calls: { name: string; args: unknown[]; actorId: string | undefined }[] = [];
let answer: unknown = { ok: true, data: undefined };

async function record(name: string, args: unknown[]) {
  const { discordActorStore } = await import('@/lib/discord-actor-store');
  calls.push({ name, args, actorId: discordActorStore.getStore()?.playerId });
  return answer;
}

vi.mock('@/lib/actions/sessions', () => ({
  createSession: (...a: unknown[]) => record('createSession', a),
  updateSession: (...a: unknown[]) => record('updateSession', a),
  archiveSession: (...a: unknown[]) => record('archiveSession', a),
  deleteSession: (...a: unknown[]) => record('deleteSession', a),
  getOrCreateSessionCheckinToken: (...a: unknown[]) => record('getOrCreateSessionCheckinToken', a),
  rotateSessionCheckinToken: (...a: unknown[]) => record('rotateSessionCheckinToken', a),
}));
vi.mock('@/lib/actions/club-events', () => ({
  createClubEvent: (...a: unknown[]) => record('createClubEvent', a),
  updateClubEvent: (...a: unknown[]) => record('updateClubEvent', a),
  cancelClubEvent: (...a: unknown[]) => record('cancelClubEvent', a),
  deleteClubEvent: (...a: unknown[]) => record('deleteClubEvent', a),
}));

const { POST } = await import('../[name]/route');

const SECRET = 'test-service-secret';
const ID = '11111111-2222-4333-8444-555555555555';
const DISCORD_ID = '123456789012345678';

function call(name: string, body: unknown, secret: string | null = SECRET) {
  const request = new Request(`https://console.example.invalid/api/discord/actions/${name}`, {
    method: 'POST',
    headers: {
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ name }) });
}

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = SECRET;
  calls.length = 0;
  answer = { ok: true, data: undefined };
  resolveDiscordActor.mockReset();
  resolveDiscordActor.mockResolvedValue({ playerId: 'exec-1' });
});

describe('POST /api/discord/actions/[name]', () => {
  it('is a 401 without the service secret, and runs nothing', async () => {
    const res = await call('archiveSession', { discordUserId: DISCORD_ID, args: [ID, 'Rained out'] }, null);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
    expect(resolveDiscordActor).not.toHaveBeenCalled();
  });

  it('is a 401 with the wrong secret', async () => {
    const res = await call('archiveSession', { discordUserId: DISCORD_ID, args: [ID, 'Rained out'] }, 'nope');
    expect(res.status).toBe(401);
  });

  it('names an unlinked caller and runs nothing', async () => {
    resolveDiscordActor.mockResolvedValue('not_linked');
    const res = await call('archiveSession', { discordUserId: DISCORD_ID, args: [ID, 'Rained out'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, refusal: 'not_linked' });
    expect(calls).toHaveLength(0);
  });

  it('is a 503 when the link cannot be read, never not_linked', async () => {
    resolveDiscordActor.mockResolvedValue('unavailable');
    const res = await call('archiveSession', { discordUserId: DISCORD_ID, args: [ID, 'Rained out'] });
    expect(res.status).toBe(503);
  });

  it.each(['banPlayer', 'toString', '__proto__', 'constructor'])('is a 404 for %s', async (name) => {
    const res = await call(name, { discordUserId: DISCORD_ID, args: [] });
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['archiveSession', [ID]],
    ['archiveSession', ['not-a-uuid', 'Rained out']],
    ['updateSession', [ID, { name: 'Club night', date: '2026-10-20', location: 'Gym', track: 'all', start_time: '19:00' }, 'Moved']],
    ['createSession', [{ name: 'Club night', date: '2026-10-20', location: 'Gym', track: 'everyone' }]],
  ])('is a 400 for bad arguments to %s', async (name, args) => {
    const res = await call(name, { discordUserId: DISCORD_ID, args });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('is a 400 for a malformed Discord id', async () => {
    const res = await call('archiveSession', { discordUserId: 'abc', args: [ID, 'Rained out'] });
    expect(res.status).toBe(400);
  });

  it('runs the action as the linked exec and returns its result', async () => {
    answer = { ok: false, error: 'Your permissions do not include this. Ask an admin.', code: 'AUTH-104', ref: 'r1' };
    const res = await call('archiveSession', { discordUserId: DISCORD_ID, args: [ID, 'Rained out'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answer);
    expect(calls).toEqual([{ name: 'archiveSession', args: [ID, 'Rained out'], actorId: 'exec-1' }]);
  });

  it('turns the passkey policy refusal into passkey_required', async () => {
    answer = { ok: false, error: 'x', code: 'AUTH-105', ref: 'r2' };
    const res = await call('deleteClubEvent', { discordUserId: DISCORD_ID, args: [ID] });
    expect(await res.json()).toEqual({ ok: false, refusal: 'passkey_required' });
  });

  it('passes a well-formed session create through', async () => {
    const input = {
      name: 'Club night',
      date: '2026-10-20',
      time: '19:00',
      end_time: '21:00',
      location: 'Gym',
      track: 'all',
      repeat_until: '2026-11-20',
      repeat_frequency: 'weekly',
    };
    const res = await call('createSession', { discordUserId: DISCORD_ID, args: [input] });
    expect(res.status).toBe(200);
    expect(calls[0]!.args).toEqual([input]);
  });
});
