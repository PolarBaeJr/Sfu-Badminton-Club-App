// Behaviour at scale for the push fan-out.
//
// These assert what a member experiences, not that a helper exists: with a
// 300-member roster every one of the 300 gets their push, no single request
// line goes over the proxy's 8 KB limit, and the sends do not all leave at
// once. Before the chunking fix the first two fail, because supabase-js puts
// `.in()` in the query string and Kong answers 414 above ~215 uuids.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import webpush from 'web-push';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendPushToPlayers } from '../push/send';
import { REQUEST_LINE_LIMIT_BYTES } from '../utils/query-chunks';

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn().mockResolvedValue(undefined),
  },
}));

// A uuid of the right SHAPE, because the whole bug is about how many bytes the
// ids occupy in the URL. A short synthetic id ("player-1") would keep every
// request line comfortably inside the limit and prove nothing.
function uuid(n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

/**
 * Stands in for the PostgREST client AND for Kong in front of it: it records
 * the id list of every `.in()`, rebuilds the request line those ids produce,
 * and refuses the request exactly as the proxy does above 8,192 bytes.
 *
 * That refusal is the point. A mock that always answers happily cannot tell a
 * chunked read from an unchunked one.
 */
function makeGatewayMock(subsByPlayer: Map<string, Array<{ id: string; endpoint: string }>>) {
  const requestLines: string[] = [];
  const rejected: string[] = [];

  const from = vi.fn((table: string) => ({
    select: (columns: string) => ({
      in: (column: string, ids: string[]) => {
        const line = `GET /rest/v1/${table}?select=${encodeURIComponent(columns)}&${column}=in.(${ids.join(',')})&active=eq.true HTTP/1.1`;
        requestLines.push(line);
        const tooLong = Buffer.byteLength(line) > REQUEST_LINE_LIMIT_BYTES;
        if (tooLong) rejected.push(line);
        return {
          eq: async () =>
            tooLong
              ? // What supabase-js surfaces for a 414: Kong's HTML-ish body
                // fails to parse as PostgREST JSON, so it arrives as an error.
                { data: null, error: { message: 'Request-URI Too Large' } }
              : { data: ids.flatMap((id) => subsByPlayer.get(id) ?? []), error: null },
        };
      },
    }),
    update: () => ({ eq: async () => ({ data: null, error: null }) }),
  }));

  return { client: { from } as unknown as SupabaseClient, requestLines, rejected };
}

function rosterOf(size: number) {
  const playerIds = Array.from({ length: size }, (_, i) => uuid(i));
  const subsByPlayer = new Map(
    playerIds.map((id) => [
      id,
      [{ id: `sub-${id}`, endpoint: `https://push.example/${id}`, p256dh_key: 'p', auth_key: 'a' }],
    ]),
  );
  return { playerIds, subsByPlayer };
}

describe('push fan-out at roster scale', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(webpush.sendNotification).mockReset().mockResolvedValue(undefined as never);
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'test-public-key');
    vi.stubEnv('VAPID_PRIVATE_KEY', 'test-private-key');
    vi.stubEnv('VAPID_EMAIL', 'push@example.com');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('delivers to all 300 recipients', async () => {
    const { playerIds, subsByPlayer } = rosterOf(300);
    const mock = makeGatewayMock(subsByPlayer as never);

    await sendPushToPlayers(mock.client, playerIds, { title: 'T', body: 'B' });

    expect(mock.rejected).toEqual([]);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(300);
    const reached = new Set(
      vi.mocked(webpush.sendNotification).mock.calls.map(
        (c) => (c[0] as { endpoint: string }).endpoint,
      ),
    );
    for (const id of playerIds) expect(reached.has(`https://push.example/${id}`)).toBe(true);
  });

  it('keeps every request line inside the proxy limit for a 1,000-member club', async () => {
    const { playerIds, subsByPlayer } = rosterOf(1000);
    const mock = makeGatewayMock(subsByPlayer as never);

    await sendPushToPlayers(mock.client, playerIds, { title: 'T', body: 'B' });

    expect(mock.requestLines.length).toBeGreaterThan(1);
    for (const line of mock.requestLines) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(REQUEST_LINE_LIMIT_BYTES);
    }
    // Every id asked about exactly once — chunking must not drop or duplicate.
    const asked = mock.requestLines.flatMap(
      (line) => line.match(/player_id=in\.\(([^)]*)\)/)?.[1]?.split(',') ?? [],
    );
    expect(asked.sort()).toEqual([...playerIds].sort());
  });

  it('bounds how many pushes are in flight at once', async () => {
    const { playerIds, subsByPlayer } = rosterOf(300);
    const mock = makeGatewayMock(subsByPlayer as never);

    let inFlight = 0;
    let peak = 0;
    vi.mocked(webpush.sendNotification).mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 0));
      inFlight -= 1;
      return undefined as never;
    });

    await sendPushToPlayers(mock.client, playerIds, { title: 'T', body: 'B' });

    // 300 simultaneous TLS handshakes plus 300 ECDSA signings is the socket
    // storm the roster fix would otherwise uncork on the Pi.
    expect(peak).toBeLessThanOrEqual(20);
    expect(peak).toBeGreaterThan(1); // still parallel, not serialised
    expect(webpush.sendNotification).toHaveBeenCalledTimes(300);
  });

  it('finishes the batch when one endpoint fails, and still reports the failure', async () => {
    // Bounding the concurrency made this a real question. Unbounded, every send
    // was already in flight before any could reject; bounded, a throw out of
    // the task would stop the pool and silently drop everyone after the bad
    // endpoint — reported as one Sentry event that looks exactly like the old
    // one. A flaky push service must cost one message, not the rest of the run.
    const { playerIds, subsByPlayer } = rosterOf(300);
    const mock = makeGatewayMock(subsByPlayer as never);
    const bad = `https://push.example/${uuid(5)}`;

    vi.mocked(webpush.sendNotification).mockImplementation(async (sub) => {
      if ((sub as { endpoint: string }).endpoint === bad) {
        throw Object.assign(new Error('Too Many Requests'), { statusCode: 429 });
      }
      return undefined as never;
    });

    await expect(
      sendPushToPlayers(mock.client, playerIds, { title: 'T', body: 'B' }),
    ).rejects.toThrow('Too Many Requests');
    expect(webpush.sendNotification).toHaveBeenCalledTimes(300);
  });

  it('still fails loudly when a chunk is refused', async () => {
    const { playerIds } = rosterOf(300);
    // No subscriptions map entry means the mock answers rows for nobody; force
    // a real read error on the first chunk instead.
    const from = vi.fn(() => ({
      select: () => ({
        in: () => ({ eq: async () => ({ data: null, error: { message: 'boom' } }) }),
      }),
    }));

    await expect(
      sendPushToPlayers({ from } as unknown as SupabaseClient, playerIds, { title: 'T', body: 'B' }),
    ).rejects.toThrow('Failed to load push subscriptions: boom');
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });
});
