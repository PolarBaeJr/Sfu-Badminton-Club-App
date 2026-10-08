import { describe, it, expect, vi, beforeEach } from 'vitest';

// POST /api/discord/server-roles is what the bot calls to publish the guild's
// CATALOGUE of mentionable roles (00229), which is what the console's notify
// picker offers.
//
// Validation here is a boundary, not hygiene, and for the same reason
// /api/discord/config's is: the bot builds this payload out of names and ids it
// read from somebody else's guild, so "the caller is our code" is not the same
// claim as "the data is ours". What it decides is which snowflake a picked name
// becomes, and a mention is the one thing this console cannot take back.
//
// AND THE SEMANTICS ARE A REPLACE, not an upsert. That is the opposite of
// /config, deliberately, so the dangerous input here is the EMPTY one.

const upsert = vi.fn();
const selectEq = vi.fn();
const deleteIn = vi.fn();

/** The filters each leg was given, so the prune can be asserted. */
let selectFilters: [string, unknown][];
let deleteFilters: { eq: [string, unknown][]; in: [string, string[]][] };

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      upsert,
      select: () => ({
        eq: (column: string, value: unknown) => {
          selectFilters.push([column, value]);
          return selectEq(column, value);
        },
      }),
      delete: () => {
        const chain = {
          eq: (column: string, value: unknown) => {
            deleteFilters.eq.push([column, value]);
            return chain;
          },
          in: (column: string, values: string[]) => {
            deleteFilters.in.push([column, values]);
            return deleteIn(column, values);
          },
        };
        return chain;
      },
    }),
  }),
}));

import { POST } from '../route';

const GUILD = '123456789012345678';
const ROLE = '987654321098765432';
const OTHER_ROLE = '987654321098765433';

function post(body: unknown, auth = 'Bearer test-secret') {
  return new Request('http://localhost/api/discord/server-roles', {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID = { guildId: GUILD, roles: [{ roleId: ROLE, name: 'Varsity', position: 7 }] };

/** A catalogue already holding the posted role and one that has gone. */
function stored(...roleIds: string[]) {
  selectEq.mockResolvedValue({ data: roleIds.map((role_id) => ({ role_id })), error: null });
}

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
  selectFilters = [];
  deleteFilters = { eq: [], in: [] };
  upsert.mockReset().mockResolvedValue({ error: null });
  // An empty catalogue by default, which is the state on the first sync after
  // 00229 is applied.
  selectEq.mockReset().mockResolvedValue({ data: [], error: null });
  deleteIn.mockReset().mockResolvedValue({ error: null });
});

describe('auth', () => {
  it('refuses without the service secret', async () => {
    const res = await POST(post(VALID, 'Bearer wrong'));
    expect(res.status).toBe(401);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses when the secret is not configured at all, which fails closed', async () => {
    delete process.env.DISCORD_SERVICE_SECRET;
    const res = await POST(post(VALID));
    expect(res.status).toBe(401);
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('validation', () => {
  it('accepts a well-formed payload', async () => {
    const res = await POST(post(VALID));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, guildId: GUILD, roles: 1, pruned: true });
  });

  it('stores the name trimmed and the position as sent', async () => {
    await POST(post({ guildId: GUILD, roles: [{ roleId: ROLE, name: '  Varsity  ', position: 3 }] }));

    expect(upsert.mock.calls[0]![0]).toMatchObject([
      { guild_id: GUILD, role_id: ROLE, role_name: 'Varsity', position: 3 },
    ]);
  });

  it('accepts a role with no position, because /setup cannot report one', async () => {
    // createGuildRole does not hand the position back, so the roles /setup has
    // just made are posted without one and the column stays NULL until the next
    // tick. An invented 0 would sort them to the bottom and look deliberate.
    await POST(post({ guildId: GUILD, roles: [{ roleId: ROLE, name: 'Linked' }] }));

    expect(upsert.mock.calls[0]![0]).toMatchObject([{ role_id: ROLE, position: null }]);
  });

  it('REFUSES AN EMPTY ARRAY rather than reading it as "delete everything"', async () => {
    // The one input that silently empties the picker under replace semantics. A
    // bot that could not read the guild's roles posts nothing at all, so an empty
    // list can only be a caller that filtered them all away by mistake.
    const res = await POST(post({ guildId: GUILD, roles: [] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'no_roles' });
    expect(upsert).not.toHaveBeenCalled();
    expect(deleteIn).not.toHaveBeenCalled();
  });

  it('refuses an oversized array', async () => {
    // Discord's own per-guild limit is 250, so the cap is that and not lower: a
    // tighter one would make a large server's catalogue permanently unwritable.
    const roles = Array.from({ length: 251 }, (_, i) => ({
      roleId: String(100000000000000000 + i),
      name: `Role ${i}`,
    }));
    const res = await POST(post({ guildId: GUILD, roles }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'too_many_roles' });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses @everyone, whose id IS the guild id', async () => {
    // It cannot be notified through the roles list at all: only
    // allowed_mentions parse: ["everyone"] rings it, and the ping line sends
    // parse: []. A row for it would be a picker entry that rings nobody.
    const res = await POST(post({ guildId: GUILD, roles: [{ roleId: GUILD, name: '@everyone' }] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'role_is_everyone' });
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each([
    ['not a snowflake', 'not-an-id'],
    ['too short', '123'],
    ['injection-shaped', "1' OR '1'='1"],
    ['empty', ''],
  ])('refuses a role id that is %s', async (_label, bad) => {
    const res = await POST(post({ guildId: GUILD, roles: [{ roleId: bad, name: 'Varsity' }] }));
    expect(res.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses a malformed guild id', async () => {
    const res = await POST(post({ ...VALID, guildId: 'nope' }));
    expect(res.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses a blank name and a name past Discord\'s 100 characters', async () => {
    for (const name of ['   ', 'x'.repeat(101)]) {
      const res = await POST(post({ guildId: GUILD, roles: [{ roleId: ROLE, name }] }));
      expect(res.status).toBe(400);
    }
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses roles that are not objects, and a roles field that is not an array', async () => {
    expect((await POST(post({ guildId: GUILD, roles: ['Varsity'] }))).status).toBe(400);
    expect((await POST(post({ guildId: GUILD, roles: { a: 1 } }))).status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses a body that is not JSON', async () => {
    const res = await POST(
      new Request('http://localhost/api/discord/server-roles', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret' },
        body: 'not json',
      })
    );
    expect(res.status).toBe(400);
  });
});

describe('the replace', () => {
  it('deletes this guild\'s rows whose id is absent from the payload, and only those', async () => {
    stored(ROLE, OTHER_ROLE);

    await POST(post({ guildId: GUILD, roles: [{ roleId: ROLE, name: 'Varsity' }] }));

    // A row for OTHER_ROLE would be a picker entry resolving to a role that has
    // gone from Discord, which is a dead mention in a posted message.
    expect(deleteFilters.in).toEqual([['role_id', [OTHER_ROLE]]]);
  });

  it('NAMES THE STALE IDS rather than filtering on everything it just posted', async () => {
    // The prune reads the guild's ids back and diffs in TypeScript because a
    // PostgREST filter travels in the QUERY STRING: `role_id NOT IN (250
    // snowflakes)` is about 5KB of URL through Kong and the proxy, which is the
    // same limit the console's MAX_MAPPING_LOOKUP cap exists for. It would pass
    // on every small server and 414 on a large one, so the list sent here has to
    // scale with what is STALE and not with what exists.
    const roles = Array.from({ length: 250 }, (_, i) => ({
      roleId: String(100000000000000000 + i),
      name: `Role ${i}`,
    }));
    stored(...roles.map((r) => r.roleId), OTHER_ROLE);

    await POST(post({ guildId: GUILD, roles }));

    expect(deleteFilters.in).toEqual([['role_id', [OTHER_ROLE]]]);
  });

  it('issues NO delete at all when nothing has gone, which is most ticks', async () => {
    stored(ROLE);

    const res = await POST(post(VALID));

    expect(deleteFilters.in).toEqual([]);
    expect(deleteIn).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ pruned: true });
  });

  it('never touches a guild the payload does not name', async () => {
    // The club may run a second server. A blanket delete is what would empty it,
    // and these are the filters that stop one: the re-read is per-guild too, so
    // another server's ids can never be counted as stale here.
    stored(ROLE, OTHER_ROLE);

    await POST(post(VALID));

    expect(selectFilters).toEqual([['guild_id', GUILD]]);
    expect(deleteFilters.eq).toEqual([['guild_id', GUILD]]);
  });

  it('upserts BEFORE it prunes', async () => {
    // The other order leaves a window in which the console reads an empty
    // catalogue and offers only the club's nine, and the tick driving this is
    // five minutes wide.
    stored(ROLE, OTHER_ROLE);
    const order: string[] = [];
    upsert.mockImplementation(async () => (order.push('upsert'), { error: null }));
    deleteIn.mockImplementation(async () => (order.push('prune'), { error: null }));

    await POST(post(VALID));

    expect(order).toEqual(['upsert', 'prune']);
  });

  it('reports a failed write as 503 rather than claiming success', async () => {
    // Until 00229 is applied the table does not exist. Answering ok here would
    // leave the bot logging a successful sync forever over a missing table.
    upsert.mockResolvedValue({ error: { message: 'relation does not exist' } });

    const res = await POST(post(VALID));
    expect(res.status).toBe(503);
    expect(selectEq).not.toHaveBeenCalled();
    expect(deleteIn).not.toHaveBeenCalled();
  });

  it('says the prune failed without calling the whole sync a failure', async () => {
    // Everything the bot could see is stored by then. What is left over is a
    // stale row, and the next tick tries again.
    stored(ROLE, OTHER_ROLE);
    deleteIn.mockResolvedValue({ error: { message: 'nope' } });

    const res = await POST(post(VALID));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, pruned: false });
  });

  it('says the same when it cannot read the catalogue back, and deletes nothing', async () => {
    // A failed PostgREST read arrives as an empty list, not a throw, and an empty
    // list read as "nothing is stale" is the harmless answer. This is the errored
    // case, where guessing would be the only way to get it wrong.
    selectEq.mockResolvedValue({ data: null, error: { message: 'nope' } });

    const res = await POST(post(VALID));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, pruned: false });
    expect(deleteIn).not.toHaveBeenCalled();
  });
});
