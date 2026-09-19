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

const sendWeeklyDigestEmail = vi.fn(async () => ({ sent: true, providerMessageId: 'msg-1' }));
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

// digest_deliveries (00194) — the per-recipient, per-window claim. Modelled as
// the real table is: a PRIMARY KEY on (week_start, player_id), and an insert
// that hits it returns NO ROW rather than an error, which is what makes the
// claim an exclusion instead of a write.
interface Delivery {
  week_start: string; player_id: string;
  claimed_at: string; completed_at: string | null;
  outcome: string | null; provider_message_id: string | null;
}
let deliveries: Map<string, Delivery>;
let deliveryReadError: string | null;
let deliveryClaimError: string | null;
const dkey = (w: string, p: string) => `${w}|${p}`;

// season_final_ratings: one row per player per season, written by
// activate_season and re-stamped by a correction to a finished season. The
// route head-counts the rows archived inside the digest window to decide
// whether to withhold the Elo figures.
let archivedAt: string[];
let rolloverReadError: string | null;
let rolloverReadNulled: boolean;

vi.mock('@/lib/supabase-server', () => ({
  createAdminClient: () => ({
    from(table: string) {
      if (table === 'digest_deliveries') {
        return {
          select: (_cols: string) => ({
            eq: async (_c: string, week: string) => (deliveryReadError
              ? { data: null, error: { message: deliveryReadError } }
              : {
                data: [...deliveries.values()].filter((d) => d.week_start === week),
                error: null,
              }),
          }),
          upsert: (rowIn: { week_start: string; player_id: string; claimed_at: string }) => ({
            // ignoreDuplicates: the returned set is the rows this statement
            // actually inserted, so an existing key yields [].
            select: async () => {
              if (deliveryClaimError) return { data: null, error: { message: deliveryClaimError } };
              const k = dkey(rowIn.week_start, rowIn.player_id);
              if (deliveries.has(k)) return { data: [], error: null };
              deliveries.set(k, {
                week_start: rowIn.week_start, player_id: rowIn.player_id,
                claimed_at: rowIn.claimed_at, completed_at: null,
                outcome: null, provider_message_id: null,
              });
              return { data: [{ player_id: rowIn.player_id }], error: null };
            },
          }),
          // Reports a matched-row COUNT, because PostgREST does and the route
          // now reads it. Modelling a miss as `{ error: null }` -- which this
          // fake used to do -- made an update that matched nothing look exactly
          // like a successful close, which is the condition the route has to be
          // able to tell apart.
          update: (patch: Partial<Delivery>) => ({
            eq: (_c1: string, week: string) => ({
              eq: async (_c2: string, playerId: string) => {
                const existing = deliveries.get(dkey(week, playerId));
                if (existing) Object.assign(existing, patch);
                return { error: null, count: existing ? 1 : 0 };
              },
            }),
          }),
        };
      }
      if (table === 'season_final_ratings') {
        // Its own branch, and awaitable rather than resolving on .range(): the
        // route awaits this builder directly. Making the generic fallback below
        // awaitable instead would change the match_participants read that
        // shares it. The date comparison is the real one, string-wise on ISO
        // timestamps, so the boundary test actually exercises gte/lt.
        let lo = '';
        let hi = '';
        const q = {
          select: () => q,
          gte: (_c: string, v: string) => { lo = v; return q; },
          lt: (_c: string, v: string) => { hi = v; return q; },
          then: (resolve: (r: { count: number | null; error: unknown }) => unknown) =>
            Promise.resolve(
              rolloverReadError
                ? { count: null, error: { message: rolloverReadError } }
                : rolloverReadNulled
                  // How a head count really fails: no body, so no error either.
                  ? { count: null, error: null }
                  : { count: archivedAt.filter((a) => a >= lo && a < hi).length, error: null },
            ).then(resolve),
        };
        return q;
      }
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
  sendWeeklyDigestEmail.mockImplementation(async () => ({ sent: true, providerMessageId: 'msg-1' }));
  store = { value: null };
  deliveries = new Map();
  deliveryReadError = null;
  deliveryClaimError = null;
  matchRows = [];
  archivedAt = [];
  rolloverReadError = null;
  rolloverReadNulled = false;
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
    sendWeeklyDigestEmail.mockImplementation(
      async () => ({ sent: false, reason: 'opted_out' }) as never);

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

// F-019. The cursor was the ONLY thing standing between a member and a second
// copy of their week, and a cursor is a read-modify-write. These tests are
// about digest_deliveries (00194) — the per-recipient, per-window key — and
// every one of them is written so that it fails if the claim is removed and the
// cursor is left to do the job on its own.
describe('weekly-digest — the per-recipient claim, not the cursor', () => {
  it('two overlapping invocations never mail the same member twice', async () => {
    matchRows = Array.from({ length: 30 }, (_, i) => row(`p-${String(i).padStart(2, '0')}`));

    // Both start before either has written anything, which is exactly the
    // window the Monday */5 schedule and pg_net's retry make reachable: both
    // read the same cursor, both compute the same batch in the same id order.
    await Promise.all([run(), run()]);

    const all = recipients();
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(all).size).toBe(30);
  });

  it('cannot re-mail the week even if the cursor is lost entirely', async () => {
    matchRows = Array.from({ length: 10 }, (_, i) => row(`p-${String(i).padStart(2, '0')}`));
    await run();
    expect(recipients()).toHaveLength(10);

    // The worst case for a cursor: it is gone. Nothing about the members'
    // eligibility has changed, so a cursor-only design starts at the beginning
    // and mails all ten a second time.
    store = { value: null };
    sendWeeklyDigestEmail.mockClear();
    await run();

    expect(recipients()).toEqual([]);
  });

  it('refuses to send when the claim cannot be written', async () => {
    matchRows = [row('p-00'), row('p-01')];
    deliveryClaimError = 'connection reset';

    const res = await run();

    // Unclaimed sends are the failure this table exists to prevent. Failing the
    // run is the correct response, not sending anyway.
    expect(recipients()).toEqual([]);
    expect(res.status).toBe(500);
  });

  it('reports a close that matches no row, because a concurrent merge took the claim', async () => {
    const Sentry = await import('@sentry/nextjs');
    vi.mocked(Sentry.captureException).mockClear();
    matchRows = [row('p-00')];

    // A merge running at the same time as the digest. Before 00205 it could
    // cascade the claim away between the claim and the close; after 00205 it
    // can still REPOINT the row to the survivor, and either way this filter
    // matches nothing. The send has already happened at that point, so the
    // only thing left to get right is noticing.
    sendWeeklyDigestEmail.mockImplementation(async () => {
      deliveries.clear();
      return { sent: true, providerMessageId: 'msg-1' };
    });

    await run();

    // PostgREST calls an update that matched nothing a success. If this is not
    // reported, the run finishes clean while the member has been mailed and
    // nothing durable records it.
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Digest delivery close matched no row for p-00'),
      }),
    );
  });

  it('refuses to send when the delivery record cannot be read', async () => {
    matchRows = [row('p-00')];
    deliveryReadError = 'permission denied';

    const res = await run();

    // Same reasoning as readProgress: a failed read is indistinguishable from
    // "nobody has been mailed yet", and acting on that mails the club again.
    expect(recipients()).toEqual([]);
    expect(res.status).toBe(500);
  });

  it('records the outcome and the provider message id for each recipient', async () => {
    matchRows = [row('p-00')];
    await run();

    const rec = [...deliveries.values()][0]!;
    expect(rec).toMatchObject({ outcome: 'sent', provider_message_id: 'msg-1' });
    expect(rec.completed_at).not.toBeNull();
  });

  it('records a suppressed member as decided, so no later run retries them', async () => {
    matchRows = [row('p-00')];
    sendWeeklyDigestEmail.mockImplementation(
      async () => ({ sent: false, reason: 'suppressed' }) as never);

    await run();
    expect([...deliveries.values()][0]).toMatchObject({ outcome: 'suppressed' });

    // A member the provider was never asked about still counts as dealt with.
    sendWeeklyDigestEmail.mockClear();
    store = { value: null };
    await run();
    expect(recipients()).toEqual([]);
  });

  it('records a throw as failed and does not retry it', async () => {
    matchRows = [row('p-00')];
    sendWeeklyDigestEmail.mockImplementation(async () => { throw new Error('provider 500'); });

    await run();
    expect([...deliveries.values()][0]).toMatchObject({ outcome: 'failed' });

    // Deliberate, and the opposite of what the session-reminder job does: we
    // cannot tell a throw before the provider was called from one after it
    // accepted the message, and a duplicate club-wide mailing is unrecallable.
    sendWeeklyDigestEmail.mockClear();
    store = { value: null };
    await run();
    expect(recipients()).toEqual([]);
  });

  it('reports a claim an earlier invocation never closed', async () => {
    const Sentry = await import('@sentry/nextjs');
    matchRows = [row('p-00'), row('p-01')];
    // Claimed by a run that died before recording an outcome.
    deliveries.set('2026-08-17|p-00', {
      week_start: '2026-08-17', player_id: 'p-00',
      claimed_at: new Date(Date.now() - 60 * 60_000).toISOString(),
      completed_at: null, outcome: null, provider_message_id: null,
    });

    const res = await run();

    // Not re-sent — that is the trade this design makes — but not silent.
    expect(recipients()).toEqual(['p-01@sfu.ca']);
    expect((await res.json()).stranded_claims).toBe(1);
    expect(Sentry.captureMessage).toHaveBeenCalled();
  });
});

describe('weekly-digest — a finished week still reports what it stranded', () => {
  it('reports a stranded claim even once the week is marked complete', async () => {
    const Sentry = await import('@sentry/nextjs');
    matchRows = [row('p-00')];
    await run();

    // The week is complete, so every later POST short-circuits. If the sweep
    // sat after that gate, a crash in the run that FINISHED the week would be
    // the one case nothing ever reports.
    deliveries.set('2026-08-17|p-99', {
      week_start: '2026-08-17', player_id: 'p-99',
      claimed_at: new Date(Date.now() - 60 * 60_000).toISOString(),
      completed_at: null, outcome: null, provider_message_id: null,
    });
    vi.clearAllMocks();

    const res = await run();
    const body = await res.json();

    expect(body.already_complete).toBe(true);
    expect(body.stranded_claims).toBe(1);
    expect(Sentry.captureMessage).toHaveBeenCalled();
  });
});

// THE WEEK A SEASON ROLLS OVER, which is the one week these numbers can be
// wrong without anything failing. activate_season snapshots into
// season_final_ratings and, on a soft or full Elo policy, rewrites every live
// rating. A rewrite emits no rating_delta, so the net-Elo sum spans a rebase;
// and the post_rating stored against a match played before the rollover is a
// number the member no longer holds. The recap would state both, confidently.
//
// The window here is the Monday-to-Monday one every other test in this file
// runs in: 2026-08-10T00:00Z inclusive to 2026-08-17T00:00Z exclusive.
describe('weekly-digest: a season that rolled over mid-week', () => {
  const data = () =>
    (sendWeeklyDigestEmail.mock.calls[0] as unknown[])[2] as Record<string, unknown>;

  it('withholds both Elo figures, and only those', async () => {
    matchRows = [
      row('p-00', { matchType: 'singles', postRating: 1100, playedAt: '2026-08-11T00:00:00.000Z' }),
      row('p-00', { matchType: 'doubles', postRating: 900, playedAt: '2026-08-14T00:00:00.000Z' }),
    ];
    archivedAt = ['2026-08-13T08:00:00.000Z'];

    await run();

    expect(data().eloChange).toBeNull();
    expect(data().singlesRating).toBeNull();
    expect(data().doublesRating).toBeNull();
    // THE ASSERTION THAT MAKES THIS A SUPPRESSION AND NOT A MUTILATION. A
    // rebase does not un-play a match, so the count and the record survive it
    // intact and are still the member's. Clamping the digest window to
    // archived_at would have cut these three down to protect the two above.
    expect(data().matchesPlayed).toBe(2);
    expect(data().wins).toBe(2);
    expect(data().losses).toBe(0);
  });

  it('leaves an ordinary week alone', async () => {
    matchRows = [row('p-00', { postRating: 1100 })];
    archivedAt = [];

    await run();

    expect(data().eloChange).toBe(5);
    expect(data().singlesRating).toBe(1100);
  });

  it('does not suppress for an activation outside the window', async () => {
    matchRows = [row('p-00', { postRating: 1100 })];
    // One the day before the window opens, one exactly at the instant it
    // closes. `archived_at >= periodEnd` belongs to NEXT week's digest, and it
    // is the one a `.lte` would wrongly swallow into this one.
    archivedAt = ['2026-08-09T23:59:59.000Z', '2026-08-17T00:00:00.000Z'];

    await run();

    expect(data().eloChange).toBe(5);
    expect(data().singlesRating).toBe(1100);
  });

  it('withholds when it cannot tell, and still sends the recap', async () => {
    // supabase-js resolves a PostgREST 400/403 rather than throwing, so
    // `count ?? 0` would read a broken grant as "no season rolled over" and
    // mail the numbers anyway. A read that did not answer is not evidence.
    matchRows = [row('p-00', { postRating: 1100 })];
    rolloverReadError = 'permission denied for table season_final_ratings';

    const body = await (await run()).json();

    expect(data().eloChange).toBeNull();
    expect(data().singlesRating).toBeNull();
    // And the whole club's digest is not cancelled over a stat line.
    expect(body.sent).toBe(1);
    expect(data().matchesPlayed).toBe(1);
  });

  it('withholds for the way a head count ACTUALLY fails', async () => {
    // THE TEST ABOVE DOES NOT COVER THIS, and the original guard here only
    // checked `error`. A HEAD request has no body, so PostgREST's error
    // document never arrives and supabase-js resolves the failure as
    // { count: null, error: null, status: 204 }. Measured against this stack:
    // a head count on a missing table returns exactly that, while the same
    // read as a GET returns PGRST205.
    //
    // Through `count ?? 0` that becomes `0 > 0`, which is false, which mails
    // the numbers. This is the failure this detection is most likely to meet
    // and it is the one that defeats it silently.
    matchRows = [row('p-00', { postRating: 1100 })];
    rolloverReadNulled = true;

    const body = await (await run()).json();

    expect(data().eloChange).toBeNull();
    expect(data().singlesRating).toBeNull();
    expect(body.across_rollover).toBe(true);
    expect(body.sent).toBe(1);
  });

  it('reports the decision in the run summary', async () => {
    matchRows = [row('p-00')];
    archivedAt = ['2026-08-13T08:00:00.000Z'];

    const body = await (await run()).json();

    expect(body.across_rollover).toBe(true);
  });
});
