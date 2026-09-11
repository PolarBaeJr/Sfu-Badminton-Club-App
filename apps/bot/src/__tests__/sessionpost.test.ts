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
//
// THE POST NOW CARRIES BUTTONS, and one thing about them is the highest
// consequence assertion in this file: every id on it says `p`. A `p` id can only
// ever be answered with a private copy, so no click can edit the post the whole
// club is reading. An `e` id here would arm exactly that.

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

// Ten, which is exactly what one page of the app's answer holds, so the numbers
// in the footer assertions are the ones a real post would carry.
function tenSessions() {
  return Array.from({ length: 10 }, (_, i) => ({ ...SESSIONS[0], id: `s${i}` }));
}

function page(overrides: Record<string, unknown> = {}) {
  return {
    sessions: SESSIONS,
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

beforeEach(() => {
  vi.resetAllMocks();
});

async function run() {
  const { handleSessionPost } = await import('../commands.js');
  return handleSessionPost() as Promise<{ type: number; data: Record<string, any> }>;
}

function idsOf(response: { data: Record<string, any> }): string[] {
  return (response.data.components ?? []).flatMap((row: any) =>
    (row.components ?? []).map((c: any) => c.custom_id as string)
  );
}

describe('/sessionpost', () => {
  it('asks the app as nobody, so the post is the club-wide schedule', async () => {
    fetchSessions.mockResolvedValue(page());

    await run();

    // null, NOT the exec's discord id. fetchSessions takes the parameter
    // required rather than optional precisely so this cannot drift silently,
    // and this is the assertion that keeps it honest.
    expect(fetchSessions).toHaveBeenCalledWith(null, 1);
  });

  it('takes no arguments, so there is no caller in scope to pass', async () => {
    // A cheap arity tripwire. It breaks the moment somebody threads a clicker
    // into the one function that produces the public post, which is the guard
    // that replaced "the handler has no context".
    const { handleSessionPost } = await import('../commands.js');
    expect(handleSessionPost.length).toBe(0);
  });

  it('posts publicly — the flag that would undo the whole command is absent', async () => {
    fetchSessions.mockResolvedValue(page());

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
    fetchSessions.mockResolvedValue(
      page({ sessions: [{ ...SESSIONS[0], name: '@everyone Club Night' }] })
    );

    const response = await run();

    expect(response.data.content).toBeUndefined();
    expect(response.data.embeds?.[0]?.description).toContain('@everyone Club Night');
  });

  // THE FOOTER STATES THE PAGE AND THE TOTAL. The truncation apology it used to
  // carry is gone, because all 28 rows are now reachable from the post: the
  // numbers say the list continues and the buttons are how you read the rest.
  it('says which page it is and how many there are', async () => {
    fetchSessions.mockResolvedValue(page({ sessions: tenSessions(), totalPages: 3, total: 28 }));

    const response = await run();

    expect(response.data.embeds?.[0]?.footer?.text).toContain('Page 1 of 3');
    expect(response.data.embeds?.[0]?.footer?.text).toContain('28 upcoming');
  });

  it('says nothing about a track, linked or not', async () => {
    // The wall always fetches as nobody, so its `linked` is always false and the
    // footer must ignore it: "run /link to see your track" would imply this list
    // is narrowed, which it is not.
    fetchSessions.mockResolvedValue(page({ sessions: tenSessions(), totalPages: 3, total: 28 }));

    const response = await run();

    expect(response.data.embeds?.[0]?.footer?.text).not.toContain('/link');
    expect(response.data.embeds?.[0]?.footer?.text).toContain('28 upcoming');
    expect(response.data.embeds?.[0]?.footer?.text).not.toContain('for you');
  });

  it('EMITS ONLY `p` IDS, on every control', async () => {
    // The one mistake with the largest blast radius: an `e` id on a public
    // message would let a click type-7 edit the club's post under every reader.
    fetchSessions.mockResolvedValue(
      page({
        sessions: tenSessions(),
        totalPages: 3,
        total: 28,
        locations: [
          { id: 'aaaaaaaa', label: 'West Gym' },
          { id: 'bbbbbbbb', label: 'East Gym' },
        ],
      })
    );

    const ids = idsOf(await run());

    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id.startsWith('sesboard:p:')).toBe(true);
      expect(id).not.toContain(':e:');
    }
  });

  it('carries no page count on a public go button', async () => {
    // The copy a public click produces is the clicker's own and may run longer,
    // so a range quoted from the wall's numbers would read as a cap.
    fetchSessions.mockResolvedValue(page({ sessions: tenSessions(), totalPages: 3, total: 28 }));

    expect(idsOf(await run())).toContain('sesboard:p:go:-:-');
  });

  it('stays public and loses its controls when there is only one page', async () => {
    fetchSessions.mockResolvedValue(page({ sessions: tenSessions(), totalPages: 1, total: 10 }));

    const response = await run();

    expect(response.type).toBe(4);
    expect(response.data.flags).toBeUndefined();
    // Present and empty, not absent: a schedule that shrank has to clear its
    // buttons rather than strand live controls on a one-page list.
    expect(response.data.components).toEqual([]);
  });

  it('offers a location filter only when there is more than one location', async () => {
    fetchSessions.mockResolvedValue(
      page({
        sessions: tenSessions(),
        totalPages: 3,
        total: 28,
        locations: [{ id: 'aaaaaaaa', label: 'West Gym' }],
      })
    );

    expect((await run()).data.components).toHaveLength(1);

    fetchSessions.mockResolvedValue(
      page({
        sessions: tenSessions(),
        totalPages: 3,
        total: 28,
        locations: [
          { id: 'aaaaaaaa', label: 'West Gym' },
          { id: 'bbbbbbbb', label: 'East Gym' },
        ],
      })
    );

    const both = await run();
    expect(both.data.components).toHaveLength(2);
    expect(idsOf(both)).toContain('sesboard:p:loc:-:-');
  });

  it('declines quietly, and to the caller only, when there is nothing to post', async () => {
    fetchSessions.mockResolvedValue(page({ sessions: [], total: 0 }));

    const response = await run();

    // A PUBLIC "no sessions are open" reads as the club announcing it has
    // cancelled everything. This one is feedback for whoever ran the command.
    expect(response.data.flags).toBe(64);
    expect(response.data.embeds).toBeUndefined();
  });
});

describe('a click on a public session board', () => {
  const CONTEXT = { discordUserId: '424242', guildId: 'g1' };

  async function click(customId: string, values?: string[]) {
    const { handleSessionBoardButton } = await import('../commands.js');
    return (await handleSessionBoardButton(customId, CONTEXT, values)) as {
      type: number;
      data: Record<string, any>;
    };
  }

  beforeEach(() => {
    fetchSessions.mockResolvedValue(page({ sessions: tenSessions(), totalPages: 3, total: 28 }));
  });

  it('answers a `p` click with a PRIVATE copy, never an edit', async () => {
    // The public board did not move. This is the assertion that says so.
    const response = await click('sesboard:p:next:2:-');

    expect(response.type).toBe(4);
    expect(response.data.flags).toBe(64);
  });

  it('gives that copy `e` ids, so the second click pages in place', async () => {
    const response = await click('sesboard:p:next:2:-');

    for (const id of idsOf(response)) {
      expect(id.startsWith('sesboard:e:')).toBe(true);
    }
  });

  it('edits the copy in place on an `e` click, embeds AND components', async () => {
    const response = await click('sesboard:e:next:2:-');

    expect(response.type).toBe(7);
    expect(response.data).toHaveProperty('embeds');
    expect(response.data).toHaveProperty('components');
  });

  it('treats a garbled origin as public, never as an edit', async () => {
    // The fail-closed direction, and the reason the marker is `e` rather than
    // `p`: a mangled id must not be able to reach the branch that edits a shared
    // message.
    for (const id of ['sesboard:x:next:2:-', 'sesboard::next:2:-', 'sesboard:E:next:2:-']) {
      expect((await click(id)).type).toBe(4);
    }
  });

  it('personalises the copy, which is what "for you" in its footer means', async () => {
    await click('sesboard:p:next:2:-');

    expect(fetchSessions).toHaveBeenCalledWith('424242', 2, undefined, undefined);
  });

  it('carries the chosen location on every control of the copy', async () => {
    fetchSessions.mockResolvedValue(
      page({
        sessions: tenSessions(),
        totalPages: 3,
        total: 28,
        location: 'bbbbbbbb',
        locations: [
          { id: 'aaaaaaaa', label: 'West Gym' },
          { id: 'bbbbbbbb', label: 'East Gym' },
        ],
      })
    );

    const response = await click('sesboard:p:loc:-:-', ['bbbbbbbb']);

    // A new filter is a different list, so it starts at its first page.
    expect(fetchSessions).toHaveBeenCalledWith('424242', 1, undefined, 'bbbbbbbb');
    for (const id of idsOf(response)) {
      if (id.includes(':loc:')) continue;
      expect(id.endsWith(':bbbbbbbb')).toBe(true);
    }
    expect(response.data.embeds?.[0]?.footer?.text).toContain('East Gym');
  });

  it('FAILS CLOSED TO NO FILTER when the choice does not arrive', async () => {
    // The bot has never read data.values before. An absent or empty one must not
    // silently leave the filter the member just changed in place.
    await click('sesboard:p:loc:-:aaaaaaaa', []);

    expect(fetchSessions).toHaveBeenCalledWith('424242', 1, undefined, undefined);
  });

  it('opens a modal for go and find, and never an app call', async () => {
    fetchSessions.mockClear();

    const go = await click('sesboard:p:go:-:-');
    const find = await click('sesboard:e:find:-:aaaaaaaa');

    expect(go.type).toBe(9);
    expect(go.data.custom_id).toBe('sesboardmodal:go:-');
    // The filter travels through the modal, or a search would silently widen
    // back out to every gym.
    expect(find.data.custom_id).toBe('sesboardmodal:find:aaaaaaaa');
    expect(fetchSessions).not.toHaveBeenCalled();
  });

  it('acknowledges an action it does not know and changes nothing', async () => {
    fetchSessions.mockClear();

    expect((await click('sesboard:p:sideways:-:-')).type).toBe(6);
    expect(fetchSessions).not.toHaveBeenCalled();
  });
});

describe('a session board modal submit', () => {
  const CONTEXT = { discordUserId: '424242', guildId: 'g1' };

  function typed(customId: string, value: string) {
    return [{ type: 1, components: [{ type: 4, custom_id: customId, value }] }];
  }

  it('answers ephemerally and NEVER with an in-place edit', async () => {
    fetchSessions.mockResolvedValue(page({ sessions: tenSessions(), totalPages: 3, total: 28 }));
    const { handleSessionBoardModal } = await import('../commands.js');

    const response = (await handleSessionBoardModal(
      'sesboardmodal:go:aaaaaaaa',
      typed('page', '2'),
      CONTEXT
    )) as { type: number; data: Record<string, any> };

    expect(response.type).toBe(4);
    expect(response.data.flags).toBe(64);
    // As the clicker, like every other copy: a submit always renders one, so it
    // takes the copy's audience.
    expect(fetchSessions).toHaveBeenCalledWith('424242', 2, undefined, 'aaaaaaaa');
  });

  it('answers a find with the matches and no controls', async () => {
    fetchSessions.mockResolvedValue(page({ query: 'club', total: 3 }));
    const { handleSessionBoardModal } = await import('../commands.js');

    const response = (await handleSessionBoardModal(
      'sesboardmodal:find:-',
      typed('q', 'club'),
      CONTEXT
    )) as { type: number; data: Record<string, any> };

    expect(response.type).toBe(4);
    expect(response.data.flags).toBe(64);
    expect(response.data.components).toBeUndefined();
  });
});
