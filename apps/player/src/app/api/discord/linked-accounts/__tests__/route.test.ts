import { describe, it, expect, vi, beforeEach } from 'vitest';

// POST /api/discord/linked-accounts is the picker behind /forceunlink and
// /forceupdate: connected Discord accounts, by member name.
//
// THE READ IS THE DISCLOSURE, and that is the whole reason this file leans on
// the capability check rather than treating it as tidiness. An ungated list here
// would name hidden, suspended and pending members, with their Discord accounts
// beside them, to anybody who can reach the route with the service secret. The
// force-link route refuses to build the same oracle in the other direction by
// putting its capability check above the handle lookup, and /api/discord/handles
// avoids it by reading the ladder, which is exactly why neither could serve this
// picker: the member an officer needs here is very often one the ladder hides.

type Row = Record<string, unknown>;

const store = {
  players: [] as Row[],
  links: [] as Row[],
  linkError: null as { message: string } | null,
  listError: null as { message: string } | null,
};

const queries: { table: string; filters: [string, unknown][] }[] = [];

// The caller read is filtered and embeds the permission triple; the list read is
// the whole table with names embedded. Both are player_discord_links, so the
// fake has to answer them differently, which is what `filters` and `columns` are
// for.
function query(table: string) {
  const filters: [string, unknown][] = [];
  let columns = '';

  queries.push({ table, filters });

  const matching = () => store.links.filter((r) => filters.every(([c, v]) => r[c] === v));

  const joined = (hit: Row) => {
    const player = store.players.find((p) => p.id === hit.player_id);
    return { ...hit, players: player ? { ...player } : null };
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
      if (store.linkError) return { data: null, error: store.linkError };
      const hit = matching()[0];
      if (!hit) return { data: null, error: null };
      if (columns.includes('players!inner')) {
        const player = store.players.find((p) => p.id === hit.player_id);
        return player
          ? { data: { player_id: hit.player_id, players: { ...player } }, error: null }
          : { data: null, error: null };
      }
      return { data: { ...hit }, error: null };
    },
    // The list read is awaited directly, with no maybeSingle and no filter.
    then(resolve: (value: unknown) => unknown) {
      if (store.listError) return Promise.resolve({ data: null, error: store.listError }).then(resolve);
      return Promise.resolve({ data: matching().map(joined), error: null }).then(resolve);
    },
  };
  return api;
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({ from: (table: string) => query(table) }),
}));

import { POST } from '../route';

const CALLER_PLAYER_ID = 'p-caller';
const CALLER = '111100000000000000';
const TARGET = '214300000000000000';

const ADMIN: Row = {
  id: CALLER_PLAYER_ID,
  full_name: 'The Admin',
  status: 'competitive',
  role: 'admin',
  is_exec: true,
  is_trainer: false,
  is_banned: false,
  active_flag: true,
  permission_role: null,
  permission_grants: null,
  permission_revokes: null,
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
  return new Request('http://localhost/api/discord/linked-accounts', {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const choicesFrom = async (response: Response) =>
  ((await response.json()) as { choices?: { name: string; value: string }[] }).choices ?? [];

beforeEach(() => {
  vi.clearAllMocks();
  queries.length = 0;
  store.players = [
    { ...ADMIN },
    // A SUSPENDED MEMBER, on purpose: they have no ladder row, so the handles
    // route could never offer them, and they are exactly who an officer reaches
    // for these commands about.
    { id: 'p-member', full_name: 'Kiera Tan', status: 'suspended' },
    { id: 'p-other', full_name: 'Someone Else', status: 'competitive' },
  ];
  store.links = [
    { player_id: CALLER_PLAYER_ID, discord_user_id: CALLER },
    { player_id: 'p-member', discord_user_id: TARGET },
    { player_id: 'p-other', discord_user_id: '330000000000000000' },
  ];
  store.linkError = null;
  store.listError = null;
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
});

describe('who may read the list', () => {
  it('refuses a request with the wrong service secret before reading anything', async () => {
    const response = await POST(post({ discordUserId: CALLER, query: '' }, 'Bearer wrong'));

    expect(response.status).toBe(401);
    expect(queries).toEqual([]);
  });

  // ASSERTED EXPLICITLY, because this route is the list oracle. Everything else
  // in this file describes what the picker shows; this is the case that says who
  // may see it at all.
  it('refuses an exec without the capability, and reads no names for them', async () => {
    setCaller(PLAIN_EXEC);

    const response = await POST(post({ discordUserId: CALLER, query: '' }));

    expect(await response.json()).toEqual({ ok: false, refusal: 'not_permitted' });
    // One query: the caller read. The list was never touched.
    expect(queries.length).toBe(1);
  });

  it('refuses an officer whose own Discord account is not connected', async () => {
    store.links = store.links.filter((l) => l.discord_user_id !== CALLER);

    const response = await POST(post({ discordUserId: CALLER, query: '' }));

    expect(await response.json()).toEqual({ ok: false, refusal: 'not_linked' });
  });

  it('names a failed caller read instead of reading it as an unlinked officer', async () => {
    store.linkError = { message: 'permission denied for table player_discord_links' };

    const response = await POST(post({ discordUserId: CALLER, query: '' }));

    expect(response.status).toBe(503);
    expect(((await response.json()) as Record<string, unknown>).error).toBe('caller_unavailable');
  });

  it('rejects a body with no caller at all', async () => {
    const response = await POST(post({ query: '' }));

    expect(response.status).toBe(400);
    expect(queries).toEqual([]);
  });
});

describe('what the picker offers', () => {
  it('returns the snowflake as the value and a readable label as the name', async () => {
    // The value goes straight into the option the force commands hand back to
    // their routes, whose delete keys on discord_user_id, so anything
    // decorative in it would act on an account nobody has.
    const choices = await choicesFrom(await POST(post({ discordUserId: CALLER, query: 'kiera' })));

    expect(choices).toHaveLength(1);
    expect(choices[0]!.value).toBe(TARGET);
    expect(choices[0]!.name).toContain('Kiera Tan');
    // The status and the snowflake are the disambiguator: two members can share
    // a name, and the officer should see which account they picked.
    expect(choices[0]!.name).toContain('suspended');
    expect(choices[0]!.name).toContain(TARGET);
  });

  it('matches a name case-insensitively and in the middle', async () => {
    const choices = await choicesFrom(await POST(post({ discordUserId: CALLER, query: 'TAN' })));

    expect(choices.map((c) => c.value)).toEqual([TARGET]);
  });

  it('matches a digits-only query against the snowflake', async () => {
    // An officer who pasted an id out of Discord must find its row rather than
    // an empty picker. Names are never all digits, so this costs the name match
    // nothing.
    const choices = await choicesFrom(await POST(post({ discordUserId: CALLER, query: TARGET })));

    expect(choices.map((c) => c.value)).toEqual([TARGET]);
  });

  it('offers everything when nothing has been typed yet', async () => {
    // The picker opens with an empty value; answering nothing there makes it
    // look broken.
    const choices = await choicesFrom(await POST(post({ discordUserId: CALLER, query: '' })));

    expect(choices).toHaveLength(3);
  });

  it('caps at Discord’s limit of 25', async () => {
    // Discord rejects the WHOLE response above 25, not the surplus rows, so a
    // large club would get a picker that suggests nothing at all. It is also the
    // reason a raw snowflake has to stay acceptable downstream.
    store.players = [{ ...ADMIN }];
    store.links = [{ player_id: CALLER_PLAYER_ID, discord_user_id: CALLER }];
    for (let i = 0; i < 60; i += 1) {
      store.players.push({ id: `p-${i}`, full_name: `Member ${i}`, status: 'competitive' });
      store.links.push({ player_id: `p-${i}`, discord_user_id: `9000000000000000${i}` });
    }

    const choices = await choicesFrom(await POST(post({ discordUserId: CALLER, query: 'Member' })));

    expect(choices).toHaveLength(25);
  });

  it('names a failed list read rather than answering with an empty picker', async () => {
    // An empty list is indistinguishable, to the officer, from a club where
    // nobody is connected. The bot turns any non-ok status into an empty
    // picker of its own, but the log line and the status are what say why.
    store.listError = { message: 'permission denied for table player_discord_links' };

    const response = await POST(post({ discordUserId: CALLER, query: '' }));

    expect(response.status).toBe(503);
    expect(((await response.json()) as Record<string, unknown>).error).toBe('accounts_unavailable');
  });
});
