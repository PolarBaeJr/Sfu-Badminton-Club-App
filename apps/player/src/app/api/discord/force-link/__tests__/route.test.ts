import { describe, it, expect, vi, beforeEach } from 'vitest';

// POST /api/discord/force-link attaches a Discord account to a club member on an
// officer's word, with the member absent.
//
// THE GATE IS THE POINT OF THIS FILE. The service secret proves the request came
// from the bot and says nothing about who typed the command: every member's slash
// command arrives with the same bearer token. Discord's
// `default_member_permissions: '0'` is a command-list filter, not authorization.
// So the cases below are about the SECOND gate, the one that resolves the
// CALLER's own club account and asks it for players.discordlink.write.
//
// THE ORDERING IS PART OF THE GATE, and there is a case for it at the bottom.
// The handle is resolved AFTER the capability check, because this route reads
// players.handle directly rather than the ladder: reversed, `no_such_member`
// would be a handle-existence oracle for members the ladder deliberately hides,
// readable by anyone the service secret admits.
//
// WHAT THIS FILE CANNOT PROVE, stated so nobody mistakes a green run for it:
// PostgREST is mocked, so 00165's trigger never executes and the displaced
// account is never really tombstoned. That the write is ONE UPSERT conflicting
// on player_id, rather than a delete-then-insert or an ignoreDuplicates insert,
// is argued at the call site and is not testable in this repo. What is asserted
// here is the shape of the call: the conflict target and the null last_synced_at.

type Row = Record<string, unknown>;

const store = {
  players: [] as Row[],
  links: [] as Row[],
  audits: [] as Row[],
  linkError: null as { message: string } | null,
  playersError: null as { message: string } | null,
  auditError: null as { message: string } | null,
  /** Another officer won the snowflake between the pre-check and the write. */
  raceOnWrite: false,
  /** A write failure that is NOT the unique constraint. */
  writeError: null as { message: string } | null,
};

/** Every table the route touched, in order. The ordering case reads this. */
const fromCalls: string[] = [];
const upserts: { payload: Row; onConflict?: string }[] = [];

// A FILTER-AWARE AND SELECT-AWARE FAKE, and both halves are load-bearing.
//
// The route makes three DIFFERENT reads against player_discord_links: the caller
// by discord_user_id (with the players join), the conflicting owner by
// discord_user_id, and the member's current link by player_id. A fake that keyed
// only on the table name would answer all three with the same row, which would
// make the conflict pre-check see the caller's own link and refuse every single
// link as already_linked_elsewhere. So `eq` is recorded and applied.
//
// And `select` has to remember its argument: PostgREST nests an embedded row
// under the related table's name, and only when the select asked for it. Ignoring
// the column list would return a bare link row with no `.players`, the route
// would read that as an unresolvable caller, and every case here would collapse
// into not_linked.
function query(table: string) {
  fromCalls.push(table);
  const filters: Array<[string, unknown]> = [];
  let columns = '';
  let op: 'select' | 'insert' | 'upsert' = 'select';
  let payload: Row = {};
  let conflict: string | null = null;

  const rowsFor = (): Row[] =>
    table === 'players' ? store.players : table === 'player_discord_links' ? store.links : store.audits;

  const matching = () => rowsFor().filter((r) => filters.every(([c, v]) => r[c] === v));

  const readError = () =>
    table === 'player_discord_links'
      ? store.linkError
      : table === 'players'
        ? store.playersError
        : null;

  const write = (): { data: Row[] | null; error: { message: string; code?: string } | null } => {
    if (op === 'upsert') {
      // THE UNIQUE INDEX ON discord_user_id, enforced before anything is written
      // so a refusal leaves the table untouched. Shaped like a PostgREST error
      // rather than thrown, because supabase-js RESOLVES with { error } instead
      // of rejecting, and a route that forgot to read `error` has to fail here.
      const clash =
        store.raceOnWrite ||
        store.links.some(
          (r) =>
            r.discord_user_id === payload.discord_user_id && r.player_id !== payload.player_id
        );
      if (clash) {
        return {
          data: null,
          error: {
            code: '23505',
            message:
              'duplicate key value violates unique constraint "player_discord_links_discord_user_id_key"',
          },
        };
      }
      // A fault rather than a constraint: nothing an officer could act on.
      if (store.writeError) return { data: null, error: store.writeError };
      // ON CONFLICT (<column>) DO UPDATE: the matching row is replaced in place
      // rather than added beside, which is the whole difference between this and
      // an insert.
      const existing = conflict
        ? store.links.find((r) => r[conflict!] === payload[conflict!])
        : undefined;
      if (existing) Object.assign(existing, payload);
      else store.links.push({ ...payload });
      return { data: [payload], error: null };
    }
    if (store.auditError) return { data: null, error: store.auditError };
    store.audits.push({ ...payload });
    return { data: [payload], error: null };
  };

  const api = {
    select(cols?: string) {
      columns = cols ?? '';
      op = 'select';
      return api;
    },
    insert(p: Row) {
      op = 'insert';
      payload = p;
      return api;
    },
    upsert(p: Row, opts?: { onConflict?: string }) {
      op = 'upsert';
      payload = p;
      conflict = opts?.onConflict ?? null;
      upserts.push({ payload: p, onConflict: opts?.onConflict });
      return api;
    },
    eq(column: string, value: unknown) {
      filters.push([column, value]);
      return api;
    },
    async maybeSingle() {
      const error = readError();
      if (error) return { data: null, error };
      const hit = matching()[0];
      if (!hit) return { data: null, error: null };
      if (columns.includes('players!inner')) {
        const joined = store.players.find((p) => p.id === hit.player_id);
        return joined
          ? { data: { player_id: hit.player_id, players: { ...joined } }, error: null }
          : { data: null, error: null };
      }
      return { data: { ...hit }, error: null };
    },
    // The upsert and the audit insert are awaited directly, with no maybeSingle.
    then(resolve: (value: unknown) => unknown) {
      return Promise.resolve(write()).then(resolve);
    },
  };
  return api;
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({ from: (table: string) => query(table) }),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { POST } from '../route';

const CALLER_PLAYER_ID = 'p-caller';
const MEMBER_ID = 'p-member';
const OTHER_ID = 'p-other';

const CALLER = '111100000000000000';
const ARRIVING = '214300000000000000';
const OLD = '109900000000000000';
const OTHERS = '330000000000000000';

// AN ADMIN, because players.discordlink.write is admin-only: it is in no role's
// defaults and not in EXEC_BASELINE, so an unrestricted exec does not hold it.
// effectiveCapabilities short-circuits on the level for an admin, which is why
// this row needs no permission triple at all.
const ADMIN: Row = {
  id: CALLER_PLAYER_ID,
  full_name: 'The Admin',
  handle: 'theadmin',
  role: 'admin',
  is_exec: true,
  is_trainer: false,
  is_banned: false,
  status: 'competitive',
  active_flag: true,
  permission_role: null,
  permission_grants: null,
  permission_revokes: null,
};

/** An exec who was handed this one capability by name. */
const GRANTED_EXEC: Row = {
  ...ADMIN,
  role: 'member',
  permission_role: 'external',
  permission_grants: ['players.discordlink.write'],
  permission_revokes: [],
};

/** An exec nobody gave anything to. EXEC_BASELINE is read-everything/write-nothing. */
const PLAIN_EXEC: Row = {
  ...ADMIN,
  role: 'member',
  permission_role: null,
  permission_grants: null,
  permission_revokes: null,
};

function setCaller(row: Row) {
  store.players[0] = { ...row, id: CALLER_PLAYER_ID };
}

function post(body: unknown, auth = 'Bearer test-secret') {
  return new Request('http://localhost/api/discord/force-link', {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID = {
  discordUserId: CALLER,
  targetDiscordUserId: ARRIVING,
  handle: 'kiera',
  reason: 'they lost that account',
};

const linkFor = (playerId: string) => store.links.find((l) => l.player_id === playerId);
const lastAudit = () => store.audits.at(-1);

beforeEach(() => {
  vi.clearAllMocks();
  fromCalls.length = 0;
  upserts.length = 0;
  store.players = [
    { ...ADMIN },
    { id: MEMBER_ID, full_name: 'Kiera Tan', handle: 'kiera' },
    { id: OTHER_ID, full_name: 'Someone Else', handle: 'someone' },
  ];
  store.links = [
    { player_id: CALLER_PLAYER_ID, discord_user_id: CALLER, linked_at: 'x', last_synced_at: 'y' },
  ];
  store.audits = [];
  store.linkError = null;
  store.playersError = null;
  store.auditError = null;
  store.raceOnWrite = false;
  store.writeError = null;
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
});

describe('who may force a link', () => {
  it('refuses a request with the wrong service secret before reading anything', async () => {
    const response = await POST(post(VALID, 'Bearer wrong'));

    expect(response.status).toBe(401);
    expect(fromCalls).toEqual([]);
    expect(linkFor(MEMBER_ID)).toBeUndefined();
  });

  it('refuses an officer whose own Discord account is not connected', async () => {
    // The route resolves the CALLER by their Discord id, so an unlinked officer
    // has no club account for the capability check to ask about. This command can
    // never be the repair path for that.
    store.links = [];

    const response = await POST(post(VALID));

    expect(await response.json()).toEqual({ ok: false, refusal: 'not_linked' });
    expect(linkFor(MEMBER_ID)).toBeUndefined();
  });

  it('refuses an exec who was never given the write', async () => {
    setCaller(PLAIN_EXEC);

    const response = await POST(post(VALID));

    expect(await response.json()).toEqual({ ok: false, refusal: 'not_permitted' });
    expect(linkFor(MEMBER_ID)).toBeUndefined();
    expect(store.audits).toEqual([]);
  });

  it('refuses a banned admin, whose standing is checked before their level', async () => {
    setCaller({ ...ADMIN, is_banned: true });

    const response = await POST(post(VALID));

    expect(await response.json()).toEqual({ ok: false, refusal: 'not_permitted' });
    expect(linkFor(MEMBER_ID)).toBeUndefined();
  });

  it('lets an admin through', async () => {
    const response = await POST(post(VALID));

    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(payload.memberName).toBe('Kiera Tan');
    expect(linkFor(MEMBER_ID)!.discord_user_id).toBe(ARRIVING);
  });

  it('lets an exec holding the capability by an explicit grant through', async () => {
    setCaller(GRANTED_EXEC);

    const response = await POST(post(VALID));

    expect(((await response.json()) as Record<string, unknown>).ok).toBe(true);
    expect(linkFor(MEMBER_ID)!.discord_user_id).toBe(ARRIVING);
  });

  it('names a failed caller read instead of reading it as an unlinked officer', async () => {
    // A failed PostgREST read arrives as data:null with an error rather than
    // throwing. Reading that as "not linked" would tell an exec to run /link,
    // which they already have, with nothing anywhere naming the real fault.
    store.linkError = { message: 'permission denied for table player_discord_links' };

    const response = await POST(post(VALID));

    expect(response.status).toBe(503);
    expect(((await response.json()) as Record<string, unknown>).error).toBe('caller_unavailable');
    expect(linkFor(MEMBER_ID)).toBeUndefined();
  });

  // THE ORDERING CASE. The capability check sits above the handle lookup so that
  // a refused caller cannot use `no_such_member` to learn whether a handle
  // exists for a member the ladder hides.
  it('never looks a handle up for a caller without the capability', async () => {
    setCaller(PLAIN_EXEC);

    const response = await POST(post(VALID));

    expect(await response.json()).toEqual({ ok: false, refusal: 'not_permitted' });
    expect(fromCalls).not.toContain('players');
  });
});

describe('the request itself', () => {
  it('rejects a body that is not JSON', async () => {
    const response = await POST(
      new Request('http://localhost/api/discord/force-link', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
        body: 'not json',
      })
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as Record<string, unknown>).error).toBe('bad_request');
  });

  it('rejects an arriving id that is not a snowflake', async () => {
    // It arrives from a Discord USER option, so a malformed one means the bot
    // sent something wrong: a 400 for the bot rather than advice for the officer.
    const response = await POST(post({ ...VALID, targetDiscordUserId: 'matthew#1234' }));

    expect(response.status).toBe(400);
    expect(((await response.json()) as Record<string, unknown>).error).toBe('invalid_body');
    expect(linkFor(MEMBER_ID)).toBeUndefined();
  });

  it('requires a reason, and checks it before resolving the member', async () => {
    const response = await POST(post({ ...VALID, reason: '   ' }));

    expect(await response.json()).toEqual({ ok: false, refusal: 'no_reason' });
    expect(fromCalls).not.toContain('players');
    expect(linkFor(MEMBER_ID)).toBeUndefined();
  });
});

describe('resolving the member', () => {
  it('refuses a handle nobody has', async () => {
    const response = await POST(post({ ...VALID, handle: 'nobody' }));

    expect(await response.json()).toEqual({ ok: false, refusal: 'no_such_member' });
    expect(store.audits).toEqual([]);
  });

  it('accepts a leading @ and any capitals, as the profile card does', async () => {
    const response = await POST(post({ ...VALID, handle: '  @Kiera ' }));

    expect(((await response.json()) as Record<string, unknown>).ok).toBe(true);
    expect(linkFor(MEMBER_ID)!.discord_user_id).toBe(ARRIVING);
  });

  it('refuses a handle that could not exist without reading the table', async () => {
    // Bounded by the shared handle length first, so nothing outside
    // players_handle_shape_check's shape costs a query. The miss is the SAME code
    // a real absence gets: a caller cannot tell a refused shape from an absent
    // member.
    const response = await POST(post({ ...VALID, handle: 'ab' }));

    expect(await response.json()).toEqual({ ok: false, refusal: 'no_such_member' });
    expect(fromCalls).not.toContain('players');
  });

  it('names a failed member read instead of reporting no such member', async () => {
    store.playersError = { message: 'permission denied for table players' };

    const response = await POST(post(VALID));

    expect(response.status).toBe(503);
    expect(((await response.json()) as Record<string, unknown>).error).toBe('member_unavailable');
  });
});

describe('a snowflake that belongs to somebody else', () => {
  it('refuses it on the pre-check, and leaves the other member alone', async () => {
    store.links.push({ player_id: OTHER_ID, discord_user_id: OTHERS, last_synced_at: null });

    const response = await POST(post({ ...VALID, targetDiscordUserId: OTHERS }));

    expect(await response.json()).toEqual({ ok: false, refusal: 'already_linked_elsewhere' });
    expect(linkFor(MEMBER_ID)).toBeUndefined();
    expect(linkFor(OTHER_ID)!.discord_user_id).toBe(OTHERS);
    expect(store.audits).toEqual([]);
  });

  it('refuses it on the UNIQUE index when another officer wins the race', async () => {
    // The pre-check is for the message only. The index is the real guarantee, and
    // it is what holds when two officers pass the check in the same moment.
    store.raceOnWrite = true;

    const response = await POST(post(VALID));

    expect(await response.json()).toEqual({ ok: false, refusal: 'already_linked_elsewhere' });
    // No audit row for a write that did not happen.
    expect(store.audits).toEqual([]);
  });
});

describe('the write', () => {
  it('is one upsert conflicting on player_id, with last_synced_at cleared', async () => {
    // THE SHAPE IS LOAD-BEARING. 00165's trigger tombstones the displaced account
    // on an UPDATE only when the id actually moved, so the write has to be a
    // single upsert that updates in place. A plain insert would violate the
    // player_id primary key on a re-link; ignoreDuplicates would turn that into a
    // silent no-op reporting success. last_synced_at goes back to null so the bot
    // re-syncs from scratch rather than trusting a sync that happened to the old
    // account.
    await POST(post(VALID));

    expect(upserts.length).toBe(1);
    const upsert = upserts[0]!;
    expect(upsert.onConflict).toBe('player_id');
    expect(upsert.payload.player_id).toBe(MEMBER_ID);
    expect(upsert.payload.discord_user_id).toBe(ARRIVING);
    expect(upsert.payload.last_synced_at).toBe(null);
  });

  it('reports the account it displaced, and replaces the row rather than adding one', async () => {
    store.links.push({ player_id: MEMBER_ID, discord_user_id: OLD, last_synced_at: 'y' });

    const response = await POST(post(VALID));
    const payload = (await response.json()) as Record<string, unknown>;

    expect(payload.ok).toBe(true);
    expect(payload.displacedDiscordUserId).toBe(OLD);
    expect(store.links.filter((l) => l.player_id === MEMBER_ID).length).toBe(1);
    expect(linkFor(MEMBER_ID)!.discord_user_id).toBe(ARRIVING);
  });

  it('displaces nothing when the link already named that account', async () => {
    store.links.push({ player_id: MEMBER_ID, discord_user_id: ARRIVING, last_synced_at: 'y' });

    const payload = (await (await POST(post(VALID))).json()) as Record<string, unknown>;

    expect(payload.displacedDiscordUserId).toBe(null);
    expect(payload.alreadyThatAccount).toBe(true);
  });

  it('reports a failed write as a fault rather than a refusal', async () => {
    // A refusal is a 200 with a code because the app answered clearly. THIS is
    // the other direction: nothing is wrong with the request, something is wrong
    // with the app, and a named refusal here would tell an officer to fix
    // something they cannot see.
    store.writeError = { message: 'deadlock detected' };

    const response = await POST(post(VALID));

    expect(response.status).toBe(503);
    expect(((await response.json()) as Record<string, unknown>).error).toBe('force_link_failed');
    // No audit row for a write that did not land.
    expect(store.audits).toEqual([]);
  });
});

describe('the audit row', () => {
  it('files the act against the member, by the officer', async () => {
    await POST(post(VALID));

    const entry = lastAudit()!;
    expect(entry.action_type).toBe('discord_link_forced');
    expect(entry.actor_id).toBe(CALLER_PLAYER_ID);
    // The TARGET is the member, not the actor. This is why the row is written
    // inline rather than through logMemberAudit, which pins both to the actor.
    expect(entry.target_type).toBe('player');
    expect(entry.target_id).toBe(MEMBER_ID);
    expect(entry.reason).toContain('they lost that account');
  });

  it('records the displaced account in the reason, not only in old_value', async () => {
    // The tombstone naming it is deleted by the bot as soon as the sweep clears
    // it, and a degraded audit retry drops old_value/new_value, so the reason is
    // the one field that keeps it. The player app has no such retry at all, which
    // makes this the only copy.
    store.links.push({ player_id: MEMBER_ID, discord_user_id: OLD, last_synced_at: null });

    await POST(post(VALID));

    const entry = lastAudit()!;
    expect(entry.reason).toContain(OLD);
    expect((entry.old_value as Row).discord_user_id).toBe(OLD);
    expect((entry.new_value as Row).discord_user_id).toBe(ARRIVING);
  });

  it('still reports success when the audit insert is refused', async () => {
    // The link is already written. Losing the row that describes it must not also
    // lose the officer's reply, so the failure is reported to Sentry and the
    // request succeeds.
    store.auditError = { message: 'permission denied for table audit_logs' };

    const response = await POST(post(VALID));

    expect(response.status).toBe(200);
    expect(((await response.json()) as Record<string, unknown>).ok).toBe(true);
    expect(linkFor(MEMBER_ID)!.discord_user_id).toBe(ARRIVING);
  });
});
