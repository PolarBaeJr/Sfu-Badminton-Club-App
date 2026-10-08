import { describe, it, expect, vi, beforeEach } from 'vitest';

// POST /api/discord/force-unlink disconnects ANOTHER member's Discord account on
// an officer's word.
//
// THE GATE IS THE POINT OF THIS FILE. The service secret proves the request came
// from the bot and says nothing about who typed the command: every member's slash
// command arrives with the same bearer token, and Discord's
// `default_member_permissions: '0'` is a command-list filter rather than
// authorization. So the cases below are about the SECOND gate, the one that
// resolves the CALLER's own club account and asks it for
// players.discordlink.write.
//
// WHY THIS ROUTE EXISTS AT ALL rather than a parameter on the caller-only DELETE
// at api/discord/link: that route has no capability check, on the argument its
// own comment makes, that there is no parameter there which could name another
// member. Adding one would convert it into unlink-anyone behind nothing but the
// service secret.
//
// THE ORDER OF THE TWO WRITES IS THE SAFETY ARGUMENT, and there is a case for it
// below. The target's player_id is read BEFORE the delete, because afterwards it
// is unrecoverable and the audit row would have no target.
//
// WHAT THIS FILE CANNOT PROVE, stated so nobody mistakes a green run for it:
// PostgREST is mocked, so 00165's trigger never executes and the deleted account
// is never really tombstoned. That the tombstone is what guarantees the role
// strip is argued at the call site and is not testable in this repo.

type Row = Record<string, unknown>;

const store = {
  players: [] as Row[],
  links: [] as Row[],
  audits: [] as Row[],
  /** Every read of player_discord_links fails, which the CALLER read hits first. */
  linkError: null as { message: string } | null,
  /** Only the read filtered to the target fails. */
  targetError: null as { message: string } | null,
  deleteError: null as { message: string } | null,
  auditError: null as { message: string } | null,
  /** Another officer won the snowflake between the read and the delete. */
  raceOnDelete: false,
};

/** Every query the route made, in order. The ordering cases read this. */
const queries: { table: string; op: string; filters: [string, unknown][] }[] = [];

// A FILTER-AWARE AND SELECT-AWARE FAKE, and both halves are load-bearing.
//
// The route makes two DIFFERENT reads against player_discord_links, the caller by
// their own discord_user_id with the players join and the target by theirs, and
// then deletes by the target's. A fake keyed only on the table name would answer
// both reads with the same row, and the officer would unlink themselves.
//
// And `select` has to remember its argument: PostgREST nests an embedded row
// under the related table's name, and only when the select asked for it. Ignoring
// the column list would return a bare link row with no `.players`, the route
// would read that as an unresolvable caller, and every case here would collapse
// into not_linked.
function query(table: string) {
  const filters: [string, unknown][] = [];
  let columns = '';
  let op: 'select' | 'insert' | 'delete' = 'select';
  let payload: Row = {};

  const record: { table: string; op: string; filters: [string, unknown][] } = { table, op, filters };
  queries.push(record);

  const rowsFor = (): Row[] =>
    table === 'players' ? store.players : table === 'player_discord_links' ? store.links : store.audits;

  const matching = () => rowsFor().filter((r) => filters.every(([c, v]) => r[c] === v));

  const readError = () => {
    if (table !== 'player_discord_links') return null;
    if (store.linkError) return store.linkError;
    // Keyed on WHICH row was asked for, so the caller read and the target read
    // can fail independently: the route answers them with different codes on
    // purpose, and a fake that could not tell them apart would let the two be
    // collapsed without any test noticing.
    const target = filters.find(([c]) => c === 'discord_user_id')?.[1];
    return target && target !== CALLER ? store.targetError : null;
  };

  const api = {
    select(cols?: string) {
      // DOES NOT SET `op`. `.delete().eq().select()` is a delete that names its
      // returning columns, and a select() that reset the op here would turn the
      // route's only write into a read that changes nothing.
      columns = cols ?? '';
      return api;
    },
    insert(p: Row) {
      op = 'insert';
      record.op = 'insert';
      payload = p;
      return api;
    },
    delete() {
      op = 'delete';
      record.op = 'delete';
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
    // The delete and the audit insert are awaited directly, with no maybeSingle.
    then(resolve: (value: unknown) => unknown) {
      if (op === 'delete') {
        if (store.deleteError) {
          return Promise.resolve({ data: null, error: store.deleteError }).then(resolve);
        }
        // Shaped like PostgREST: the deleted rows come back, and ZERO of them is
        // how the loser of a race between two officers finds out.
        const doomed = store.raceOnDelete ? [] : matching();
        store.links = store.links.filter((r) => !doomed.includes(r));
        return Promise.resolve({ data: doomed.map((r) => ({ ...r })), error: null }).then(resolve);
      }
      if (store.auditError) return Promise.resolve({ data: null, error: store.auditError }).then(resolve);
      store.audits.push({ ...payload });
      return Promise.resolve({ data: [payload], error: null }).then(resolve);
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

const CALLER = '111100000000000000';
const TARGET = '214300000000000000';

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
  return new Request('http://localhost/api/discord/force-unlink', {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID = {
  discordUserId: CALLER,
  targetDiscordUserId: TARGET,
  reason: 'they left the club',
};

const linkFor = (discordUserId: string) =>
  store.links.find((l) => l.discord_user_id === discordUserId);
const lastAudit = () => store.audits.at(-1);
/** Did the route ever go looking for the target's row. */
const touchedTarget = () =>
  queries.some((q) => q.filters.some(([c, v]) => c === 'discord_user_id' && v === TARGET));

beforeEach(() => {
  vi.clearAllMocks();
  queries.length = 0;
  store.players = [{ ...ADMIN }, { id: MEMBER_ID, full_name: 'Kiera Tan', handle: 'kiera' }];
  store.links = [
    { player_id: CALLER_PLAYER_ID, discord_user_id: CALLER, linked_at: 'x', last_synced_at: 'y' },
    { player_id: MEMBER_ID, discord_user_id: TARGET, linked_at: 'x', last_synced_at: 'y' },
  ];
  store.audits = [];
  store.linkError = null;
  store.targetError = null;
  store.deleteError = null;
  store.auditError = null;
  store.raceOnDelete = false;
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
});

describe('who may force an unlink', () => {
  it('refuses a request with the wrong service secret before reading anything', async () => {
    const response = await POST(post(VALID, 'Bearer wrong'));

    expect(response.status).toBe(401);
    expect(queries).toEqual([]);
    expect(linkFor(TARGET)).toBeDefined();
  });

  it('refuses an officer whose own Discord account is not connected', async () => {
    // The route resolves the CALLER by their Discord id, so an unlinked officer
    // has no club account for the capability check to ask about. This command
    // can never be the repair path for that.
    store.links = store.links.filter((l) => l.discord_user_id !== CALLER);

    const response = await POST(post(VALID));

    expect(await response.json()).toEqual({ ok: false, refusal: 'not_linked' });
    expect(linkFor(TARGET)).toBeDefined();
  });

  it('refuses an exec who was never given the write', async () => {
    setCaller(PLAIN_EXEC);

    const response = await POST(post(VALID));

    expect(await response.json()).toEqual({ ok: false, refusal: 'not_permitted' });
    expect(linkFor(TARGET)).toBeDefined();
    expect(store.audits).toEqual([]);
  });

  it('refuses a banned admin, whose standing is checked before their level', async () => {
    setCaller({ ...ADMIN, is_banned: true });

    const response = await POST(post(VALID));

    expect(await response.json()).toEqual({ ok: false, refusal: 'not_permitted' });
    expect(linkFor(TARGET)).toBeDefined();
  });

  it('lets an admin through', async () => {
    const response = await POST(post(VALID));

    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(payload.memberName).toBe('Kiera Tan');
    expect(linkFor(TARGET)).toBeUndefined();
  });

  it('lets an exec holding the capability by an explicit grant through', async () => {
    setCaller(GRANTED_EXEC);

    const response = await POST(post(VALID));

    expect(((await response.json()) as Record<string, unknown>).ok).toBe(true);
    expect(linkFor(TARGET)).toBeUndefined();
  });

  it('names a failed caller read instead of reading it as an unlinked officer', async () => {
    // A failed PostgREST read arrives as data:null with an error rather than
    // throwing. Reading that as "not linked" would tell an exec to run /link,
    // which they already have, with nothing anywhere naming the real fault.
    store.linkError = { message: 'permission denied for table player_discord_links' };

    const response = await POST(post(VALID));

    expect(response.status).toBe(503);
    expect(((await response.json()) as Record<string, unknown>).error).toBe('caller_unavailable');
    expect(linkFor(TARGET)).toBeDefined();
  });

  // THE ORDERING CASE. The capability check sits above the target lookup, so a
  // refused caller never learns whether a snowflake they guessed belongs to
  // anybody. This route's list oracle is the picker, and it is gated for the
  // same reason.
  it('never looks the target up for a caller without the capability', async () => {
    setCaller(PLAIN_EXEC);

    const response = await POST(post(VALID));

    expect(await response.json()).toEqual({ ok: false, refusal: 'not_permitted' });
    expect(touchedTarget()).toBe(false);
  });
});

describe('the request itself', () => {
  it('rejects a body that is not JSON', async () => {
    const response = await POST(
      new Request('http://localhost/api/discord/force-unlink', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
        body: 'not json',
      })
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as Record<string, unknown>).error).toBe('bad_request');
  });

  it('rejects a target id that is not a snowflake', async () => {
    // It arrives from a picker choice value or from an id an officer pasted, so
    // a malformed one is a 400 for the bot rather than advice for the officer.
    const response = await POST(post({ ...VALID, targetDiscordUserId: 'matthew#1234' }));

    expect(response.status).toBe(400);
    expect(((await response.json()) as Record<string, unknown>).error).toBe('invalid_body');
    expect(queries).toEqual([]);
  });

  it('rejects a body with no caller at all', async () => {
    const response = await POST(post({ ...VALID, discordUserId: '' }));

    expect(response.status).toBe(400);
    expect(queries).toEqual([]);
  });

  it('requires a reason, and checks it AFTER the capability but before the delete', async () => {
    // An officer who may do this still has to say why: the audit row is the
    // whole reason disconnecting somebody else by hand is acceptable at all.
    const response = await POST(post({ ...VALID, reason: '   ' }));

    expect(await response.json()).toEqual({ ok: false, refusal: 'no_reason' });
    expect(touchedTarget()).toBe(false);
    expect(linkFor(TARGET)).toBeDefined();
  });

  it('answers a caller who may not do this at all before it notices the missing reason', async () => {
    // The order matters in this direction too: telling somebody without the
    // capability to go and write a reason implies that a reason is all that
    // stands between them and the act.
    setCaller(PLAIN_EXEC);

    const response = await POST(post({ ...VALID, reason: '   ' }));

    expect(await response.json()).toEqual({ ok: false, refusal: 'not_permitted' });
  });
});

describe('the target account', () => {
  it('refuses a snowflake nobody is connected to', async () => {
    const response = await POST(post({ ...VALID, targetDiscordUserId: '999900000000000000' }));

    expect(await response.json()).toEqual({ ok: false, refusal: 'target_not_linked' });
    expect(store.audits).toEqual([]);
  });

  it('names a failed target read instead of reporting it as unconnected', async () => {
    // Degrading it would tell an officer that the account sitting in their own
    // picker belongs to nobody, and then leave it connected.
    store.targetError = { message: 'permission denied for table player_discord_links' };

    const response = await POST(post(VALID));

    expect(response.status).toBe(503);
    expect(((await response.json()) as Record<string, unknown>).error).toBe('link_unavailable');
    expect(linkFor(TARGET)).toBeDefined();
  });

  it('reads the member BEFORE deleting the row that names them', async () => {
    // After the delete the player_id is unrecoverable and the audit row would
    // have no target, which is the one field that files the entry on the
    // member's own record.
    await POST(post(VALID));

    const onTarget = queries.filter((q) =>
      q.filters.some(([c, v]) => c === 'discord_user_id' && v === TARGET)
    );
    expect(onTarget.map((q) => q.op)).toEqual(['select', 'delete']);
    expect(lastAudit()!.target_id).toBe(MEMBER_ID);
  });

  it('refuses rather than claims success when another officer won the race', async () => {
    // The delete's returning clause is the real guarantee: the loser matches
    // zero rows, and reporting success there would file an audit row for an
    // unlink this call did not perform.
    store.raceOnDelete = true;

    const response = await POST(post(VALID));

    expect(await response.json()).toEqual({ ok: false, refusal: 'target_not_linked' });
    expect(store.audits).toEqual([]);
  });

  it('reports a failed delete as a fault rather than a refusal', async () => {
    // A refusal is a 200 with a code because the app answered clearly. THIS is
    // the other direction: nothing is wrong with the request, something is wrong
    // with the app, and a named refusal would tell an officer to fix something
    // they cannot see.
    store.deleteError = { message: 'deadlock detected' };

    const response = await POST(post(VALID));

    expect(response.status).toBe(503);
    expect(((await response.json()) as Record<string, unknown>).error).toBe('force_unlink_failed');
    expect(store.audits).toEqual([]);
  });
});

describe('the audit row', () => {
  it('files the act against the member, by the officer', async () => {
    await POST(post(VALID));

    const entry = lastAudit()!;
    expect(entry.action_type).toBe('discord_link_force_removed');
    expect(entry.actor_id).toBe(CALLER_PLAYER_ID);
    // The TARGET is the member, not the actor. This is why the row is written
    // inline rather than through logMemberAudit, which pins both to the actor.
    expect(entry.target_type).toBe('player');
    expect(entry.target_id).toBe(MEMBER_ID);
    expect(entry.reason).toBe('they left the club');
    expect((entry.old_value as Row).discord_user_id).toBe(TARGET);
    expect((entry.new_value as Row).discord_user_id).toBe(null);
  });

  it('still reports success when the audit insert is refused', async () => {
    // The row is already deleted. Losing the record of it must not also lose the
    // officer's reply, so the failure goes to Sentry and the request succeeds.
    store.auditError = { message: 'permission denied for table audit_logs' };

    const response = await POST(post(VALID));

    expect(response.status).toBe(200);
    expect(((await response.json()) as Record<string, unknown>).ok).toBe(true);
    expect(linkFor(TARGET)).toBeUndefined();
  });
});
