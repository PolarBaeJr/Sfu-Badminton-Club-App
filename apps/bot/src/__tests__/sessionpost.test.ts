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

// Ten, which is exactly what the app's MAX_SESSIONS returns, so the numbers in
// the footer assertions are the ones a real capped post would carry.
function tenSessions() {
  return Array.from({ length: 10 }, (_, i) => ({ ...SESSIONS[0], id: `s${i}` }));
}

beforeEach(() => {
  vi.resetAllMocks();
});

async function run() {
  const { handleSessionPost } = await import('../commands.js');
  return handleSessionPost() as Promise<{ type: number; data: Record<string, any> }>;
}

describe('/sessionpost', () => {
  it('asks the app as nobody, so the post is the club-wide schedule', async () => {
    fetchSessions.mockResolvedValue({ sessions: SESSIONS, linked: false, total: 1 });

    await run();

    // null, NOT the exec's discord id. fetchSessions takes the parameter
    // required rather than optional precisely so this cannot drift silently,
    // and this is the assertion that keeps it honest.
    expect(fetchSessions).toHaveBeenCalledWith(null);
  });

  it('posts publicly — the flag that would undo the whole command is absent', async () => {
    fetchSessions.mockResolvedValue({ sessions: SESSIONS, linked: false, total: 1 });

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
      total: 1,
    });

    const response = await run();

    expect(response.data.content).toBeUndefined();
    expect(response.data.embeds?.[0]?.description).toContain('@everyone Club Night');
  });

  // THE TRUNCATION NOTICE. The app returns at most ten sessions, and prod has
  // twenty-eight open. A post that said nothing about the cap reads as the club
  // announcing it runs ten nights, which is what makes this a correctness
  // property of a PUBLIC post rather than a nicety.
  it('says how many it is showing when the list is capped', async () => {
    fetchSessions.mockResolvedValue({ sessions: tenSessions(), linked: false, total: 28 });

    const response = await run();

    expect(response.data.embeds?.[0]?.footer?.text).toBe(
      'Showing the next 10 of 28 club-wide sessions. Full schedule on the website.'
    );
  });

  it('leaves the footer alone when the post IS the whole schedule', async () => {
    // Byte for byte the old string: the common case must look unchanged, or
    // every complete post starts explaining a truncation that did not happen.
    fetchSessions.mockResolvedValue({ sessions: tenSessions(), linked: false, total: 10 });

    const response = await run();

    expect(response.data.embeds?.[0]?.footer?.text).toBe('RSVP on the website');
  });

  it('prints no number at all when the app never sent one', async () => {
    // DEPLOY SKEW, and it is a real state rather than a hypothetical: the bot
    // and the app ship as separate images, so the bot can run ahead of a player
    // app that does not answer with a total yet. The wrong outcome here is a
    // number, any number, so this asserts the exact string.
    fetchSessions.mockResolvedValue({ sessions: tenSessions(), linked: false });

    const response = await run();

    expect(response.data.embeds?.[0]?.footer?.text).toBe('RSVP on the website');
  });

  it('stays a public, non-interactive post', async () => {
    // The footer work must not have turned this into something else. type 4 is
    // an immediate channel message, no flags keeps it visible to everybody, and
    // no components because making this post interactive is a separate change
    // that is deliberately not here.
    fetchSessions.mockResolvedValue({ sessions: tenSessions(), linked: false, total: 28 });

    const response = await run();

    expect(response.type).toBe(4);
    expect(response.data.flags).toBeUndefined();
    expect(response.data.components).toBeUndefined();
  });

  it('declines quietly, and to the caller only, when there is nothing to post', async () => {
    fetchSessions.mockResolvedValue({ sessions: [], linked: false, total: 0 });

    const response = await run();

    // A PUBLIC "no sessions are open" reads as the club announcing it has
    // cancelled everything. This one is feedback for whoever ran the command.
    expect(response.data.flags).toBe(64);
    expect(response.data.embeds).toBeUndefined();
  });
});
