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

const linkMaybeSingle = vi.fn();
let capturedTracks: string[] = [];
let schedule: { id: string; name: string; track: string; date: string }[] = SCHEDULE;

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
    rpc: async () => ({ data: [], error: null }),
  }),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

// Per-test IP: the limiter is module-level and is not reset between tests.
let bucket = 0;
function req(discordUserId?: string) {
  const headers: Record<string, string> = {
    authorization: 'Bearer test-secret',
    'x-forwarded-for': `10.1.0.${(bucket += 1)}`,
  };
  if (discordUserId) headers['x-discord-user-id'] = discordUserId;
  return new Request('http://localhost/api/discord/sessions', { headers });
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

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
  capturedTracks = [];
  schedule = SCHEDULE;
  linkMaybeSingle.mockReset();
  linkMaybeSingle.mockResolvedValue({ data: null, error: null });
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
