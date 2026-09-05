import { describe, it, expect, vi, beforeEach } from 'vitest';

// /sessionpost publishes the schedule into a channel, which makes two things
// correctness properties rather than preferences.
//
// The app filters /api/discord/sessions TO THE CALLER — a recreational member
// is not shown competitive nights. /sessions is ephemeral for exactly that
// reason. Posting publicly is only safe if the fetch asks as NOBODY, which is
// the view the app gives an unlinked caller: club-wide nights only. Passing the
// exec's own id would publish their filtered-for-them schedule to every track.
//
// And nothing here may mention a role. session-pings.ts is the one path allowed
// to, and it is bounded by a session actually starting.

const fetchSessions = vi.fn();

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  fetchSessions,
}));

const SESSIONS = [
  {
    id: 's1',
    name: 'Club Night',
    date: '2026-09-10',
    startTime: '19:30',
    endTime: '22:00',
    startsAt: '2026-09-11T02:30:00Z',
    location: 'Gym A',
    track: null,
    going: 14,
  },
];

beforeEach(() => {
  vi.resetAllMocks();
});

async function run() {
  const { handleSessionPost } = await import('../commands.js');
  return handleSessionPost() as Promise<{ type: number; data: Record<string, any> }>;
}

describe('/sessionpost', () => {
  it('asks the app as nobody, so the post is the club-wide schedule', async () => {
    fetchSessions.mockResolvedValue({ sessions: SESSIONS, linked: false });

    await run();

    // null, NOT the exec's discord id. fetchSessions takes the parameter
    // required rather than optional precisely so this cannot drift silently,
    // and this is the assertion that keeps it honest.
    expect(fetchSessions).toHaveBeenCalledWith(null);
  });

  it('posts publicly — the flag that would undo the whole command is absent', async () => {
    fetchSessions.mockResolvedValue({ sessions: SESSIONS, linked: false });

    const response = await run();

    // 64 = ephemeral. /sessions sets it deliberately; this must not, or the
    // command does nothing a member could see.
    expect(response.data.flags).toBeUndefined();
    expect(response.data.embeds?.[0]?.description).toContain('Club Night');
  });

  it('carries the schedule in an embed and not in message content', async () => {
    // THIS IS THE MENTION GUARD, and it is a structural one rather than a
    // string check. Discord does not notify anyone for a mention inside an
    // embed — only `content` pings. A session NAME is club data typed freely
    // by an exec on the website, so the day one is called "@everyone club
    // night", the difference between these two fields is the difference
    // between a notice and a server-wide ping.
    //
    // Asserting on the absence of "<@&" would pass for the wrong reason: it
    // would still pass after somebody moved the description into content.
    fetchSessions.mockResolvedValue({
      sessions: [{ ...SESSIONS[0], name: '@everyone Club Night' }],
      linked: false,
    });

    const response = await run();

    expect(response.data.content).toBeUndefined();
    expect(response.data.embeds?.[0]?.description).toContain('@everyone Club Night');
  });

  it('declines quietly, and to the caller only, when there is nothing to post', async () => {
    fetchSessions.mockResolvedValue({ sessions: [], linked: false });

    const response = await run();

    // A PUBLIC "no sessions are open" reads as the club announcing it has
    // cancelled everything. This one is feedback for whoever ran the command.
    expect(response.data.flags).toBe(64);
    expect(response.data.embeds).toBeUndefined();
  });
});
