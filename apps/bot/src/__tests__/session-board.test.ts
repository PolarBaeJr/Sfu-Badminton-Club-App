import { describe, it, expect, vi, beforeEach } from 'vitest';

// The board re-renders 288 times a day and must be invisible for 287 of them.
// Four properties carry that, and none of them is observable by looking at
// Discord:
//
//  1. IDENTICAL DATA MAKES NO CALL AT ALL. The fingerprint is the whole point:
//     an "(edited)" marker on every tick is how a reader discovers that
//     something clock derived crept into the render.
//  2. COMPONENTS GO OUT ON EVERY POST AND EVERY EDIT. A schedule shrinking
//     below eleven rows must LOSE its pager, and an embeds-only edit would
//     leave live controls on a one-page board.
//  3. clearMessage IS NOT clearAll. Dropping the row when a PATCH answers 404
//     would drop the repost counter with it, and the cap could never bind: the
//     board would repost itself every five minutes forever.
//  4. EVERY ID ON THE WALL SAYS `p`. An `e` id here would arm a type-7 edit of
//     the public post under every reader, which is the largest blast radius in
//     the design.

const fetchSessions = vi.fn();
const fetchSessionBoard = vi.fn();
const writeSessionBoard = vi.fn();
const postMessageResult = vi.fn();
const editMessage = vi.fn();
const deleteMessage = vi.fn();

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  fetchSessions,
  fetchSessionBoard,
  writeSessionBoard,
}));
vi.mock('../discord-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../discord-api.js')>()),
  DiscordApi: class {
    postMessageResult = postMessageResult;
    editMessage = editMessage;
    deleteMessage = deleteMessage;
  },
}));

const SESSION = {
  id: 's1',
  name: 'Club Night',
  date: '2026-09-10',
  startTime: '19:30',
  endTime: '22:00',
  startsAt: '2026-09-11T02:30:00Z',
  location: 'Gym A',
  track: null,
  going: 14,
};

function sessions(count: number, overrides: Record<string, unknown> = {}) {
  return Array.from({ length: count }, (_, i) => ({ ...SESSION, id: `s${i}`, ...overrides }));
}

function page(overrides: Record<string, unknown> = {}) {
  return {
    sessions: sessions(1),
    linked: false,
    page: 1,
    totalPages: 1,
    total: 1,
    query: null,
    location: null,
    locations: [],
    ...overrides,
  };
}

/** A board already up, with a fingerprint that cannot match any real render. */
function state(overrides: Record<string, unknown> = {}) {
  return {
    channelId: 'c1',
    messageId: 'm1',
    pending: false,
    fingerprint: 'stale',
    postedAt: '2026-09-10T00:00:00.000Z',
    reposts: 0,
    repostWindowStart: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

async function run() {
  const { runSessionBoard } = await import('../session-board.js');
  return runSessionBoard();
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.DISCORD_BOT_TOKEN = 'bot-token';
  fetchSessions.mockResolvedValue(page());
  fetchSessionBoard.mockResolvedValue({ channelId: 'c1', state: null });
  writeSessionBoard.mockResolvedValue({ ok: true });
  postMessageResult.mockResolvedValue({ id: 'm1' });
  editMessage.mockResolvedValue('ok');
  deleteMessage.mockResolvedValue(true);
});

describe('runSessionBoard', () => {
  it('asks the app as nobody, page 1, no filter', async () => {
    // The audience is everyone who can read the channel, including members who
    // never linked, so the right view is the unlinked one. An exec's id here
    // would publish their own track's schedule to the whole club.
    await run();

    expect(fetchSessions).toHaveBeenCalledWith(null, 1);
  });

  it('emits only `p` ids, so no click can edit the public post', async () => {
    fetchSessions.mockResolvedValue(page({ sessions: sessions(10), totalPages: 3, total: 28 }));

    await run();

    const payload = postMessageResult.mock.calls[0]?.[1] as {
      components: { components: { custom_id: string }[] }[];
    };
    const ids = payload.components.flatMap((row) => row.components.map((c) => c.custom_id));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id.startsWith('sesboard:p:')).toBe(true);
      expect(id).not.toContain(':e:');
    }
  });

  it('makes NO Discord call when the render has not changed', async () => {
    // Two ticks over identical data. The first posts and records a fingerprint;
    // the second is handed that fingerprint back and must stop before Discord.
    await run();
    const fingerprint = (writeSessionBoard.mock.calls.at(-1)?.[0] as { fingerprint: string })
      .fingerprint;
    expect(fingerprint).toMatch(/^[0-9a-f]{32}$/);

    vi.resetAllMocks();
    process.env.DISCORD_BOT_TOKEN = 'bot-token';
    fetchSessions.mockResolvedValue(page());
    fetchSessionBoard.mockResolvedValue({ channelId: 'c1', state: state({ fingerprint }) });

    const result = await run();

    expect(result.unchanged).toBe(1);
    expect(editMessage).not.toHaveBeenCalled();
    expect(postMessageResult).not.toHaveBeenCalled();
    // No write either. This branch runs all day and a row rewritten every five
    // minutes would be indistinguishable from one that had something to say.
    expect(writeSessionBoard).not.toHaveBeenCalled();
  });

  it('edits exactly once when a going count moves', async () => {
    // The fingerprint is taken from a REAL render of 14 going, not invented, so
    // this pins that the hash is sensitive to an RSVP count. A hardcoded "stale"
    // value would pass for any difference at all, including none.
    await run();
    const fingerprint = (writeSessionBoard.mock.calls.at(-1)?.[0] as { fingerprint: string })
      .fingerprint;

    vi.resetAllMocks();
    process.env.DISCORD_BOT_TOKEN = 'bot-token';
    writeSessionBoard.mockResolvedValue({ ok: true });
    editMessage.mockResolvedValue('ok');
    fetchSessionBoard.mockResolvedValue({ channelId: 'c1', state: state({ fingerprint }) });
    fetchSessions.mockResolvedValue(page({ sessions: sessions(1, { going: 15 }) }));

    const result = await run();

    expect(editMessage).toHaveBeenCalledTimes(1);
    expect(editMessage).toHaveBeenCalledWith('c1', 'm1', expect.anything());
    expect(result.edited).toBe(1);
  });

  it('sends components on the post AND on the edit', async () => {
    fetchSessions.mockResolvedValue(page({ sessions: sessions(10), totalPages: 3, total: 28 }));
    await run();
    expect(postMessageResult.mock.calls[0]?.[1]).toHaveProperty('components');

    fetchSessionBoard.mockResolvedValue({ channelId: 'c1', state: state() });
    await run();
    expect(editMessage.mock.calls[0]?.[2]).toHaveProperty('components');
  });

  it('edits the pager AWAY when the schedule shrinks to one page', async () => {
    // The case that makes covering components in the fingerprint load-bearing.
    // An embeds-only edit would leave a live "next page" button on a board that
    // no longer has a second page.
    fetchSessionBoard.mockResolvedValue({ channelId: 'c1', state: state() });
    fetchSessions.mockResolvedValue(page({ sessions: sessions(4), totalPages: 1, total: 4 }));

    await run();

    expect(editMessage.mock.calls[0]?.[2]).toMatchObject({ components: [] });
  });

  it('refuses to post again while a post is unconfirmed', async () => {
    // pending with no id: the previous tick died between marking and recording.
    // Posting now could duplicate a board this process cannot see.
    fetchSessionBoard.mockResolvedValue({
      channelId: 'c1',
      state: state({ messageId: null, pending: true, fingerprint: null }),
    });

    const result = await run();

    expect(result.stuck).toBe(1);
    expect(postMessageResult).not.toHaveBeenCalled();
    expect(writeSessionBoard).not.toHaveBeenCalled();
  });

  it("keeps the repost counters when the message is gone, and caps the reposts", async () => {
    // A 404 PATCH means somebody deleted the board. The message is forgotten;
    // the counters are NOT, because they are the only thing standing between a
    // channel that auto-deletes and a fresh board every five minutes forever.
    editMessage.mockResolvedValue('gone');
    fetchSessionBoard.mockResolvedValue({ channelId: 'c1', state: state({ reposts: 2 }) });

    const stale = await run();

    expect(stale.stale).toBe(1);
    expect(writeSessionBoard).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: null, pending: false, reposts: 2 })
    );

    // The next tick reposts, which is the third, and the one after that is
    // refused inside the same 24 hours.
    vi.resetAllMocks();
    process.env.DISCORD_BOT_TOKEN = 'bot-token';
    fetchSessions.mockResolvedValue(page());
    writeSessionBoard.mockResolvedValue({ ok: true });
    fetchSessionBoard.mockResolvedValue({
      channelId: 'c1',
      state: state({
        messageId: null,
        fingerprint: null,
        reposts: 3,
        repostWindowStart: new Date().toISOString(),
      }),
    });

    const suppressed = await run();

    expect(suppressed.suppressed).toBe(1);
    expect(postMessageResult).not.toHaveBeenCalled();
  });

  it('takes the old message down when an admin repoints the channel', async () => {
    // A board is a singleton, so unlike the announcement relay the old copy does
    // not stay: nobody would be updating it, and two boards disagreeing is worse
    // than a five minute gap.
    fetchSessionBoard.mockResolvedValue({ channelId: 'c2', state: state() });

    const result = await run();

    expect(deleteMessage).toHaveBeenCalledWith('c1', 'm1');
    // null, not clearMessage: a human touched the setting, so the repost budget
    // resets with it.
    expect(writeSessionBoard).toHaveBeenCalledWith(null);
    expect(result.moved).toBe(1);
    expect(postMessageResult).not.toHaveBeenCalled();
  });

  it('takes the board down when the setting is cleared', async () => {
    fetchSessionBoard.mockResolvedValue({ channelId: null, state: state() });

    const result = await run();

    expect(deleteMessage).toHaveBeenCalledWith('c1', 'm1');
    expect(writeSessionBoard).toHaveBeenCalledWith(null);
    expect(result.retracted).toBe(1);
  });

  it('writes NOTHING while the board has never been configured', async () => {
    // Otherwise the bot issues a pointless write every five minutes for the
    // whole period before the club ever sets the channel.
    fetchSessionBoard.mockResolvedValue({ channelId: null, state: null });

    const result = await run();

    expect(result.skipped).toBe(1);
    expect(writeSessionBoard).not.toHaveBeenCalled();
    expect(fetchSessions).not.toHaveBeenCalled();
  });

  it('does not post an empty schedule, but does edit a live board to empty', async () => {
    // A public "no sessions are open" reads as the club announcing it cancelled
    // everything, so it is never POSTED. Leaving the last render up is worse
    // though: those rows are absolute timestamps that quietly become a list of
    // nights that already happened.
    fetchSessions.mockResolvedValue(page({ sessions: [], total: 0 }));

    const first = await run();

    expect(first.skipped).toBe(1);
    expect(postMessageResult).not.toHaveBeenCalled();

    fetchSessionBoard.mockResolvedValue({ channelId: 'c1', state: state() });

    const second = await run();

    expect(second.edited).toBe(1);
    const payload = editMessage.mock.calls[0]?.[2] as {
      embeds: { description: string }[];
    };
    expect(payload.embeds[0]?.description).not.toBe('');
  });

  it('preserves the counters when Discord refuses the post', async () => {
    postMessageResult.mockResolvedValue('refused');
    fetchSessionBoard.mockResolvedValue({
      channelId: 'c1',
      // Inside the window, so the count is the one the refusal has to preserve
      // rather than one the window roll would have zeroed anyway.
      state: state({
        messageId: null,
        fingerprint: null,
        reposts: 1,
        repostWindowStart: new Date().toISOString(),
      }),
    });

    const result = await run();

    expect(result.refused).toBe(1);
    // Nothing was created, so the marker comes off and the next tick retries.
    expect(writeSessionBoard).toHaveBeenLastCalledWith(
      expect.objectContaining({ pending: false, messageId: null, reposts: 1 })
    );
  });

  it('leaves the marker down when a post may or may not have landed', async () => {
    postMessageResult.mockResolvedValue('unknown');

    const result = await run();

    expect(result.failed).toBe(1);
    // One write only: the pending marker. Clearing it would let the next tick
    // post a second board over a first one nobody can see.
    expect(writeSessionBoard).toHaveBeenCalledTimes(1);
    expect(writeSessionBoard).toHaveBeenCalledWith(expect.objectContaining({ pending: true }));
  });

  it('marks a post pending BEFORE calling Discord', async () => {
    await run();

    const order = writeSessionBoard.mock.invocationCallOrder[0];
    expect(order).toBeLessThan(postMessageResult.mock.invocationCallOrder[0]);
    expect(writeSessionBoard.mock.calls[0]?.[0]).toMatchObject({
      pending: true,
      messageId: null,
    });
  });

  it('does not post at all if the pending marker cannot be written', async () => {
    writeSessionBoard.mockRejectedValue(new Error('app is down'));

    const result = await run();

    expect(result.failed).toBe(1);
    expect(postMessageResult).not.toHaveBeenCalled();
  });
});
