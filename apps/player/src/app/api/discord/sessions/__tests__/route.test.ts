import { describe, it, expect, vi, beforeEach } from 'vitest';

// The stub answers the way PostgREST really does on this column: `track` is an
// enum, so a value outside session_group is refused at PLAN time rather than
// matching zero rows. Reusing that behaviour here means a test cannot pass by
// filtering on a status string the database would have rejected outright --
// the exact bug session-track.ts exists to prevent.
const SESSION_GROUP = new Set(['competitive', 'recreational', 'all']);

const SCHEDULE = [
  { id: 'all-1', name: 'Club night', track: 'all', date: '2026-09-01' },
  { id: 'comp-1', name: 'Competitive practice', track: 'competitive', date: '2026-09-02' },
  { id: 'comp-2', name: 'Competitive drills', track: 'competitive', date: '2026-09-03' },
  { id: 'rec-1', name: 'Casual drop-in', track: 'recreational', date: '2026-09-04' },
];

// Twenty-four open nights across two tracks, which is more than the route
// returns. Two tracks rather than one because a count taken before the caller's
// narrowing and one taken after can only be told apart by a fixture where the
// two answers differ: 24 against 12.
const LONG_SCHEDULE = [
  ...Array.from({ length: 12 }, (_, i) => ({
    id: `long-all-${i}`,
    name: 'Club night',
    track: 'all',
    date: '2026-09-01',
  })),
  ...Array.from({ length: 12 }, (_, i) => ({
    id: `long-comp-${i}`,
    name: 'Competitive practice',
    track: 'competitive',
    date: '2026-09-01',
  })),
];

// Two gyms, one of which only hosts competitive nights, so the location filter
// and the caller narrowing can be asserted against one fixture. The second row
// is the same gym written differently: grouping is on the trimmed, case-folded
// value, so it must not become a second option.
const LOCATED_SCHEDULE = [
  { id: 'west-1', name: 'Club night', track: 'all', date: '2026-09-01', location: 'West Gym' },
  { id: 'west-2', name: 'Club night', track: 'all', date: '2026-09-02', location: 'west gym ' },
  {
    id: 'east-1',
    name: 'Competitive practice',
    track: 'competitive',
    date: '2026-09-03',
    location: 'East Gym',
  },
];

// Sixty-five open nights against a sixty-row window, which is the only shape
// that can tell an exact count from a capped one.
const OVERFLOWING_SCHEDULE = Array.from({ length: 65 }, (_, i) => ({
  id: `over-${i}`,
  name: 'Club night',
  track: 'all',
  date: '2026-09-01',
}));

const linkMaybeSingle = vi.fn();
const rpcMock = vi.fn();
let capturedTracks: string[] = [];
let schedule: {
  id: string;
  name: string;
  track: string;
  date: string;
  location?: string;
}[] = SCHEDULE;

function sessionsBuilder() {
  let rows = schedule;
  let refused: { code: string; message: string } | null = null;
  let cap = Infinity;
  // Only answered when the route asks for it, exactly as PostgREST does: a
  // response carries a total because the request said `count`, so a route that
  // stopped asking has to fail a test rather than quietly report the cap.
  let counting = false;
  const builder: any = {
    select: (_columns: string, options?: { count?: string }) => {
      counting = options?.count === 'exact';
      return builder;
    },
    eq: () => builder,
    or: () => builder,
    limit: (n: number) => {
      cap = n;
      return builder;
    },
    order: () => builder,
    in(column: string, values: string[]) {
      if (column === 'track') {
        capturedTracks = [...values];
        for (const v of values) {
          if (!SESSION_GROUP.has(v)) {
            refused = { code: '22P02', message: `invalid input value for enum session_group: "${v}"` };
            return builder;
          }
        }
        const wanted = new Set(values);
        rows = rows.filter((r) => wanted.has(r.track));
      }
      return builder;
    },
    // FILTER, THEN COUNT, THEN SLICE, in that order. The route calls .limit()
    // before the track filter is appended to the same builder, and the real
    // server applies neither until the request runs. Truncating inside limit()
    // would narrow an already-shortened list and count the wrong set, which
    // would leave the visibility assertions below passing for no reason.
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve(
        refused
          ? { data: null, error: refused, count: null }
          : {
              data: rows.slice(0, cap),
              error: null,
              count: counting ? rows.length : null,
            }
      ).then(resolve),
  };
  return builder;
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({
    from: (table: string) =>
      table === 'player_discord_links'
        ? { select: () => ({ eq: () => ({ maybeSingle: linkMaybeSingle }) }) }
        : sessionsBuilder(),
    rpc: rpcMock,
  }),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

// Per-test IP: the limiter is module-level and is not reset between tests.
let bucket = 0;
function req(discordUserId?: string, params?: Record<string, string>) {
  const headers: Record<string, string> = {
    authorization: 'Bearer test-secret',
    'x-forwarded-for': `10.1.0.${(bucket += 1)}`,
  };
  if (discordUserId) headers['x-discord-user-id'] = discordUserId;
  const url = new URL('http://localhost/api/discord/sessions');
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
  return new Request(url, { headers });
}

async function tracksFor(discordUserId?: string) {
  const { GET } = await import('../route');
  const body = (await (await GET(req(discordUserId))).json()) as {
    sessions: { id: string }[];
    linked: boolean;
    total: number;
  };
  return {
    tracks: capturedTracks,
    ids: body.sessions.map((s) => s.id),
    linked: body.linked,
    total: body.total,
  };
}

// Everything the bot renders a footer and a control row from, in one read.
async function listFor(params?: Record<string, string>, discordUserId?: string) {
  const { GET } = await import('../route');
  const body = (await (await GET(req(discordUserId, params))).json()) as {
    sessions: { id: string }[];
    linked: boolean;
    page: number;
    totalPages: number;
    total: number;
    query: string | null;
    location: string | null;
    locations: { id: string; label: string }[];
    windowCapReached?: boolean;
  };
  return { ...body, ids: body.sessions.map((s) => s.id) };
}

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
  capturedTracks = [];
  schedule = SCHEDULE;
  linkMaybeSingle.mockReset();
  linkMaybeSingle.mockResolvedValue({ data: null, error: null });
  rpcMock.mockReset();
  rpcMock.mockResolvedValue({ data: [], error: null });
});

describe('GET /api/discord/sessions — who sees which track', () => {
  it('refuses without the service secret', async () => {
    const { GET } = await import('../route');
    const bad = new Request('http://localhost/api/discord/sessions', {
      headers: { authorization: 'Bearer wrong' },
    });
    expect((await GET(bad)).status).toBe(401);
  });

  it('does NOT show competitive sessions to a linked recreational member', async () => {
    // The reported bug, stated as the assertion.
    linkMaybeSingle.mockResolvedValue({ data: { players: { status: 'recreational' } }, error: null });
    const { ids, linked } = await tracksFor('111');

    expect(linked).toBe(true);
    expect(ids).toEqual(['all-1', 'rec-1']);
    expect(ids).not.toContain('comp-1');
    expect(ids).not.toContain('comp-2');
  });

  it('shows a linked competitive member their track and club-wide nights', async () => {
    linkMaybeSingle.mockResolvedValue({ data: { players: { status: 'competitive' } }, error: null });
    const { ids } = await tracksFor('222');
    expect(ids).toEqual(['all-1', 'comp-1', 'comp-2']);
  });

  it('shows an UNTRACKED member the whole schedule, matching the website', async () => {
    // Deliberate, not an oversight: session-track.ts argues that narrowing a
    // pending member to ['all'] shows them an empty schedule during frosh week.
    // Pinned so a later "tighten everything" pass has to argue with a test.
    linkMaybeSingle.mockResolvedValue({
      data: { players: { status: 'pending_approval' } },
      error: null,
    });
    const { ids, tracks } = await tracksFor('333');
    expect(ids).toEqual(['all-1', 'comp-1', 'comp-2', 'rec-1']);
    // And never as a raw status, which is what the 22P02 outage was.
    expect(tracks).not.toContain('pending_approval');
  });

  it('shows an UNLINKED caller club-wide nights only', async () => {
    linkMaybeSingle.mockResolvedValue({ data: null, error: null });
    const { ids, tracks, linked } = await tracksFor('444');
    expect(linked).toBe(false);
    expect(tracks).toEqual(['all']);
    expect(ids).toEqual(['all-1']);
  });

  it('treats a caller with no id at all as unlinked', async () => {
    const { ids, linked } = await tracksFor(undefined);
    expect(linked).toBe(false);
    expect(ids).toEqual(['all-1']);
  });

  it('FAILS CLOSED when the link lookup errors', async () => {
    // A failed PostgREST read arrives as data:null WITH an error rather than a
    // throw. Treating that as "linked, no track" would widen the schedule on a
    // database fault; the safe reading is the narrow one.
    linkMaybeSingle.mockResolvedValue({
      data: null,
      error: { code: '42P01', message: 'relation does not exist' },
    });
    const { ids, tracks, linked } = await tracksFor('555');
    expect(linked).toBe(false);
    expect(tracks).toEqual(['all']);
    expect(ids).toEqual(['all-1']);
  });
});

// The route returns at most MAX_SESSIONS rows, so `total` is the only thing in
// the payload that can tell a caller the list is short. /sessionpost publishes
// it into a channel, where a post of ten out of twenty-eight reads as the club
// saying it runs ten nights.
describe('GET /api/discord/sessions: how many there really are', () => {
  it('reports the total alongside the sessions', async () => {
    linkMaybeSingle.mockResolvedValue({ data: { players: { status: 'competitive' } }, error: null });
    const { ids, total } = await tracksFor('666');
    expect(total).toBe(ids.length);
  });

  it('counts every matching night, not the ones it returned', async () => {
    // 24 match, 10 come back. A total taken from the rows would say 10, which
    // is the defect: the post would claim the cap is the whole schedule.
    schedule = LONG_SCHEDULE;
    linkMaybeSingle.mockResolvedValue({ data: { players: { status: 'competitive' } }, error: null });
    const { ids, total } = await tracksFor('777');
    expect(ids).toHaveLength(10);
    expect(total).toBe(24);
  });

  it('reports zero when nothing is open', async () => {
    schedule = [];
    const { ids, total } = await tracksFor(undefined);
    expect(ids).toEqual([]);
    expect(total).toBe(0);
  });

  // THE ONE THAT MATTERS. The total is counted after the caller's narrowing, so
  // it describes the schedule they are allowed to see. Counted before it, the
  // number would tell an unlinked Discord user how many competitive nights the
  // club runs, which is the fact the row list is filtered to withhold.
  it('scopes the total to what the caller may see', async () => {
    schedule = LONG_SCHEDULE;

    linkMaybeSingle.mockResolvedValue({ data: { players: { status: 'competitive' } }, error: null });
    const member = await tracksFor('888');

    linkMaybeSingle.mockResolvedValue({ data: null, error: null });
    const stranger = await tracksFor('999');

    // Both are capped at 10 rows, so the leak would be invisible in the list.
    expect(member.ids).toHaveLength(10);
    expect(stranger.ids).toHaveLength(10);

    expect(member.total).toBe(24);
    expect(stranger.total).toBe(12);
  });
});

// The bot gets one app call per interaction, so every number its footer prints
// and every page its buttons target is computed here. A page it cannot reach is
// a row nobody ever sees.
describe('GET /api/discord/sessions: paging', () => {
  beforeEach(() => {
    schedule = LONG_SCHEDULE;
    linkMaybeSingle.mockResolvedValue({ data: { players: { status: 'competitive' } }, error: null });
  });

  it('defaults to page 1 and reports how many pages there are', async () => {
    const body = await listFor(undefined, '1001');
    expect(body.page).toBe(1);
    expect(body.totalPages).toBe(3);
    expect(body.total).toBe(24);
    expect(body.ids).toHaveLength(10);
  });

  it('returns the second page of rows', async () => {
    const first = await listFor({ page: '1' }, '1002');
    const second = await listFor({ page: '2' }, '1003');
    expect(second.page).toBe(2);
    expect(second.ids).toHaveLength(10);
    for (const id of second.ids) expect(first.ids).not.toContain(id);
  });

  it('clamps a page past the end onto the last real page', async () => {
    // A button minted against a longer list must land somewhere, and page 1 is
    // not it: the member asked to go forwards.
    const body = await listFor({ page: '99' }, '1004');
    expect(body.page).toBe(3);
    expect(body.ids).toHaveLength(4);
  });

  it('treats zero, a negative page and a non-number as page 1', async () => {
    for (const page of ['0', '-1', 'abc', '']) {
      const body = await listFor({ page }, '1005');
      expect(body.page).toBe(1);
    }
  });

  it('asks for the counts of the page it returned, not of the whole window', async () => {
    const body = await listFor({ page: '2' }, '1006');
    expect(rpcMock).toHaveBeenCalledWith('get_session_attendee_counts', {
      p_session_ids: body.ids,
    });
  });

  it('carries the paging fields when nothing is open', async () => {
    schedule = [];
    const body = await listFor(undefined, '1007');
    expect(body).toMatchObject({
      page: 1,
      totalPages: 1,
      total: 0,
      query: null,
      location: null,
      locations: [],
    });
  });

  it('never advertises a page past the fetch window', async () => {
    // 65 match, 60 are read. The total stays exact because the count is taken by
    // the database, but a page 7 would resolve to rows nobody fetched.
    schedule = OVERFLOWING_SCHEDULE;
    const body = await listFor(undefined, '1008');
    expect(body.total).toBe(65);
    expect(body.totalPages).toBe(6);
    expect(body.windowCapReached).toBe(true);
  });

  it('says nothing about the window when the window is not full', async () => {
    const body = await listFor(undefined, '1009');
    expect(body.windowCapReached).toBeUndefined();
  });
});

describe('GET /api/discord/sessions: search', () => {
  it('does NOT let a search reach a track the caller may not see', async () => {
    // The same guarantee as the narrowing tests above, restated for the filter
    // that runs after it: a recreational member searching a competitive night by
    // its exact name gets nothing, not that night.
    linkMaybeSingle.mockResolvedValue({
      data: { players: { status: 'recreational' } },
      error: null,
    });
    const body = await listFor({ q: 'Competitive practice' }, '1010');
    expect(body.ids).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('matches case-insensitively and echoes what it applied', async () => {
    linkMaybeSingle.mockResolvedValue({ data: { players: { status: 'competitive' } }, error: null });
    const body = await listFor({ q: 'CLUB NIGHT' }, '1011');
    expect(body.ids).toEqual(['all-1']);
    expect(body.query).toBe('club night');
  });

  it('matches the location as well as the name', async () => {
    schedule = LOCATED_SCHEDULE;
    linkMaybeSingle.mockResolvedValue({ data: { players: { status: 'competitive' } }, error: null });
    const body = await listFor({ q: 'east' }, '1012');
    expect(body.ids).toEqual(['east-1']);
  });

  it('treats a wildcard as a literal character', async () => {
    // Which is the proof that no PostgREST pattern match is involved: under ilike
    // this would match every row.
    linkMaybeSingle.mockResolvedValue({ data: { players: { status: 'competitive' } }, error: null });
    const body = await listFor({ q: '%' }, '1013');
    expect(body.ids).toEqual([]);
  });

  it('answers on one page and reports the full match count', async () => {
    schedule = LONG_SCHEDULE;
    linkMaybeSingle.mockResolvedValue({ data: { players: { status: 'competitive' } }, error: null });
    const body = await listFor({ q: 'club night' }, '1014');
    expect(body.ids).toHaveLength(10);
    expect(body.total).toBe(12);
    expect(body.totalPages).toBe(1);
    expect(body.page).toBe(1);
  });

  it('treats a whitespace-only search as no search at all', async () => {
    linkMaybeSingle.mockResolvedValue({ data: { players: { status: 'competitive' } }, error: null });
    const body = await listFor({ q: '   ' }, '1015');
    expect(body.query).toBeNull();
    expect(body.ids).toEqual(['all-1', 'comp-1', 'comp-2']);
  });
});

describe('GET /api/discord/sessions: the location filter', () => {
  beforeEach(() => {
    schedule = LOCATED_SCHEDULE;
  });

  it('lists each gym once, by a stable id', async () => {
    linkMaybeSingle.mockResolvedValue({ data: { players: { status: 'competitive' } }, error: null });
    const first = await listFor(undefined, '1016');
    const second = await listFor(undefined, '1017');

    expect(first.locations.map((l) => l.label)).toEqual(['West Gym', 'East Gym']);
    expect(second.locations).toEqual(first.locations);
  });

  it('pages over the filtered set, not the whole window', async () => {
    linkMaybeSingle.mockResolvedValue({ data: { players: { status: 'competitive' } }, error: null });
    const all = await listFor(undefined, '1018');
    const west = all.locations.find((l) => l.label === 'West Gym')!;

    const body = await listFor({ location: west.id }, '1019');
    expect(body.ids).toEqual(['west-1', 'west-2']);
    expect(body.total).toBe(2);
    expect(body.totalPages).toBe(1);
    expect(body.location).toBe(west.id);
  });

  it('does NOT let a location id reach a track the caller may not see', async () => {
    linkMaybeSingle.mockResolvedValue({ data: { players: { status: 'competitive' } }, error: null });
    const seen = await listFor(undefined, '1020');
    const east = seen.locations.find((l) => l.label === 'East Gym')!;

    linkMaybeSingle.mockResolvedValue({
      data: { players: { status: 'recreational' } },
      error: null,
    });
    const body = await listFor({ location: east.id }, '1021');

    // That gym is not in this caller's window at all, so the id does not resolve
    // and the echo says so. What they get is their own unfiltered page.
    expect(body.ids).not.toContain('east-1');
    expect(body.location).toBeNull();
  });

  it('falls back to the unfiltered page when the id no longer resolves', async () => {
    linkMaybeSingle.mockResolvedValue({ data: { players: { status: 'competitive' } }, error: null });
    const body = await listFor({ location: 'deadbeef' }, '1022');
    expect(body.ids).toEqual(['west-1', 'west-2', 'east-1']);
    expect(body.location).toBeNull();
  });
});
