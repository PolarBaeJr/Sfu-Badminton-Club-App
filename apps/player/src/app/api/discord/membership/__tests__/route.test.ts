import { describe, it, expect, vi, beforeEach } from 'vitest';

// POST /api/discord/membership — the one route in this app that lets Discord
// decide something about a player row.
//
// WHAT THESE TESTS ARE FOR. The route's whole justification is that it writes
// exactly one column for exactly the members who linked their account, so the
// cases worth pinning are the refusals rather than the happy path:
//
//   - an unlinked Discord id writes nothing and is reported skipped, because a
//     server is mostly people who never linked and that is not an error;
//   - a value that is not one of the three memberships is a 400, not a write;
//   - nothing but membership_type is ever in the update, which is what keeps
//     "members pick their own membership" from becoming "members pick their own
//     status";
//   - a change writes an audit row naming Discord, because a self-set fee tier
//     an exec cannot see is the failure mode this route has to avoid.

interface Link {
  discord_user_id: string;
  player_id: string;
  players: { id: string; membership_type: string | null } | null;
}

let links: Link[] = [];
let linkError: { message: string } | null = null;
let updateError: { message: string } | null = null;

const updated = vi.fn();
const inserted = vi.fn();

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === 'player_discord_links') {
        return {
          select: () => ({
            in: (_column: string, ids: string[]) =>
              Promise.resolve({
                data: linkError ? null : links.filter((l) => ids.includes(l.discord_user_id)),
                error: linkError,
              }),
          }),
        };
      }
      if (table === 'players') {
        return {
          update: (row: unknown) => ({
            eq: (_column: string, id: string) => {
              updated(row, id);
              return Promise.resolve({ error: updateError });
            },
          }),
        };
      }
      // audit_logs
      return {
        insert: (row: unknown) => {
          inserted(table, row);
          return Promise.resolve({ error: null });
        },
      };
    },
  }),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { POST } from '../route';

function post(body: unknown, auth = 'Bearer test-secret') {
  return new Request('http://localhost/api/discord/membership', {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
  linkError = null;
  updateError = null;
  links = [
    { discord_user_id: '42', player_id: 'p1', players: { id: 'p1', membership_type: 'external' } },
  ];
});

describe('the gate', () => {
  it('refuses a request without the service secret', async () => {
    const res = await POST(post({ discordUserId: '42', membershipType: 'internal' }, 'Bearer no'));
    expect(res.status).toBe(401);
    expect(updated).not.toHaveBeenCalled();
  });

  it('refuses a membership that is not one of the three', async () => {
    const res = await POST(post({ discordUserId: '42', membershipType: 'admin' }));
    expect(res.status).toBe(400);
    expect(updated).not.toHaveBeenCalled();
  });

  it('refuses a body with no member in it', async () => {
    expect((await POST(post({ updates: [] }))).status).toBe(400);
    expect((await POST(post({}))).status).toBe(400);
  });
});

describe('writing what the member picked', () => {
  it('updates the linked player and says so', async () => {
    const res = await POST(post({ discordUserId: '42', membershipType: 'internal' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ updated: 1, unchanged: 0, skipped: 0, failed: 0 });
    expect(updated).toHaveBeenCalledWith({ membership_type: 'internal' }, 'p1');
  });

  it('writes NOTHING but membership_type', async () => {
    // The line between "members pick their membership" and "members pick their
    // privileges". Asserted on the update payload itself, not on a comment.
    await POST(post({ discordUserId: '42', membershipType: 'alumni' }));
    const [row] = updated.mock.calls[0] as [Record<string, unknown>, string];
    expect(Object.keys(row)).toEqual(['membership_type']);
  });

  it('records an audit row naming Discord as the source', async () => {
    await POST(post({ discordUserId: '42', membershipType: 'internal' }));
    const audit = inserted.mock.calls.find(([table]) => table === 'audit_logs');
    expect(audit?.[1]).toMatchObject({
      actor_id: 'p1',
      target_id: 'p1',
      old_value: { membership_type: 'external' },
      new_value: { membership_type: 'internal' },
    });
    expect((audit?.[1] as { reason: string }).reason).toMatch(/discord/i);
  });

  it('does nothing at all when the app already agrees', async () => {
    const res = await POST(post({ discordUserId: '42', membershipType: 'external' }));
    expect(await res.json()).toMatchObject({ updated: 0, unchanged: 1 });
    expect(updated).not.toHaveBeenCalled();
    expect(inserted).not.toHaveBeenCalled();
  });

  it('treats a null membership_type as internal rather than a change', async () => {
    // The column's own default, and the fallback every read in the app uses.
    // Without it a row that predates the column would be "changed" to internal
    // on every sweep, writing one audit entry a night for a value that never
    // moved.
    links = [
      { discord_user_id: '42', player_id: 'p1', players: { id: 'p1', membership_type: null } },
    ];
    const res = await POST(post({ discordUserId: '42', membershipType: 'internal' }));
    expect(await res.json()).toMatchObject({ updated: 0, unchanged: 1 });
    expect(updated).not.toHaveBeenCalled();
  });
});

describe('the members it must leave alone', () => {
  it('skips a Discord account that never linked', async () => {
    const res = await POST(post({ discordUserId: '999', membershipType: 'internal' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ updated: 0, skipped: 1 });
    expect(updated).not.toHaveBeenCalled();
  });

  it('carries on with the rest of a batch when one member fails', async () => {
    links = [
      { discord_user_id: '42', player_id: 'p1', players: { id: 'p1', membership_type: 'external' } },
      { discord_user_id: '43', player_id: 'p2', players: { id: 'p2', membership_type: 'internal' } },
    ];
    updateError = { message: 'row locked' };
    const res = await POST(
      post({
        updates: [
          { discordUserId: '42', membershipType: 'internal' },
          { discordUserId: '43', membershipType: 'alumni' },
          { discordUserId: '999', membershipType: 'alumni' },
        ],
      })
    );
    expect(await res.json()).toMatchObject({ updated: 0, failed: 2, skipped: 1 });
  });

  it('names a failed link read instead of reporting everyone skipped', async () => {
    // A failed PostgREST read arrives as data: null with an error. Degrading it
    // to an empty list would look like a clean sweep over nobody.
    linkError = { message: 'relation does not exist' };
    const res = await POST(post({ discordUserId: '42', membershipType: 'internal' }));
    expect(res.status).toBe(503);
    expect(updated).not.toHaveBeenCalled();
  });
});
