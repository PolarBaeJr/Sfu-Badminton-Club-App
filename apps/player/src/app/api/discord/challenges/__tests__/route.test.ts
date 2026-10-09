import { describe, it, expect, vi, beforeEach } from 'vitest';

// /challenge send and the /challenge report picker.
//
// The checks the web runs before a challenge (standing, feature, waiver) are
// resolveDiscordPlayer's, and are tested in lib/__tests__/discord-member.test.ts.
// What this file pins is the route's own half: the actor is the resolved caller
// and never a body field, every other person is resolved through the link
// table, the payload is shaped the way the web form shapes it, and the RPC is
// the service-role twin with p_creator set.

const PLAYER = { id: 'player-me', full_name: 'Me Myself', status: 'competitive', is_banned: false, active_flag: true };

let caller: { ok: true; player: typeof PLAYER } | { ok: false; refusal: string } = { ok: true, player: PLAYER };
let member: { ok: true; player: typeof PLAYER } | { ok: false; refusal: string } = { ok: true, player: PLAYER };
let linked: Map<string, string> | 'unavailable' = new Map();
let coreError: Error | null = null;
let openRows: unknown[] = [];
let openError: { message: string } | null = null;

const rpc = vi.fn((name: string, params: unknown) => {
  void name;
  void params;
  return Promise.resolve({ data: { valid: true, challenge_id: 'challenge-1' }, error: null });
});
const createCore = vi.fn((player: unknown, input: Record<string, unknown>) => ({ player, input }));
const challengeQuery = { mineFilter: '' };

vi.mock('@/lib/discord-member', () => ({
  resolveDiscordPlayer: vi.fn(async () => caller),
  resolveDiscordMember: vi.fn(async () => member),
  resolveLinkedPlayerIds: vi.fn(async () => linked),
}));

vi.mock('@/lib/challenges-core', () => ({
  createChallengeCore: vi.fn(async (player: unknown, input: unknown, call: (params: unknown) => unknown) => {
    createCore(player, input as Record<string, unknown>);
    if (coreError) throw coreError;
    await call({ p_type: 'singles' });
    return 'challenge-1';
  }),
}));

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({
    rpc,
    from: () => {
      const chain = {
        select: () => chain,
        eq: (column: string, value: string) => {
          if (column === 'mine.player_id') challengeQuery.mineFilter = value;
          return chain;
        },
        order: () => chain,
        limit: () => Promise.resolve({ data: openError ? null : openRows, error: openError }),
      };
      return chain;
    },
  }),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

const { ExpectedError } = await import('@badminton/shared');
const { POST, GET } = await import('../route');

function post(body: unknown, auth = 'Bearer test-secret') {
  return new Request('http://localhost/api/discord/challenges', {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function get(callerId: string | null, auth = 'Bearer test-secret') {
  return new Request('http://localhost/api/discord/challenges', {
    headers: { authorization: auth, ...(callerId ? { 'x-discord-user-id': callerId } : {}) },
  });
}

const SINGLES = { discordUserId: '111111', opponentDiscordId: '222222' };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
  caller = { ok: true, player: PLAYER };
  member = { ok: true, player: PLAYER };
  linked = new Map([
    ['222222', '00000000-0000-4000-8000-000000000002'],
    ['333333', '00000000-0000-4000-8000-000000000003'],
    ['444444', '00000000-0000-4000-8000-000000000004'],
  ]);
  coreError = null;
  openRows = [];
  openError = null;
  challengeQuery.mineFilter = '';
});

describe('POST /api/discord/challenges', () => {
  it('refuses a request without the service secret', async () => {
    const response = await POST(post(SINGLES, 'Bearer wrong'));
    expect(response.status).toBe(401);
    expect(createCore).not.toHaveBeenCalled();
  });

  it('passes the caller refusal through and creates nothing', async () => {
    for (const refusal of ['not_linked', 'standing', 'lapsed', 'feature_off', 'waiver']) {
      caller = { ok: false, refusal };
      const response = await POST(post(SINGLES));
      expect(await response.json()).toEqual({ ok: false, refusal });
    }
    expect(createCore).not.toHaveBeenCalled();
  });

  it('answers 503, not "link your account", when the link read fails', async () => {
    caller = { ok: false, refusal: 'unavailable' };
    const response = await POST(post(SINGLES));
    expect(response.status).toBe(503);
  });

  it('refuses an opponent with no linked account', async () => {
    linked = new Map();
    const response = await POST(post(SINGLES));
    expect(await response.json()).toEqual({ ok: false, refusal: 'opponent_not_linked' });
    expect(createCore).not.toHaveBeenCalled();
  });

  it('names which doubles partner is not linked', async () => {
    linked = new Map([['222222', '00000000-0000-4000-8000-000000000002'], ['444444', '00000000-0000-4000-8000-000000000004']]);
    const response = await POST(post({ ...SINGLES, type: 'doubles', partnerDiscordId: '333333', opponentPartnerDiscordId: '444444' }));
    expect(await response.json()).toEqual({ ok: false, refusal: 'partner_not_linked' });
  });

  it('acts as the resolved caller and ignores a creator id in the body', async () => {
    const response = await POST(post({ ...SINGLES, creatorId: 'player-someone-else', created_by: 'player-someone-else' }));

    expect(await response.json()).toEqual({ ok: true, challengeId: 'challenge-1' });
    expect(createCore).toHaveBeenCalledWith(PLAYER, expect.objectContaining({ opponent_id: '00000000-0000-4000-8000-000000000002' }));
    expect(rpc).toHaveBeenCalledWith('create_challenge_for', expect.objectContaining({ p_creator: 'player-me' }));
    expect(rpc).not.toHaveBeenCalledWith('create_challenge_atomic', expect.anything());
  });

  it('shapes the defaults the way the web form does: rated, best of 3 to 21', async () => {
    await POST(post(SINGLES));
    const input = createCore.mock.calls[0]![1];
    expect(input).toMatchObject({ type: 'singles', rated_flag: true, event_type: 'rated_challenge', format: 'bo3_21' });
    expect(input.games_per_match).toBeUndefined();
    expect(input.points_per_game).toBeUndefined();
  });

  it('sends a non-preset shape as custom columns', async () => {
    await POST(post({ ...SINGLES, rated: false, bestOf: 5, points: 15 }));
    expect(createCore.mock.calls[0]![1]).toMatchObject({
      rated_flag: false,
      event_type: 'casual',
      format: 'bo3_21',
      games_per_match: 5,
      points_per_game: 15,
    });
  });

  it('refuses an out-of-range shape before any write', async () => {
    const response = await POST(post({ ...SINGLES, points: 40 }));
    expect((await response.json()).refusal).toBe('invalid');
    expect(createCore).not.toHaveBeenCalled();
  });

  it('refuses partners on a singles challenge', async () => {
    const response = await POST(post({ ...SINGLES, partnerDiscordId: '333333' }));
    expect((await response.json()).refusal).toBe('invalid');
  });

  it('passes the club rule sentence through as a rule refusal', async () => {
    coreError = new ExpectedError('You already have 3 open challenges');
    const response = await POST(post(SINGLES));
    expect(await response.json()).toEqual({ ok: false, refusal: 'rule', message: 'You already have 3 open challenges' });
  });
});

describe('GET /api/discord/challenges (the report picker)', () => {
  it('lists the caller\'s accepted, unreported challenges named by opponent', async () => {
    openRows = [
      {
        id: 'challenge-1',
        created_at: '2026-10-01T18:00:00Z',
        scheduled_date: null,
        format: 'bo3_21',
        games_per_match: null,
        points_per_game: null,
        matches: null,
        challenge_participants: [
          { player_id: 'player-me', team_side: 'b', player: { full_name: 'Me Myself' } },
          { player_id: '00000000-0000-4000-8000-000000000002', team_side: 'a', player: { full_name: 'Ada Lovelace' } },
        ],
      },
      {
        id: 'challenge-2',
        created_at: '2026-10-02T18:00:00Z',
        scheduled_date: '2026-10-03',
        format: 'single_21',
        games_per_match: null,
        points_per_game: null,
        matches: [{ id: 'match-already' }],
        challenge_participants: [],
      },
    ];

    const response = await GET(get('111111'));

    expect(await response.json()).toEqual({
      challenges: [{ id: 'challenge-1', label: 'vs Ada Lovelace - 2026-10-01 - Best of 3 to 21' }],
    });
    expect(challengeQuery.mineFilter).toBe('player-me');
  });

  it('answers an empty list to an unlinked caller', async () => {
    member = { ok: false, refusal: 'not_linked' };
    const response = await GET(get('111111'));
    expect(await response.json()).toEqual({ challenges: [] });
  });

  it('answers 503 when the challenge read fails', async () => {
    openError = { message: 'boom' };
    const response = await GET(get('111111'));
    expect(response.status).toBe(503);
  });

  it('answers 503 when the link read fails', async () => {
    member = { ok: false, refusal: 'unavailable' };
    const response = await GET(get('111111'));
    expect(response.status).toBe(503);
  });
});
