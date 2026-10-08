import { describe, it, expect, vi, beforeEach } from 'vitest';

// POST /api/discord/force-sync answers two questions for /forceupdate: may this
// officer re-apply somebody else's club roles, and is that account connected to
// a member at all.
//
// IT WRITES NOTHING, which is why it takes no reason where its force-unlink
// sibling insists on one, and why there is no audit case in this file. A reason
// is what makes a by-hand EDIT to a member's record acceptable; this edits
// nothing and is convergent.
//
// THE SECOND QUESTION IS NOT A FORMALITY, and the case for it is at the bottom
// of this file. syncMembersNow reads an id absent from the roster as "strip
// everything", deliberately, so a resync aimed at an unlinked account would be a
// silent full strip rather than the refresh the officer asked for.

type Row = Record<string, unknown>;

const store = {
  players: [] as Row[],
  links: [] as Row[],
  /** Every read of player_discord_links fails, which the CALLER read hits first. */
  linkError: null as { message: string } | null,
  /** Only the read filtered to the target fails. */
  targetError: null as { message: string } | null,
};

const queries: { table: string; filters: [string, unknown][] }[] = [];

// Filter-aware and select-aware, for the reason the force-unlink route's test
// fake gives: the caller and the target are two different reads of the same
// table, and a fake that could not tell them apart would answer both with the
// officer's own row.
function query(table: string) {
  const filters: [string, unknown][] = [];
  let columns = '';

  queries.push({ table, filters });

  const rowsFor = (): Row[] => (table === 'players' ? store.players : store.links);
  const matching = () => rowsFor().filter((r) => filters.every(([c, v]) => r[c] === v));

  const readError = () => {
    if (table !== 'player_discord_links') return null;
    if (store.linkError) return store.linkError;
    const target = filters.find(([c]) => c === 'discord_user_id')?.[1];
    return target && target !== CALLER ? store.targetError : null;
  };

  const api = {
    select(cols?: string) {
      columns = cols ?? '';
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
  };
  return api;
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({ from: (table: string) => query(table) }),
}));

import { POST } from '../route';

const CALLER_PLAYER_ID = 'p-caller';
const MEMBER_ID = 'p-member';

const CALLER = '111100000000000000';
const TARGET = '214300000000000000';

// AN ADMIN, because players.discordlink.write is in no role's defaults and not
// in EXEC_BASELINE, so an unrestricted exec does not hold it.
const ADMIN: Row = {
  id: CALLER_PLAYER_ID,
  full_name: 'The Admin',
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

/** An exec nobody gave anything to. */
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
  return new Request('http://localhost/api/discord/force-sync', {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID = { discordUserId: CALLER, targetDiscordUserId: TARGET };

const touchedTarget = () =>
  queries.some((q) => q.filters.some(([c, v]) => c === 'discord_user_id' && v === TARGET));

beforeEach(() => {
  vi.clearAllMocks();
  queries.length = 0;
  store.players = [{ ...ADMIN }, { id: MEMBER_ID, full_name: 'Kiera Tan' }];
  store.links = [
    { player_id: CALLER_PLAYER_ID, discord_user_id: CALLER },
    { player_id: MEMBER_ID, discord_user_id: TARGET },
  ];
  store.linkError = null;
  store.targetError = null;
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
});

describe('who may force a resync', () => {
  it('refuses a request with the wrong service secret before reading anything', async () => {
    const response = await POST(post(VALID, 'Bearer wrong'));

    expect(response.status).toBe(401);
    expect(queries).toEqual([]);
  });

  it('refuses an officer whose own Discord account is not connected', async () => {
    store.links = store.links.filter((l) => l.discord_user_id !== CALLER);

    const response = await POST(post(VALID));

    expect(await response.json()).toEqual({ ok: false, refusal: 'not_linked' });
  });

  it('refuses an exec who was never given the write', async () => {
    setCaller(PLAIN_EXEC);

    const response = await POST(post(VALID));

    expect(await response.json()).toEqual({ ok: false, refusal: 'not_permitted' });
  });

  it('refuses a banned admin, whose standing is checked before their level', async () => {
    setCaller({ ...ADMIN, is_banned: true });

    const response = await POST(post(VALID));

    expect(await response.json()).toEqual({ ok: false, refusal: 'not_permitted' });
  });

  it('lets an admin through, naming the member', async () => {
    const response = await POST(post(VALID));

    expect(await response.json()).toEqual({ ok: true, memberName: 'Kiera Tan' });
  });

  it('lets an exec holding the capability by an explicit grant through', async () => {
    setCaller(GRANTED_EXEC);

    expect(((await (await POST(post(VALID))).json()) as Record<string, unknown>).ok).toBe(true);
  });

  it('names a failed caller read instead of reading it as an unlinked officer', async () => {
    store.linkError = { message: 'permission denied for table player_discord_links' };

    const response = await POST(post(VALID));

    expect(response.status).toBe(503);
    expect(((await response.json()) as Record<string, unknown>).error).toBe('caller_unavailable');
  });

  it('never looks the target up for a caller without the capability', async () => {
    setCaller(PLAIN_EXEC);

    await POST(post(VALID));

    expect(touchedTarget()).toBe(false);
  });
});

describe('the request itself', () => {
  it('rejects a body that is not JSON', async () => {
    const response = await POST(
      new Request('http://localhost/api/discord/force-sync', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
        body: 'not json',
      })
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as Record<string, unknown>).error).toBe('bad_request');
  });

  it('rejects a target id that is not a snowflake', async () => {
    const response = await POST(post({ ...VALID, targetDiscordUserId: 'matthew#1234' }));

    expect(response.status).toBe(400);
    expect(queries).toEqual([]);
  });
});

describe('the target account', () => {
  // THE CASE THIS ROUTE EXISTS FOR, beyond the permission check. The bot cannot
  // tell an unlinked account from a linked one, and member-sync.ts reads an
  // absent id as "strip everything". Without this refusal, /forceupdate on a
  // disconnected account would silently take every club role off it.
  it('refuses a snowflake nobody is connected to, rather than letting a strip run', async () => {
    const response = await POST(post({ ...VALID, targetDiscordUserId: '999900000000000000' }));

    expect(await response.json()).toEqual({ ok: false, refusal: 'target_not_linked' });
  });

  it('names a failed target read instead of reporting it as unconnected', async () => {
    // Degrading it would refuse a resync for a member who IS linked, and send
    // the officer looking for a broken link that is not broken.
    store.targetError = { message: 'permission denied for table player_discord_links' };

    const response = await POST(post(VALID));

    expect(response.status).toBe(503);
    expect(((await response.json()) as Record<string, unknown>).error).toBe('link_unavailable');
  });
});
