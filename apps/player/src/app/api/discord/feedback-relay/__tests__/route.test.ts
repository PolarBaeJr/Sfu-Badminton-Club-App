import { describe, it, expect, vi, beforeEach } from 'vitest';

// THE PROPERTY THIS FILE EXISTS FOR is the first test in "the two channels":
// a tournament survey comment is answered under a promise that only the exec
// team sees it, and it must never inherit its destination from the bug-report
// setting. One conflated channel id turns a private, named survey response into
// a public post with no takedown path.
//
// After that, the two halves are deliberately asymmetric and the tests pin the
// asymmetry:
//
//   feedback_reports  nothing deletes from it, so ABSENCE IS NOT DELETION and
//                     there is no sweep. A sweep here would retract live
//                     reports the moment they aged out of the window.
//   event_feedback    cascades away with a deleted tournament, so it DOES sweep
//                     — but only on positive evidence that the table reads at
//                     all, because this codebase has had three silent empty
//                     reads and one would otherwise wipe the channel.

interface ReportSeed {
  id: string;
  kind: string;
  title: string | null;
  body: string;
  image_url: string | null;
  discord_user_id: string | null;
  created_at: string;
  players: { full_name: string | null; handle: string | null } | null;
}

interface SurveySeed {
  id: string;
  rating: number | null;
  comment: string | null;
  created_at: string;
  updated_at: string;
  tournaments: { name: string | null } | null;
  players: { full_name: string | null; handle: string | null } | null;
}

let reports: ReportSeed[] = [];
let surveys: SurveySeed[] = [];
let mappings: Record<string, unknown>[] = [];
let settings: { key: string; value: string }[] = [];
let reportError: { message: string } | null = null;
let surveyError: { message: string } | null = null;
const upserts: Record<string, unknown>[] = [];
const deletes: [string, unknown][][] = [];

function iso(offsetHours: number): string {
  return new Date(Date.now() + offsetHours * 3600_000).toISOString();
}

function report(over: Partial<ReportSeed> = {}): ReportSeed {
  return {
    id: 'r1',
    kind: 'bug',
    title: 'Ladder spins forever',
    body: 'I log in and it never loads.',
    image_url: null,
    discord_user_id: '123',
    created_at: iso(-1),
    players: { full_name: 'Alice Nguyen', handle: 'alice' },
    ...over,
  };
}

function survey(over: Partial<SurveySeed> = {}): SurveySeed {
  return {
    id: 'f1',
    rating: 4,
    comment: 'Great draw, long waits between rounds.',
    created_at: iso(-3),
    updated_at: iso(-1),
    tournaments: { name: 'Summer Open' },
    players: { full_name: 'Bao Tran', handle: 'bao' },
    ...over,
  };
}

function mapping(over: Record<string, unknown> = {}) {
  return {
    source: 'event_feedback',
    source_id: 'f1',
    guild_id: 'g1',
    channel_id: 'chan-old',
    discord_message_id: 'msg-1',
    synced_summary: '4|Great draw, long waits between rounds.',
    ...over,
  };
}

/**
 * The filters are applied FOR REAL.
 *
 * A no-op .gte() would hand the window read every row and make the
 * "not in the window" tests vacuous — they would pass whether or not the route
 * swept. Same for .limit() and the cap tests.
 */
function rowBuilder(
  source: () => readonly unknown[],
  error: () => { message: string } | null
) {
  let rows = source() as Record<string, unknown>[];
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.order = (column: string, opts?: { ascending?: boolean }) => {
    const dir = opts?.ascending === false ? -1 : 1;
    rows = [...rows].sort((a, b) => dir * String(a[column]).localeCompare(String(b[column])));
    return builder;
  };
  builder.gte = (column: string, value: string) => {
    rows = rows.filter((r) => String(r[column]) >= value);
    return builder;
  };
  builder.eq = (column: string, value: unknown) => {
    rows = rows.filter((r) => r[column] === value);
    return builder;
  };
  builder.in = (column: string, values: unknown[]) => {
    rows = rows.filter((r) => values.includes(r[column]));
    return builder;
  };
  builder.limit = (n: number) => {
    rows = rows.slice(0, n);
    return builder;
  };
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: error() ? null : rows, error: error() }).then(resolve);
  return builder;
}

function mappingBuilder() {
  const builder = rowBuilder(() => mappings, () => null) as Record<string, unknown>;
  builder.upsert = (row: Record<string, unknown>) => {
    upserts.push(row);
    return Promise.resolve({ error: null });
  };
  builder.delete = () => {
    const filters: [string, unknown][] = [];
    const del: Record<string, unknown> = {};
    del.eq = (c: string, v: unknown) => {
      filters.push([c, v]);
      return del;
    };
    del.then = (resolve: (v: unknown) => unknown) => {
      deletes.push(filters);
      return Promise.resolve({ error: null }).then(resolve);
    };
    return del;
  };
  return builder;
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === 'discord_settings') {
        const b: Record<string, unknown> = {};
        b.select = () => Promise.resolve({ data: settings, error: null });
        return b;
      }
      if (table === 'discord_feedback_posts') return mappingBuilder();
      if (table === 'feedback_reports') return rowBuilder(() => reports, () => reportError);
      if (table === 'event_feedback') return rowBuilder(() => surveys, () => surveyError);
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

type Action = {
  kind: string;
  source: string;
  sourceId: string;
  channelId: string;
  title: string;
  body: string;
  author: string;
  rating: number | null;
  imageUrl: string | null;
};

async function get(guildId: string | null = 'g1', secret = 'test-secret') {
  const { GET } = await import('../route');
  const url = guildId
    ? `http://localhost/api/discord/feedback-relay?guildId=${guildId}`
    : 'http://localhost/api/discord/feedback-relay';
  const res = await GET(new Request(url, { headers: { authorization: `Bearer ${secret}` } }));
  return {
    status: res.status,
    body: (await res.json()) as { actions?: Action[]; skipped?: { reason: string }[] },
  };
}

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
  reports = [];
  surveys = [];
  mappings = [];
  settings = [
    { key: 'feedback_channel_id', value: 'chan-reports' },
    { key: 'event_feedback_channel_id', value: 'chan-surveys' },
  ];
  reportError = null;
  surveyError = null;
  upserts.length = 0;
  deletes.length = 0;
});

describe('the two channels', () => {
  it('never sends a survey comment to the bug-report channel', async () => {
    // THE PRIVACY PROPERTY. The form promises the exec team; the two settings
    // exist so nobody widens that audience by configuring the other one.
    reports = [report()];
    surveys = [survey()];

    const { body } = await get();
    const byId = Object.fromEntries((body.actions ?? []).map((a) => [a.sourceId, a]));

    expect(byId.r1?.channelId).toBe('chan-reports');
    expect(byId.f1?.channelId).toBe('chan-surveys');
  });

  it('relays nothing from a source whose channel is unset', async () => {
    // NOT an error — the club has simply not opted that half in.
    settings = [{ key: 'feedback_channel_id', value: 'chan-reports' }];
    reports = [report()];
    surveys = [survey()];

    const { body } = await get();

    expect(body.actions?.map((a) => a.source)).toEqual(['report']);
    expect(body.skipped?.some((s) => s.reason === 'no_event_feedback_channel')).toBe(true);
  });

  it('says nothing at all when neither channel is set', async () => {
    settings = [];
    reports = [report()];
    surveys = [survey()];

    expect((await get()).body.actions).toEqual([]);
  });
});

describe('reports', () => {
  it('posts a new report with its title, body and reporter', async () => {
    reports = [report()];

    const [action] = (await get()).body.actions as Action[];

    expect(action?.kind).toBe('post');
    expect(action?.title).toBe('Ladder spins forever');
    expect(action?.body).toContain('never loads');
    // Name AND mention: the name identifies them without leaving the channel,
    // the mention makes replying one click.
    expect(action?.author).toContain('Alice Nguyen');
    expect(action?.author).toContain('<@123>');
  });

  it('says an unlinked reporter is unlinked instead of leaving it blank', async () => {
    // The difference between "we cannot reply through the app" and "we do not
    // know who this is".
    reports = [report({ players: null })];

    const [action] = (await get()).body.actions as Action[];
    expect(action?.author).toMatch(/not linked/i);
    expect(action?.author).toContain('<@123>');
  });

  it('falls back to the kind when the report has no title', async () => {
    // 00172's rows predate the modal, so a null title is real data.
    reports = [report({ title: null })];
    expect(((await get()).body.actions as Action[])[0]?.title).toBe('Bug report');
  });

  it('posts a report once and never again', async () => {
    reports = [report()];
    mappings = [mapping({ source: 'report', source_id: 'r1', synced_summary: 'anything' })];

    expect((await get()).body.actions).toEqual([]);
  });

  it('carries the screenshot url through for the bot to fetch', async () => {
    const url = 'https://cdn.discordapp.com/attachments/1/2/shot.png';
    reports = [report({ image_url: url })];

    expect(((await get()).body.actions as Action[])[0]?.imageUrl).toBe(url);
  });

  it('ignores a report older than the window', async () => {
    reports = [report({ created_at: iso(-200) })];
    expect((await get()).body.actions).toEqual([]);
  });

  // ---- THE SWEEP THAT MUST NOT EXIST --------------------------------------

  it('does NOT retract a report that has aged out of the window', async () => {
    // Nothing deletes from feedback_reports, so absence means "old", not
    // "gone". A sweep here would tear down live reports on a timer.
    reports = [];
    mappings = [mapping({ source: 'report', source_id: 'r1' })];
    surveys = [survey({ id: 'other' })];

    const { body } = await get();
    expect(body.actions?.some((a) => a.source === 'report')).toBe(false);
  });
});

describe('survey responses', () => {
  it('posts a comment with its rating and the tournament it is about', async () => {
    surveys = [survey()];

    const [action] = (await get()).body.actions as Action[];

    expect(action?.kind).toBe('post');
    expect(action?.rating).toBe(4);
    expect(action?.title).toBe('Summer Open');
    expect(action?.author).toBe('Bao Tran');
  });

  it('does not relay a bare rating', async () => {
    // A number for the stats page, not something for a human to read. Relaying
    // them would bury the responses that have words in them.
    surveys = [survey({ comment: null })];

    const { body } = await get();
    expect(body.actions).toEqual([]);
    expect(body.skipped?.some((s) => s.reason === 'rating_only')).toBe(true);
  });

  it('edits its own message when the comment is revised', async () => {
    surveys = [survey({ comment: 'Actually the waits were fine.' })];
    mappings = [mapping()];

    const [action] = (await get()).body.actions as Action[];

    expect(action?.kind).toBe('edit');
    // The channel the message IS in, not the configured one: repointing the
    // setting does not move what is already posted.
    expect(action?.channelId).toBe('chan-old');
  });

  it('does not edit when nothing changed', async () => {
    surveys = [survey()];
    mappings = [mapping()];
    expect((await get()).body.actions).toEqual([]);
  });

  it('retracts when the member empties their comment', async () => {
    // The only retraction a member has: the form offers no delete.
    surveys = [survey({ comment: '   ' })];
    mappings = [mapping()];

    const [action] = (await get()).body.actions as Action[];
    expect(action?.kind).toBe('retract');
  });

  it('retracts when the tournament was deleted out from under it', async () => {
    // event_feedback cascades with the tournament, so the row genuinely
    // vanishes and the sweep is the only thing that can see it.
    surveys = [survey({ id: 'still-here' })];
    mappings = [mapping()];

    const { body } = await get();
    const retract = body.actions?.find((a) => a.kind === 'retract');

    expect(retract?.sourceId).toBe('f1');
  });

  it('re-reads a mapped response that is outside the window, so it is not swept', async () => {
    // Without the second, id-targeted read, a response relayed last month is
    // absent from the window and the sweep would call that a deletion.
    surveys = [survey({ updated_at: iso(-500) })];
    mappings = [mapping()];

    expect((await get()).body.actions).toEqual([]);
  });

  // ---- THE LIVENESS GUARD -------------------------------------------------

  it('refuses to retract anything when event_feedback reads as empty', async () => {
    // A missing SELECT grant or a stale PostgREST cache arrives as an EMPTY
    // LIST with no error. Treating that as a mass delete would wipe the
    // channel in one tick.
    surveys = [];
    mappings = [mapping()];
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { status, body } = await get();

    expect(status).toBe(503);
    expect(body.actions).toBeUndefined();
  });

  it('sweeps once any response exists, because reads are then proven to work', async () => {
    surveys = [survey({ id: 'unrelated', updated_at: iso(-500) })];
    mappings = [mapping()];

    const { body } = await get();
    expect(body.actions?.find((a) => a.kind === 'retract')?.sourceId).toBe('f1');
  });

  it('does not refuse when there is nothing mapped to retract', async () => {
    surveys = [];
    mappings = [];
    expect((await get()).status).toBe(200);
  });
});

describe('failures are never reported as nothing to do', () => {
  it('503s when the report read fails', async () => {
    reportError = { message: 'permission denied for table feedback_reports' };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await get()).status).toBe(503);
  });

  it('refuses without the service secret', async () => {
    expect((await get('g1', 'wrong')).status).toBe(401);
  });

  it('needs a guild', async () => {
    expect((await get(null)).status).toBe(400);
  });
});

describe('recording and clearing a mapping', () => {
  async function post(body: unknown) {
    const { POST } = await import('../route');
    const res = await POST(
      new Request('http://localhost/api/discord/feedback-relay', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    );
    return res.status;
  }

  const RECORD = {
    source: 'report',
    sourceId: 'r1',
    guildId: 'g1',
    channelId: 'c1',
    discordMessageId: 'msg-1',
    summary: 'Ladder spins forever',
  };

  it('records what Discord accepted', async () => {
    expect(await post(RECORD)).toBe(200);
    expect(upserts[0]).toMatchObject({ source: 'report', source_id: 'r1', guild_id: 'g1' });
  });

  it.each(['source', 'sourceId', 'guildId', 'channelId', 'discordMessageId', 'summary'])(
    'refuses a mapping missing %s',
    async (field) => {
      // An empty summary in particular would make every later tick see a
      // difference and edit the same message forever.
      const partial = { ...RECORD, [field]: '' };
      expect(await post(partial)).toBe(400);
      expect(upserts).toHaveLength(0);
    }
  );

  it('refuses a source that is not one of the two', async () => {
    expect(await post({ ...RECORD, source: 'players' })).toBe(400);
  });

  it('clears a mapping by all three keys', async () => {
    const { DELETE } = await import('../route');
    const res = await DELETE(
      new Request(
        'http://localhost/api/discord/feedback-relay?source=report&sourceId=r1&guildId=g1',
        { method: 'DELETE', headers: { authorization: 'Bearer test-secret' } }
      )
    );

    expect(res.status).toBe(200);
    expect(deletes[0]).toEqual([
      ['source', 'report'],
      ['source_id', 'r1'],
      ['guild_id', 'g1'],
    ]);
  });
});
