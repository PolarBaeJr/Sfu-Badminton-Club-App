import { describe, it, expect, vi, beforeEach } from 'vitest';

// POST /api/discord/announce writes something every member of the club reads.
//
// THE GATE IS THE POINT OF THIS FILE. The service secret proves the request came
// from the bot and says nothing about who typed the command -- every member's
// /announce arrives with the same bearer token. Discord's
// `default_member_permissions: '0'` is a command-list filter, not authorization:
// a server admin can grant the command to a role, and a second guild carries no
// filter at all. So the tests below are about the SECOND gate, the one that asks
// the caller's own club account for announcements.create.write.
//
// The other half is what the route deliberately does NOT do. It notifies nobody,
// and it writes send_push FALSE explicitly rather than leaving the column's own
// DEFAULT TRUE standing -- the console's list renders "pushed" off that column,
// and a true there would be a claim about a push that never happened.

interface Row {
  id: string;
  role?: string | null;
  is_exec?: boolean | null;
  is_trainer?: boolean | null;
  is_banned?: boolean | null;
  status?: string | null;
  active_flag?: boolean | null;
  permission_role?: string | null;
  permission_grants?: string[] | null;
  permission_revokes?: string[] | null;
}

let linkedPlayer: Row | null = null;
let linkError: { message: string } | null = null;
let activeSeasonId: string | null = 'season-1';
let seasonError: { message: string } | null = null;
let insertError: { message: string } | null = null;

const inserted = vi.fn();

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === 'player_discord_links') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: linkError ? null : linkedPlayer ? { players: linkedPlayer } : null,
                  error: linkError,
                }),
            }),
          }),
        };
      }
      if (table === 'seasons') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: seasonError ? null : activeSeasonId ? { id: activeSeasonId } : null,
                  error: seasonError,
                }),
            }),
          }),
        };
      }
      // announcements and audit_logs
      return {
        insert: (row: unknown) => {
          inserted(table, row);
          return {
            select: () => ({
              single: () =>
                Promise.resolve({
                  data: insertError ? null : { id: 'ann-1' },
                  error: insertError,
                }),
            }),
            // audit_logs awaits the insert directly, with no .select().
            then: (resolve: (value: { error: null }) => unknown) => resolve({ error: null }),
          };
        },
      };
    },
  }),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { POST } from '../route';

// VP EXTERNAL -- the officer whose job this actually is.
//
// NOT a bare is_exec, and the difference is the club's own rule rather than a
// detail of the fixture: EXEC_BASELINE is read-everything/write-nothing, so an
// unassigned exec holds announcements.page and none of the writes. Writes
// arrive by assignment. The `refuses an exec who was never given the write`
// case below is that rule, asserted.
const EXEC: Row = {
  id: 'p1',
  role: 'member',
  is_exec: true,
  is_trainer: false,
  is_banned: false,
  status: 'competitive',
  active_flag: true,
  permission_role: 'external',
  permission_grants: [],
  permission_revokes: [],
};

function post(body: unknown, auth = 'Bearer test-secret') {
  return new Request('http://localhost/api/discord/announce', {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID = {
  discordUserId: '424242',
  title: 'Sunday session moved',
  body: 'We are in Gym B this week.',
  type: 'info',
  pin: false,
  draft: false,
  evergreen: false,
};

/** What was written to `announcements`, or null if nothing was. */
function announcementWritten(): Record<string, unknown> | null {
  const call = inserted.mock.calls.find(([table]) => table === 'announcements');
  return call ? (call[1] as Record<string, unknown>) : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  linkedPlayer = EXEC;
  linkError = null;
  activeSeasonId = 'season-1';
  seasonError = null;
  insertError = null;
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
});

describe('who may announce', () => {
  it('refuses a Discord account with no club account, and writes nothing', async () => {
    linkedPlayer = null;

    const response = await POST(post(VALID));

    expect(await response.json()).toEqual({ ok: false, refusal: 'not_linked' });
    expect(announcementWritten()).toBeNull();
  });

  it('refuses an ordinary member holding the service secret', async () => {
    // THE ONE THIS FILE EXISTS FOR. A member who is somehow able to run the
    // command reaches this route with exactly the same bearer token an exec
    // does. Discord's command-list filter is not the authorization.
    linkedPlayer = {
      ...EXEC,
      is_exec: false,
      is_trainer: false,
      role: 'member',
      permission_role: null,
      permission_grants: null,
      permission_revokes: null,
    };

    const response = await POST(post(VALID));

    expect(await response.json()).toEqual({ ok: false, refusal: 'not_permitted' });
    expect(announcementWritten()).toBeNull();
  });

  it('refuses a banned exec, whose standing is checked before their level', async () => {
    linkedPlayer = { ...EXEC, is_banned: true };

    const response = await POST(post(VALID));

    expect(await response.json()).toEqual({ ok: false, refusal: 'not_permitted' });
    expect(announcementWritten()).toBeNull();
  });

  it('refuses a suspended exec', async () => {
    linkedPlayer = { ...EXEC, status: 'suspended' };

    const response = await POST(post(VALID));

    expect(await response.json()).toEqual({ ok: false, refusal: 'not_permitted' });
    expect(announcementWritten()).toBeNull();
  });

  it('refuses an exec whose composed permissions revoke the capability', async () => {
    // A narrowed officer -- the club's per-portfolio model. The CAPABILITY, not
    // the is_exec flag, is what this route asks for, and the two disagree the
    // moment somebody is given a job.
    linkedPlayer = {
      ...EXEC,
      permission_revokes: ['announcements.create.write'],
    };

    const response = await POST(post(VALID));

    expect(await response.json()).toEqual({ ok: false, refusal: 'not_permitted' });
    expect(announcementWritten()).toBeNull();
  });

  it('refuses an exec who was never given the write', async () => {
    // EXEC_BASELINE is read-everything/write-nothing on the club owner's
    // instruction: an unassigned officer can open the announcements page and
    // change nothing on it. Refusing them here is what makes /announce the
    // same authority as the console's composer rather than a way around it.
    linkedPlayer = { ...EXEC, permission_role: null, permission_grants: null, permission_revokes: null };

    const response = await POST(post(VALID));

    expect(await response.json()).toEqual({ ok: false, refusal: 'not_permitted' });
    expect(announcementWritten()).toBeNull();
  });

  it('lets the officer whose job it is through', async () => {
    const response = await POST(post(VALID));

    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(payload.status).toBe('published');
    expect(announcementWritten()).not.toBeNull();
  });

  it('refuses a request with the wrong service secret before reading anything', async () => {
    const response = await POST(post(VALID, 'Bearer wrong'));

    expect(response.status).toBe(401);
    expect(announcementWritten()).toBeNull();
  });

  it('names a failed link read instead of reading it as an unlinked caller', async () => {
    // A failed PostgREST read arrives as data:null with an error rather than
    // throwing. Reading that as "not linked" would tell an exec to run /link,
    // which they already have -- and which would then refuse them as already
    // linked, with nothing anywhere naming the real fault.
    linkError = { message: 'permission denied for table player_discord_links' };

    const response = await POST(post(VALID));

    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe('caller_unavailable');
    expect(announcementWritten()).toBeNull();
  });
});

describe('what gets written', () => {
  it('never pushes, and says so in the column rather than leaving the default', async () => {
    // send_push DEFAULTs TRUE in 00001. Nothing reads it on this path -- the
    // fan-out lives in the console's publish action -- but the console's list
    // renders "pushed" off this column, so a default true would be a lasting
    // claim about a notification that was never sent.
    await POST(post(VALID));

    expect(announcementWritten()?.send_push).toBe(false);
  });

  it('is always addressed to everyone', async () => {
    // A narrower audience is skipped by the relay as `narrow_audience`, and
    // this path sends no notification either -- so it would reach no channel
    // and nobody's bell, existing only for someone who opened the page. The
    // command offers no audience option; this is the assertion that keeps the
    // route honest if one is ever added.
    await POST(post(VALID));

    expect(announcementWritten()?.target_audience).toBe('all');
  });

  it('publishes by default and drafts when asked', async () => {
    await POST(post(VALID));
    expect(announcementWritten()?.status).toBe('published');

    vi.clearAllMocks();
    const response = await POST(post({ ...VALID, draft: true }));
    expect(announcementWritten()?.status).toBe('draft');
    expect((await response.json()).status).toBe('draft');
  });

  it('files a term announcement against the active season', async () => {
    await POST(post(VALID));

    expect(announcementWritten()?.season_id).toBe('season-1');
    expect(announcementWritten()?.all_seasons).toBe(false);
  });

  it('files an evergreen one against no season at all', async () => {
    // 00085's CHECK allows exactly two shapes, and this is the second.
    await POST(post({ ...VALID, evergreen: true }));

    expect(announcementWritten()?.season_id).toBeNull();
    expect(announcementWritten()?.all_seasons).toBe(true);
  });

  it('refuses a term announcement between seasons, by name', async () => {
    // REACHABLE, not hypothetical: there is no active season between terms. A
    // throw here would be a 500 the bot renders as "couldn't reach the club
    // app", sending an exec after a network fault over a rule the app is
    // enforcing on purpose.
    activeSeasonId = null;

    const response = await POST(post(VALID));

    expect(await response.json()).toEqual({ ok: false, refusal: 'no_active_season' });
    expect(announcementWritten()).toBeNull();
  });

  it('does not consult a season at all for an evergreen announcement', async () => {
    activeSeasonId = null;

    const response = await POST(post({ ...VALID, evergreen: true }));

    expect((await response.json()).ok).toBe(true);
  });

  it('credits the linked player as the author', async () => {
    await POST(post(VALID));

    expect(announcementWritten()?.author_id).toBe('p1');
  });

  it('falls back to info for a type it does not recognise', async () => {
    await POST(post({ ...VALID, type: 'catastrophic' }));

    expect(announcementWritten()?.type).toBe('info');
  });

  it('refuses an announcement with no words', async () => {
    const response = await POST(post({ ...VALID, body: '   ' }));

    expect(response.status).toBe(400);
    expect(announcementWritten()).toBeNull();
  });

  it('audits the announcement against the announcement, not the author', async () => {
    // logMemberAudit pins target_type to 'player' and the target to the actor,
    // which is why this row is written directly. The console audits the same
    // act under the same action_type.
    await POST(post(VALID));

    const audit = inserted.mock.calls.find(([table]) => table === 'audit_logs');
    expect(audit?.[1]).toMatchObject({
      actor_id: 'p1',
      action_type: 'announcement_created',
      target_type: 'announcement',
      target_id: 'ann-1',
    });
  });

  it('reports a failed insert rather than claiming it posted', async () => {
    insertError = { message: 'deadlock detected' };

    const response = await POST(post(VALID));

    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe('announce_failed');
  });
});
