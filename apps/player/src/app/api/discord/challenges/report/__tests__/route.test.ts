import { describe, it, expect, vi, beforeEach } from 'vitest';

// /challenge report. The score arrives the way the caller typed it, their side
// first, and the route turns it into side a and side b from the caller's own
// team_side. A report is never a confirmation: it goes through
// submit_match_result_for, the twin of the member function, with the duration.

const PLAYER = { id: 'player-me', full_name: 'Me Myself', status: 'competitive', is_banned: false, active_flag: true };

let caller: { ok: true; player: typeof PLAYER } | { ok: false; refusal: string } = { ok: true, player: PLAYER };
let challengeRow: Record<string, unknown> | null = null;
let challengeError: { message: string } | null = null;
let coreError: Error | null = null;

const rpc = vi.fn((name: string, params: unknown) => {
  void name;
  void params;
  return Promise.resolve({ data: 'match-1', error: null });
});
const submitCore = vi.fn((player: unknown, challengeId: string, input: { winner_side: string; games: unknown[] }) => ({ player, challengeId, input }));

vi.mock('@/lib/discord-member', () => ({
  resolveDiscordPlayer: vi.fn(async () => caller),
}));

vi.mock('@/lib/challenges-core', () => ({
  submitMatchResultCore: vi.fn(
    async (client: unknown, player: unknown, challengeId: string, input: { games: { side_a_score: number; side_b_score: number }[]; completed: boolean }, call: (params: unknown) => unknown) => {
      submitCore(player, challengeId, input as unknown as { winner_side: string; games: unknown[] });
      if (coreError) throw coreError;
      await call({
        p_challenge_id: challengeId,
        p_games: input.games.map((game) => ({ side_a_score: game.side_a_score, side_b_score: game.side_b_score })),
        p_completed: input.completed,
      });
      return { matchId: 'match-1', format: 'bo3_21' };
    },
  ),
}));

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({
    rpc,
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: challengeError ? null : challengeRow, error: challengeError }),
        }),
      }),
    }),
  }),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

const { ExpectedError } = await import('@badminton/shared');
const { POST } = await import('../route');

const CHALLENGE_ID = '6f1c1a52-1f7e-4c55-9d43-0b8a1d1e2f30';

function post(body: unknown, auth = 'Bearer test-secret') {
  return new Request('http://localhost/api/discord/challenges/report', {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID = {
  discordUserId: '111111',
  challengeId: CHALLENGE_ID,
  games: [{ mine: 21, theirs: 15 }, { mine: 18, theirs: 21 }, { mine: 21, theirs: 19 }],
  durationMinutes: 45,
};

function participants(mySide: 'a' | 'b') {
  return [
    { player_id: 'player-me', team_side: mySide, player: { full_name: 'Me Myself' } },
    { player_id: 'player-opponent', team_side: mySide === 'a' ? 'b' : 'a', player: { full_name: 'Ada Lovelace' } },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
  caller = { ok: true, player: PLAYER };
  challengeRow = { id: CHALLENGE_ID, status: 'accepted', challenge_participants: participants('a') };
  challengeError = null;
  coreError = null;
});

describe('POST /api/discord/challenges/report', () => {
  it('refuses a request without the service secret', async () => {
    const response = await POST(post(VALID, 'Bearer wrong'));
    expect(response.status).toBe(401);
  });

  it('refuses a missing or out-of-range duration before reading anything', async () => {
    for (const durationMinutes of [undefined, 0, 301, 12.5, '45']) {
      const response = await POST(post({ ...VALID, durationMinutes }));
      expect(await response.json()).toEqual({ ok: false, refusal: 'invalid_duration' });
    }
    expect(submitCore).not.toHaveBeenCalled();
  });

  it('passes the caller refusal through', async () => {
    caller = { ok: false, refusal: 'feature_off' };
    const response = await POST(post(VALID));
    expect(await response.json()).toEqual({ ok: false, refusal: 'feature_off' });
  });

  it('refuses a caller who is not on the challenge', async () => {
    challengeRow = {
      id: CHALLENGE_ID,
      status: 'accepted',
      challenge_participants: [{ player_id: 'player-x', team_side: 'a', player: null }],
    };
    const response = await POST(post(VALID));
    expect(await response.json()).toEqual({ ok: false, refusal: 'not_participant' });
    expect(submitCore).not.toHaveBeenCalled();
  });

  it('refuses a challenge that does not exist the same way', async () => {
    challengeRow = null;
    const response = await POST(post(VALID));
    expect(await response.json()).toEqual({ ok: false, refusal: 'not_participant' });
  });

  it('refuses a challenge that is not accepted', async () => {
    challengeRow = { id: CHALLENGE_ID, status: 'proposed', challenge_participants: participants('a') };
    const response = await POST(post(VALID));
    expect(await response.json()).toEqual({ ok: false, refusal: 'not_accepted' });
  });

  it('answers 503 when the challenge read fails', async () => {
    challengeError = { message: 'boom' };
    const response = await POST(post(VALID));
    expect(response.status).toBe(503);
  });

  it('refuses a tied game as an invalid score', async () => {
    const response = await POST(post({ ...VALID, games: [{ mine: 21, theirs: 21 }] }));
    expect((await response.json()).refusal).toBe('invalid_score');
    expect(submitCore).not.toHaveBeenCalled();
  });

  it('maps the caller\'s score onto side a when they are side a', async () => {
    const response = await POST(post(VALID));

    expect(await response.json()).toEqual({ ok: true, matchId: 'match-1', opponents: 'Ada Lovelace' });
    const input = submitCore.mock.calls[0]![2];
    expect(input.winner_side).toBe('a');
    expect(input.games[0]).toEqual({ game_number: 1, side_a_score: 21, side_b_score: 15 });
    expect(rpc).toHaveBeenCalledWith(
      'submit_match_result_for',
      expect.objectContaining({ p_actor: 'player-me', p_challenge_id: CHALLENGE_ID, p_duration_minutes: 45 }),
    );
  });

  it('maps the caller\'s score onto side b when they are side b', async () => {
    challengeRow = { id: CHALLENGE_ID, status: 'accepted', challenge_participants: participants('b') };

    await POST(post(VALID));

    const input = submitCore.mock.calls[0]![2];
    expect(input.winner_side).toBe('b');
    expect(input.games[0]).toEqual({ game_number: 1, side_a_score: 15, side_b_score: 21 });
  });

  it('passes an illegal-score rule from the shared body through as a sentence', async () => {
    coreError = new ExpectedError('Game 1: 21-20 is not a finished game');
    const response = await POST(post(VALID));
    expect(await response.json()).toEqual({ ok: false, refusal: 'rule', message: 'Game 1: 21-20 is not a finished game' });
  });
});
