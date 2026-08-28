// F-018. The reminder job's failure mode is a SILENT PERMANENT DROP: it claimed
// session_rsvp.reminded_at and then sent, so anything that threw in between
// left a row saying "reminded" for a player nobody reminded, with no trace to
// find it by. apps/bot/src/session-pings.ts does the same job for Discord and
// has always done it the other way round, with a comment explaining exactly
// this — the app was the outlier.
//
// 00186 splits the claim (reminder_attempted_at) from the receipt
// (reminded_at). These tests pin the three properties that split has to have:
// a crash leaves no receipt, a stale claim is retried, and two concurrent ticks
// still cannot both notify.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const remindSessionGoers = vi.fn();
vi.mock('@/lib/session-reminders', () => ({
  remindSessionGoers: (...a: unknown[]) => remindSessionGoers(...a),
}));

interface Rsvp {
  session_id: string;
  player_id: string;
  intent: string;
  reminded_at: string | null;
  reminder_attempted_at: string | null;
}

const SESSION_ID = 'sess-1';
let rsvps: Rsvp[];

// Start time far enough out that every player's lead has come due but the
// session has not begun — both gates the job applies before it claims anything.
const START = new Date(Date.now() + 30 * 60_000);
const pad = (n: number) => n.toString().padStart(2, '0');
const sessionRow = () => ({
  id: SESSION_ID,
  // The job converts these as CLUB-LOCAL wall clock, so build them from the
  // club-local rendering of START rather than from its UTC fields.
  ...(() => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(START);
    const get = (t: string) => parts.find((p) => p.type === t)!.value;
    return {
      date: `${get('year')}-${get('month')}-${get('day')}`,
      start_time: `${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}:00`,
    };
  })(),
  session_rsvp: rsvps.filter((r) => r.session_id === SESSION_ID),
});

vi.mock('@/lib/supabase-server', () => ({
  createAdminClient: () => ({
    from(table: string) {
      if (table === 'sessions') {
        const q: Record<string, unknown> = {};
        q.select = () => q;
        q.gte = () => q;
        q.lte = () => q;
        q.eq = () => Promise.resolve({ data: [sessionRow()], error: null });
        return q;
      }
      if (table === 'players') {
        // No stored preferences: every player takes the default lead.
        return {
          select: () => ({
            in: async (_c: string, ids: string[]) => ({
              data: ids.map((id) => ({ id, notification_preferences: {} })),
              error: null,
            }),
          }),
        };
      }
      if (table === 'session_rsvp') {
        return {
          update: (patch: Partial<Rsvp>) => {
            const preds: ((r: Rsvp) => boolean)[] = [];
            const q: Record<string, unknown> = {};
            q.eq = (c: keyof Rsvp, v: unknown) => { preds.push((r) => r[c] === v); return q; };
            q.in = (c: keyof Rsvp, v: unknown[]) => { preds.push((r) => v.includes(r[c])); return q; };
            q.is = (c: keyof Rsvp, v: null) => { preds.push((r) => r[c] === v); return q; };
            // `or('a.is.null,a.lt.<iso>')` — the crashed-claim predicate.
            q.or = (expr: string) => {
              const col = expr.split('.')[0] as keyof Rsvp;
              const cutoff = expr.split('.lt.')[1]!;
              preds.push((r) => r[col] === null || (r[col] as string) < cutoff);
              return q;
            };
            const apply = () => {
              const hit = rsvps.filter((r) => preds.every((p) => p(r)));
              for (const r of hit) Object.assign(r, patch);
              return hit;
            };
            q.select = () =>
              Promise.resolve({ data: apply().map((r) => ({ player_id: r.player_id })), error: null });
            // The receipt write has no .select(); it is awaited directly.
            q.then = (res: (v: unknown) => unknown) => {
              apply();
              return Promise.resolve({ error: null }).then(res);
            };
            return q;
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

const { POST } = await import('@/app/api/cron/session-reminders/route');

const SECRET = 'test-cron-secret';
const run = () =>
  POST(new Request('https://console.example/admin/api/cron/session-reminders', {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}` },
  }));

const rsvp = (player_id: string, over: Partial<Rsvp> = {}): Rsvp => ({
  session_id: SESSION_ID, player_id, intent: 'going',
  reminded_at: null, reminder_attempted_at: null, ...over,
});
const find = (id: string) => rsvps.find((r) => r.player_id === id)!;

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  rsvps = [rsvp('p1'), rsvp('p2')];
  remindSessionGoers.mockReset();
  remindSessionGoers.mockImplementation(async (_s: string, _a: null, ids: string[]) => ({
    notified: ids.length, delivered: ids,
  }));
  void pad;
});

describe('reminder claim and receipt (F-018)', () => {
  it('claims, sends, then writes the receipt', async () => {
    const res = await run();
    expect(res.status).toBe(200);

    expect(remindSessionGoers).toHaveBeenCalledTimes(1);
    expect(remindSessionGoers.mock.calls[0]![2]).toEqual(['p1', 'p2']);
    for (const id of ['p1', 'p2']) {
      expect(find(id).reminder_attempted_at).not.toBeNull();
      expect(find(id).reminded_at).not.toBeNull();
    }
  });

  it('leaves NO receipt when the send throws, so the player is still owed one', async () => {
    remindSessionGoers.mockRejectedValueOnce(new Error('push service down'));

    const res = await run();
    // The job as a whole reports the failure...
    expect(res.status).toBe(500);
    // ...and, crucially, nobody is marked reminded. Under the old scheme both
    // rows carried a reminded_at here and were never reminded again.
    expect(find('p1').reminded_at).toBeNull();
    expect(find('p2').reminded_at).toBeNull();
    // The claim IS stamped — that is what stops a concurrent tick double-sending.
    expect(find('p1').reminder_attempted_at).not.toBeNull();
  });

  it('retries a claim that never grew a receipt, once it is stale', async () => {
    // A tick 20 minutes ago claimed and died. Past the 15-minute window.
    const stale = new Date(Date.now() - 20 * 60_000).toISOString();
    rsvps = [rsvp('p1', { reminder_attempted_at: stale })];

    await run();

    expect(remindSessionGoers.mock.calls[0]![2]).toEqual(['p1']);
    expect(find('p1').reminded_at).not.toBeNull();
  });

  it('does not touch a claim that is still in flight', async () => {
    // Claimed one minute ago. Another tick is very likely mid-send.
    rsvps = [rsvp('p1', { reminder_attempted_at: new Date(Date.now() - 60_000).toISOString() })];

    const res = await run();

    expect(res.status).toBe(200);
    expect(remindSessionGoers).not.toHaveBeenCalled();
    expect(find('p1').reminded_at).toBeNull();
  });

  it('never re-reminds somebody who already has a receipt', async () => {
    rsvps = [rsvp('p1', { reminded_at: new Date().toISOString(), reminder_attempted_at: new Date(0).toISOString() })];

    await run();

    expect(remindSessionGoers).not.toHaveBeenCalled();
  });

  it('writes receipts only for the players delivery actually reached', async () => {
    // The in-app insert committed for p1 and not p2 — notifyPlayers reports
    // that now instead of returning the count it was asked for.
    remindSessionGoers.mockResolvedValueOnce({ notified: 1, delivered: ['p1'] });

    await run();

    expect(find('p1').reminded_at).not.toBeNull();
    expect(find('p2').reminded_at).toBeNull();
    // p2 keeps its claim, so it is retried once the window passes rather than
    // being dropped — the whole point of the split.
    expect(find('p2').reminder_attempted_at).not.toBeNull();
  });
});
