import { describe, it, expect, vi, beforeEach } from 'vitest';

// The state row the self-updating session board keeps, and the two things this
// route exists to make structurally true.
//
// FIRST, IT STORES NO PAGE. The public board is always page 1 and its totals are
// recomputed every tick, so a stored page would be a value the tick and a reader
// disagree about. A convention would drift; a 400 cannot.
//
// SECOND, A FAILED READ IS NEVER AN EMPTY ANSWER. The tick reads "no channel" as
// "the club took the board down" and deletes the message, so a read fault that
// degraded to null would retract a working board and then repost it, five
// minutes at a time.

let rows: { key: string; value: string | null }[] = [];
let readError: { message: string } | null = null;
const upserted = vi.fn();
const deletedEq = vi.fn();

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      select: () => ({
        in: () => Promise.resolve({ data: readError ? null : rows, error: readError }),
      }),
      upsert: (row: unknown) => {
        upserted(row);
        return Promise.resolve({ error: null });
      },
      delete: () => ({
        eq: (column: string, value: unknown) => {
          deletedEq(column, value);
          return Promise.resolve({ error: null });
        },
      }),
    }),
  }),
}));

import { GET, POST } from '../route';

const CHANNEL = '123456789012345678';
const MESSAGE = '234567890123456789';

const STATE = {
  channelId: CHANNEL,
  messageId: MESSAGE,
  pending: false,
  fingerprint: 'a1b2c3d4e5f60718',
  postedAt: '2026-09-10T00:00:00.000Z',
  reposts: 1,
  repostWindowStart: '2026-09-09T00:00:00.000Z',
};

function post(body: unknown, auth = 'Bearer test-secret') {
  return new Request('http://localhost/api/discord/session-board', {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function get(auth = 'Bearer test-secret') {
  return new Request('http://localhost/api/discord/session-board', {
    headers: { authorization: auth },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  readError = null;
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
});

describe('GET /api/discord/session-board', () => {
  it('refuses without the service secret', async () => {
    expect((await GET(get('Bearer wrong'))).status).toBe(401);
  });

  it('answers the configured channel and the stored state together', async () => {
    rows = [
      { key: 'session_board_channel_id', value: CHANNEL },
      { key: 'session_board_state', value: JSON.stringify(STATE) },
    ];

    expect(await (await GET(get())).json()).toEqual({ channelId: CHANNEL, state: STATE });
  });

  it('reports no board when the club has never set one', async () => {
    expect(await (await GET(get())).json()).toEqual({ channelId: null, state: null });
  });

  it('NAMES a failed read rather than answering "no board"', async () => {
    readError = { message: 'relation does not exist' };
    const response = await GET(get());

    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe('session_board_unavailable');
  });

  it('NAMES a state row it cannot parse rather than answering "no board"', async () => {
    // Same consequence as a failed read: the tick would delete the message this
    // row describes and lose the repost counters with it.
    rows = [{ key: 'session_board_state', value: '{not json' }];
    const response = await GET(get());

    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe('session_board_state_unreadable');
  });

  it('NAMES a state row that parses but does not validate', async () => {
    rows = [{ key: 'session_board_state', value: JSON.stringify({ ...STATE, reposts: -4 }) }];
    expect((await GET(get())).status).toBe(503);
  });
});

describe('POST /api/discord/session-board', () => {
  it('refuses without the service secret', async () => {
    expect((await POST(post({ state: null }, 'Bearer wrong'))).status).toBe(401);
  });

  it('writes the whole state as one row', async () => {
    const response = await POST(post({ state: STATE }));

    expect(response.status).toBe(200);
    expect(upserted).toHaveBeenCalledWith({
      key: 'session_board_state',
      value: JSON.stringify(STATE),
    });
  });

  it('REFUSES A FIELD IT DOES NOT KNOW, and writes nothing', async () => {
    // Named `page` on purpose. This is the assertion that makes "the board
    // stores no page state" a property of the system rather than a habit.
    const response = await POST(post({ state: { ...STATE, page: 2 } }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'unknown_field',
      detail: 'unknown field page',
    });
    expect(upserted).not.toHaveBeenCalled();
  });

  it('refuses an id that is not a snowflake', async () => {
    const response = await POST(post({ state: { ...STATE, messageId: 'nope' } }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('invalid_state');
    expect(upserted).not.toHaveBeenCalled();
  });

  it('refuses a negative repost count', async () => {
    expect((await POST(post({ state: { ...STATE, reposts: -1 } }))).status).toBe(400);
  });

  it('refuses a timestamp that is not one', async () => {
    expect((await POST(post({ state: { ...STATE, postedAt: 'soon' } }))).status).toBe(400);
  });

  it('refuses a fingerprint that is not hex', async () => {
    expect((await POST(post({ state: { ...STATE, fingerprint: 'ZZZZZZZZ' } }))).status).toBe(400);
  });

  it('accepts the shape of a board that has been started but not confirmed', async () => {
    const pending = { ...STATE, messageId: null, pending: true, fingerprint: null };
    expect((await POST(post({ state: pending }))).status).toBe(200);
  });

  it('deletes the row on a null state, and only that key', async () => {
    const response = await POST(post({ state: null }));

    expect(response.status).toBe(200);
    expect(deletedEq).toHaveBeenCalledWith('key', 'session_board_state');
    expect(upserted).not.toHaveBeenCalled();
  });

  it('refuses a body with no state field at all', async () => {
    const response = await POST(post({}));
    expect(response.status).toBe(400);
    expect(upserted).not.toHaveBeenCalled();
    expect(deletedEq).not.toHaveBeenCalled();
  });
});
