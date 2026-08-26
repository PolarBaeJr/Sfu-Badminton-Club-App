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

const linkMaybeSingle = vi.fn();
let capturedTracks: string[] = [];

function sessionsBuilder() {
  let rows = SCHEDULE;
  let refused: { code: string; message: string } | null = null;
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    or: () => builder,
    order: () => builder,
    limit: () => builder,
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
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve(refused ? { data: null, error: refused } : { data: rows, error: null }).then(
        resolve
      ),
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
  };
  return { tracks: capturedTracks, ids: body.sessions.map((s) => s.id), linked: body.linked };
}

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
  capturedTracks = [];
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
