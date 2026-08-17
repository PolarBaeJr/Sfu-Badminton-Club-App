// The club-wide announcement path, at a roster size the club will actually
// reach. `filterPushRecipients` reads every recipient's preferences with a
// single `.in()`; PostgREST puts that in the query string and Kong refuses the
// request over 8,192 bytes, which is between 215 and 220 uuids. The read then
// fails closed — correctly, for a preference read — so push is withheld from
// EVERYONE while the in-app bell keeps working and nothing user-visible says
// so.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

const sendPushToPlayers = vi.fn().mockResolvedValue(undefined);
vi.mock('@badminton/shared/src/push/send', () => ({
  sendPushToPlayers: (...args: unknown[]) => sendPushToPlayers(...args),
}));

import * as Sentry from '@sentry/nextjs';
import { REQUEST_LINE_LIMIT_BYTES } from '@badminton/shared';
import { notifyPlayers } from '../notify';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/**
 * PostgREST plus the proxy in front of it: records each preference read's ids
 * and refuses any whose request line exceeds the measured limit, the way Kong
 * does with a 414.
 */
function makeGatewayMock(prefsById: Map<string, unknown>) {
  const requestLines: string[] = [];
  const inserted: unknown[][] = [];
  const from = vi.fn((table: string) => ({
    insert: async (rows: unknown[]) => {
      inserted.push(rows);
      return { error: null };
    },
    select: (columns: string) => ({
      in: async (column: string, ids: string[]) => {
        const line = `GET /rest/v1/${table}?select=${encodeURIComponent(columns)}&${column}=in.(${ids.join(',')}) HTTP/1.1`;
        requestLines.push(line);
        if (Buffer.byteLength(line) > REQUEST_LINE_LIMIT_BYTES) {
          return { data: null, error: { message: 'Request-URI Too Large' } };
        }
        return {
          data: ids.map((id) => ({ id, notification_preferences: prefsById.get(id) ?? {} })),
          error: null,
        };
      },
    }),
  }));
  return { client: { from } as never, requestLines, inserted };
}

const INPUT = { type: 'general' as never, title: 'Club announcement' };
const PUSH = { title: 'Club announcement', body: 'Read it' };

describe('notifyPlayers at roster scale', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendPushToPlayers.mockResolvedValue(undefined);
  });

  it('pushes to every opted-in member of a 300-person roster', async () => {
    const playerIds = Array.from({ length: 300 }, (_, i) => uuid(i));
    // Two thirds opted in; the rest must be filtered out, not merely survive.
    const prefs = new Map(playerIds.map((id, i) => [id, i % 3 === 0 ? {} : { announcements: true }]));
    const mock = makeGatewayMock(prefs);

    await notifyPlayers(mock.client, playerIds, INPUT, PUSH, 'announcements');

    for (const line of mock.requestLines) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(REQUEST_LINE_LIMIT_BYTES);
    }
    expect(sendPushToPlayers).toHaveBeenCalledTimes(1);
    const recipients = sendPushToPlayers.mock.calls[0]?.[1] as string[];
    expect(recipients).toHaveLength(200);
    expect(new Set(recipients).size).toBe(200);
    for (const id of recipients) expect(prefs.get(id)).toEqual({ announcements: true });
  });

  it('still fails CLOSED, for everyone, when a preference chunk errors', async () => {
    const playerIds = Array.from({ length: 300 }, (_, i) => uuid(i));
    const from = vi.fn(() => ({
      insert: async () => ({ error: null }),
      select: () => ({ in: async () => ({ data: null, error: { message: 'boom' } }) }),
    }));

    await notifyPlayers({ from } as never, playerIds, INPUT, PUSH, 'announcements');

    // NOT a partial send. A chunked read whose failed chunks come back as empty
    // arrays would push to the 200 that succeeded and silently drop 100 —
    // worse than today, because nothing would name the missing hundred.
    expect(sendPushToPlayers).not.toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('fails CLOSED when only ONE chunk of the preference read errors', async () => {
    // The hazard the helper is designed against, and the one the all-chunks
    // case above does not exercise: selectInChunks returns the rows it DID
    // collect alongside the error, so `notify.ts` is only correct because it
    // tests `error ||` before `!data`. Pins that ordering against a tidy-up.
    const playerIds = Array.from({ length: 300 }, (_, i) => uuid(i));
    let call = 0;
    const from = vi.fn(() => ({
      insert: async () => ({ error: null }),
      select: () => ({
        in: async (_column: string, ids: string[]) => {
          call += 1;
          return call === 2
            ? { data: null, error: { message: 'Request-URI Too Large' } }
            : {
                data: ids.map((id) => ({ id, notification_preferences: { announcements: true } })),
                error: null,
              };
        },
      }),
    }));

    await notifyPlayers({ from } as never, playerIds, INPUT, PUSH, 'announcements');

    expect(call).toBeGreaterThan(2); // more than one chunk really was read
    expect(sendPushToPlayers).not.toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('writes the in-app row for everyone regardless of push preferences', async () => {
    const playerIds = Array.from({ length: 300 }, (_, i) => uuid(i));
    const mock = makeGatewayMock(new Map());

    await notifyPlayers(mock.client, playerIds, INPUT, PUSH, 'announcements');

    expect(mock.inserted.flat()).toHaveLength(300);
  });
});
