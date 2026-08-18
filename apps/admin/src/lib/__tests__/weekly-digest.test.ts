// THE ONLY SCHEDULED MAIL THE APP SENDS, and the one job whose failure mode is
// mailing the same person twice.
//
// It used to send to every eligible member inside a single request. pg_net
// times out at 5s by default, so the run looked failed whether or not it was,
// and re-POSTing it — the obvious thing to do with a failed job — mailed
// everyone again from the top. The cursor tests below are the ones that matter:
// they are what makes a retry safe.
//
// The second group is about the rating figure, which reported one number as
// both the singles and the doubles rating, took it from whichever row happened
// to arrive last, and defaulted it to 0.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sendWeeklyDigestEmail = vi.fn(async () => ({ sent: true }));
vi.mock('@badminton/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@badminton/shared')>()),
  sendWeeklyDigestEmail,
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

// The cursor lives in cron_config, so the fake has to persist it BETWEEN calls
// the way the table does — a store reset per test, not per request.
let store: { value: string | null };
let matchRows: unknown[];
const filters: { gte: unknown[]; lt: unknown[] } = { gte: [], lt: [] };

vi.mock('@/lib/supabase-server', () => ({
  createAdminClient: () => ({
    from(table: string) {
      if (table === 'cron_config') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: store.value ? { value: store.value } : null }) }),
          }),
          upsert: async (row: { value: string }) => {
            store.value = row.value;
            return { error: null };
          },
        };
      }
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.gte = (_c: string, v: unknown) => { filters.gte.push(v); return q; };
      q.lt = (_c: string, v: unknown) => { filters.lt.push(v); return q; };
      q.eq = () => q;
      q.order = () => q;
      q.range = (from: number, to: number) =>
        Promise.resolve({ data: matchRows.slice(from, to + 1), error: null });
      return q;
    },
  }),
}));

const { POST } = await import('@/app/api/cron/weekly-digest/route');

const SECRET = 'test-cron-secret';
const run = () =>
  POST(new Request('https://console.example/admin/api/cron/weekly-digest', {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}` },
  }));

/** One confirmed match participation. */
function row(playerId: string, opts: Partial<{
  postRating: number | null; playedAt: string; matchType: string; win: boolean;
}> = {}) {
  return {
    player_id: playerId,
    rating_delta: 5,
    post_rating: opts.postRating === undefined ? 1000 : opts.postRating,
    win_flag: opts.win ?? true,
    matches: {
      played_at: opts.playedAt ?? '2026-08-12T00:00:00.000Z',
      result_status: 'confirmed',
      match_type: opts.matchType ?? 'singles',
    },
    players: { full_name: 'Member', email: `${playerId}@sfu.ca` },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sendWeeklyDigestEmail.mockImplementation(async () => ({ sent: true }));
  store = { value: null };
  matchRows = [];
  filters.gte = [];
  filters.lt = [];
  process.env.CRON_SECRET = SECRET;
  // A Monday. weekStart() must resolve to this same date for every invocation
  // in the run, which is what makes the cursor comparable across them.
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-17T17:00:00.000Z'));
});
afterEach(() => vi.useRealTimers());

const recipients = () => sendWeeklyDigestEmail.mock.calls.map((c) => (c as unknown[])[0]);

describe('weekly-digest — resuming instead of restarting', () => {
  it('sends a bounded batch and reports what is left', async () => {
    // 45 eligible members against a 40-send cap.
    matchRows = Array.from({ length: 45 }, (_, i) => row(`p-${String(i).padStart(2, '0')}`));
    const res = await run();
    const body = await res.json();

    expect(body.eligible).toBe(45);
    expect(body.sent).toBe(40);
    expect(body.remaining).toBe(5);
    expect(body.complete).toBe(false);
  });

  it('RESUMES on the next invocation instead of mailing the first batch again', async () => {
    matchRows = Array.from({ length: 45 }, (_, i) => row(`p-${String(i).padStart(2, '0')}`));

    await run();
    const first = recipients();
    expect(first).toHaveLength(40);

    sendWeeklyDigestEmail.mockClear();
    const res = await run();
    const second = recipients();

    // This is the whole point: no address appears in both runs.
    expect(second).toHaveLength(5);
    expect(second.filter((r) => first.includes(r))).toEqual([]);
    expect((await res.json()).complete).toBe(true);
  });

  it('is a no-op once the week is finished, however many times it is POSTed', async () => {
    matchRows = [row('p-00'), row('p-01')];
    await run();
    sendWeeklyDigestEmail.mockClear();

    const res = await run();
    expect(recipients()).toEqual([]);
    expect((await res.json()).already_complete).toBe(true);
  });

  it('starts a fresh week rather than treating last week as done', async () => {
    matchRows = [row('p-00')];
    await run();
    expect(recipients()).toHaveLength(1);

    // Next Monday. Same member, genuinely new mail — not a duplicate.
    vi.setSystemTime(new Date('2026-08-24T17:00:00.000Z'));
    sendWeeklyDigestEmail.mockClear();
    await run();
    expect(recipients()).toEqual(['p-00@sfu.ca']);
  });

  it('advances the cursor past a member who was NOT mailed', async () => {
    // Opted out of the announcements category, or suppressed. The send resolves
    // with sent:false — a decision, not a failure. If the cursor stalled here
    // the job would re-evaluate them for ever and never reach anyone after.
    matchRows = [row('p-00'), row('p-01')];
    sendWeeklyDigestEmail.mockImplementation(async () => ({ sent: false }));

    const res = await run();
    const body = await res.json();
    expect(body.skipped).toBe(2);
    expect(body.complete).toBe(true);
    expect(JSON.parse(store.value!).after).toBe('p-01');
  });

  it('reads every page, so a busy week is not truncated at the 1000-row cap', async () => {
    // PostgREST truncates at PGRST_DB_MAX_ROWS silently and supabase-js
    // resolves, so an unpaged read would return 1000 rows and the members past
    // the cap would simply never be mailed.
    matchRows = Array.from({ length: 1200 }, (_, i) => row(`p-${String(i).padStart(4, '0')}`));
    const body = await (await run()).json();
    expect(body.eligible).toBe(1200);
  });
});

describe('weekly-digest — the rating figure', () => {
  it('does not report a doubles rating as the singles rating', async () => {
    matchRows = [row('p-00', { matchType: 'doubles', postRating: 1234 })];
    await run();
    const data = (sendWeeklyDigestEmail.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(data.doublesRating).toBe(1234);
    expect(data.singlesRating).toBeNull();
  });

  it('keeps each discipline separate when the member played both', async () => {
    matchRows = [
      row('p-00', { matchType: 'singles', postRating: 1100 }),
      row('p-00', { matchType: 'doubles', postRating: 900 }),
    ];
    await run();
    const data = (sendWeeklyDigestEmail.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(data.singlesRating).toBe(1100);
    expect(data.doublesRating).toBe(900);
  });

  it('takes the LATEST rating by played_at, not whichever row arrived last', async () => {
    // Deliberately out of order. An unordered read is exactly what the job got.
    matchRows = [
      row('p-00', { postRating: 1300, playedAt: '2026-08-15T00:00:00.000Z' }),
      row('p-00', { postRating: 1000, playedAt: '2026-08-11T00:00:00.000Z' }),
    ];
    await run();
    const data = (sendWeeklyDigestEmail.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(data.singlesRating).toBe(1300);
  });

  it('reports no rating rather than 0 for an unrated week', async () => {
    matchRows = [row('p-00', { postRating: null })];
    await run();
    const data = (sendWeeklyDigestEmail.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(data.singlesRating).toBeNull();
    expect(data.doublesRating).toBeNull();
    expect(data.matchesPlayed).toBe(1);
  });
});

describe('weekly-digest — the period', () => {
  it('is anchored to the week boundary at BOTH ends, so no match is counted twice', async () => {
    matchRows = [row('p-00')];
    await run();
    // Monday-to-Monday, not "the last seven days from whenever this fired".
    // Without the upper bound a match played after the job ran would land in
    // this week's digest and next week's.
    expect(filters.gte[0]).toBe('2026-08-10T00:00:00.000Z');
    expect(filters.lt[0]).toBe('2026-08-17T00:00:00.000Z');
  });
});
