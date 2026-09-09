import { describe, it, expect, vi, beforeEach } from 'vitest';

// The outbox (00222), and the property that matters is the CLAIM.
//
// The bot runs at N replicas and pg_cron's tick lands on whichever one the
// proxy picks, so two overlapping ticks are two different processes reading
// this table. A plain SELECT would hand the same row to both and post a club
// message twice, in a channel every member reads.
//
// GET therefore claims in the same statement it returns. The SELECT above it is
// only a candidate list — PostgREST has no UPDATE ... LIMIT, so an unbounded
// claim would take every pending row and hold ones this tick will not post.
// The safety is entirely in the UPDATE restating every condition, and that is
// what the first test here asserts: not the happy path, but that the write
// re-checks what the read checked.

interface Call {
  table: string;
  op: 'select' | 'update';
  filters: [string, unknown][];
  payload?: Record<string, unknown>;
}

let calls: Call[] = [];
let selectRows: Record<string, unknown>[] = [];
let playerRows: Record<string, unknown>[] = [];
let playerError: { message: string } | null = null;
let updateRows: Record<string, unknown>[] = [];
let selectError: { message: string } | null = null;
let updateError: { message: string } | null = null;
let single: Record<string, unknown> | null = null;

function builder(call: Call, rows: () => Record<string, unknown>[], error: () => unknown) {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'lt', 'or', 'in', 'order', 'limit']) {
    b[m] = (a?: unknown, c?: unknown) => {
      if (m !== 'select' && m !== 'order' && m !== 'limit') call.filters.push([m, a]);
      if (m === 'select') call.op = call.op ?? 'select';
      void c;
      return b;
    };
  }
  b.maybeSingle = () => Promise.resolve({ data: single, error: null });
  b.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: rows(), error: error() }).then(resolve);
  return b;
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => ({
      select: (..._a: unknown[]) => {
        const call: Call = { table, op: 'select', filters: [] };
        calls.push(call);
        return builder(
          call,
          () => (table === 'players' ? playerRows : selectRows),
          () => (table === 'players' ? playerError : selectError)
        );
      },
      update: (payload: Record<string, unknown>) => {
        const call: Call = { table, op: 'update', filters: [], payload };
        calls.push(call);
        return builder(call, () => updateRows, () => updateError);
      },
    }),
  }),
}));

import { GET, POST } from '../route';

const AUTH = { authorization: 'Bearer test-secret' };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
  calls = [];
  selectRows = [];
  playerRows = [];
  playerError = null;
  updateRows = [];
  selectError = null;
  updateError = null;
  single = null;
});

const get = (url = 'http://localhost/api/discord/outbox?guildId=g1', headers = AUTH) =>
  new Request(url, { headers });

const post = (body: unknown, headers = AUTH) =>
  new Request('http://localhost/api/discord/outbox', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('the gate', () => {
  it('refuses without the service secret', async () => {
    expect((await GET(get(undefined, { authorization: 'Bearer no' }))).status).toBe(401);
    expect((await POST(post({ id: 'o1' }, { authorization: 'Bearer no' }))).status).toBe(401);
  });

  it('needs a guild', async () => {
    expect((await GET(get('http://localhost/api/discord/outbox'))).status).toBe(400);
  });
});

describe('claiming', () => {
  it('re-states every condition on the UPDATE, not just on the read', async () => {
    // THE TEST THIS FILE EXISTS FOR. The candidate SELECT is allowed to be
    // stale; the claim is not. Dropping any one of these from the write turns
    // the read from a hint into a race, and the symptom is a duplicate club
    // message rather than an error.
    selectRows = [{ id: 'o1' }];
    updateRows = [
      {
        id: 'o1',
        channel_id: 'c1',
        content: 'hi',
        embed_title: null,
        embed_body: null,
        embed_type: null,
        ping: false,
        attempts: 0,
      },
    ];

    await GET(get());

    const claim = calls.find((c) => c.op === 'update');
    expect(claim, 'the route did not claim at all').toBeDefined();
    const named = claim!.filters.map(([m, a]) => `${m}:${String(a)}`);
    expect(named).toContain('is:sent_at');
    expect(named).toContain('is:failed_at');
    expect(named).toContain('lt:attempts');
    expect(named).toContain('in:id');
    // The stale-claim window, so a row a dead replica took comes back.
    expect(claim!.filters.some(([m, a]) => m === 'or' && String(a).includes('claimed_at'))).toBe(
      true,
    );
    expect(claim!.payload).toHaveProperty('claimed_at');
  });

  it('claims nothing when nothing is pending', async () => {
    selectRows = [];
    const res = await GET(get());
    expect(await res.json()).toEqual({ messages: [] });
    expect(calls.some((c) => c.op === 'update')).toBe(false);
  });

  it('names a failed read instead of reporting an empty queue', async () => {
    // A failed PostgREST read arrives as data:null with no throw. Degrading it
    // to "nothing queued" makes a broken table look like an idle one — the way
    // this codebase has been bitten three separate times.
    selectError = { message: 'relation does not exist' };
    const res = await GET(get());
    expect(res.status).toBe(503);
  });

  it('hands back the embed shape when the row has one', async () => {
    selectRows = [{ id: 'o1' }];
    updateRows = [
      {
        id: 'o1',
        channel_id: 'c1',
        content: null,
        embed_title: 'Courts closed',
        embed_body: 'Gym booked.',
        embed_type: 'urgent',
        ping: true,
        attempts: 1,
      },
    ];
    const { messages } = (await (await GET(get())).json()) as {
      messages: { content: string | null; embed: unknown; ping: boolean }[];
    };
    expect(messages[0]?.content).toBeNull();
    expect(messages[0]?.embed).toEqual({
      title: 'Courts closed',
      body: 'Gym booked.',
      type: 'urgent',
    });
    expect(messages[0]?.ping).toBe(true);
  });
});

describe('recording what Discord did', () => {
  it('needs an outcome, not just an id', async () => {
    expect((await POST(post({ id: 'o1' }))).status).toBe(400);
    expect((await POST(post({ discordMessageId: 'm1' }))).status).toBe(400);
  });

  it('closes the row on a send, and only while it is still unsent', async () => {
    const res = await POST(post({ id: 'o1', discordMessageId: 'm1' }));
    expect(res.status).toBe(200);

    const write = calls.find((c) => c.op === 'update')!;
    expect(write.payload).toMatchObject({ discord_message_id: 'm1', last_error: null });
    expect(write.payload).toHaveProperty('sent_at');
    // A late write-back from a bot that was already mid-post must not re-open a
    // row somebody has since resolved.
    expect(write.filters).toContainEqual(['is', 'sent_at']);
  });

  it('spends an attempt and releases the claim on a failure', async () => {
    single = { attempts: 0 };
    await POST(post({ id: 'o1', error: 'Missing Permissions' }));

    const write = calls.find((c) => c.op === 'update')!;
    expect(write.payload).toMatchObject({
      attempts: 1,
      claimed_at: null,
      last_error: 'Missing Permissions',
    });
    // Still in the pool: a transient refusal has to be retried.
    expect(write.payload).not.toHaveProperty('failed_at');
  });

  it('stops retrying once the attempt budget is spent', async () => {
    single = { attempts: 2 };
    await POST(post({ id: 'o1', error: 'Missing Permissions' }));

    const write = calls.find((c) => c.op === 'update')!;
    expect(write.payload).toMatchObject({ attempts: 3 });
    // Out for good, with the reason still readable in the console — which is
    // the only thing that gets a missing permission fixed.
    expect(write.payload).toHaveProperty('failed_at');
  });

  it('truncates whatever Discord said before it reaches a page', async () => {
    single = { attempts: 0 };
    await POST(post({ id: 'o1', error: 'x'.repeat(900) }));
    const write = calls.find((c) => c.op === 'update')!;
    expect((write.payload!.last_error as string).length).toBe(500);
  });

  it('is LOUD when a send cannot be recorded', async () => {
    // The message is already in the channel and the row is still claimable. A
    // 200 here would hide the one failure that produces a duplicate.
    updateError = { message: 'row locked' };
    expect((await POST(post({ id: 'o1', discordMessageId: 'm1' }))).status).toBe(503);
  });
});

// WHO ASKED. The bot writes an audit entry for every message it posts on the
// console's behalf, for the same reason /say does — a bot that speaks for the
// club with no record of who moved its mouth is the thing worth not building —
// and the bot has no players table. The name has to come from here or the
// entry cannot say anything.
describe('attribution', () => {
  const claimed = (extra: Record<string, unknown> = {}) => {
    selectRows = [{ id: 'o1' }];
    updateRows = [
      {
        id: 'o1',
        channel_id: 'c1',
        content: 'Doors open at seven.',
        embed_title: null,
        embed_body: null,
        embed_type: null,
        ping: false,
        attempts: 0,
        requested_by: 'p1',
        ...extra,
      },
    ];
  };

  it('resolves the requester to a name the bot can print', async () => {
    claimed();
    playerRows = [{ id: 'p1', full_name: 'Priya Raman' }];

    const body = (await (await GET(get())).json()) as { messages: { requestedBy: string }[] };
    expect(body.messages[0]?.requestedBy).toBe('Priya Raman');
  });

  it('hands back a claim with no requester rather than failing', async () => {
    // ON DELETE SET NULL (00222): the exec who queued it left the club. The
    // message is still queued and still has to go out.
    claimed({ requested_by: null });
    const body = (await (await GET(get())).json()) as { messages: { requestedBy: null }[] };
    expect(body.messages[0]?.requestedBy).toBeNull();
  });

  it('still returns the claim when the name lookup fails', async () => {
    // THE ROWS ARE ALREADY CLAIMED at this point. A 503 here would strand them
    // for the full ten minutes over a missing display name — the claim is the
    // expensive thing to lose, the name is not.
    claimed();
    playerError = { message: 'relation does not exist' };

    const res = await GET(get());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: { id: string; requestedBy: null }[] };
    expect(body.messages[0]?.id).toBe('o1');
    expect(body.messages[0]?.requestedBy).toBeNull();
  });
});
