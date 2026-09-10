import { describe, it, expect, beforeEach, vi } from 'vitest';

// WHAT THE CONSOLE ACTUALLY QUEUES FOR DISCORD.
//
// Two halves of one property live in two repositories' worth of code, and only
// one of them is testable from here. The admin half, asserted below, is that
// turning `@internal` into `<@&1111...>` produces the SAME bytes whether or not
// the ping switch is on, and that the row's `ping` is exactly the boolean that
// arrived. Rewriting text can therefore never smuggle in a notification.
//
// The other half is that `ping = false` renders a mention and notifies nobody,
// which is `{ parse: [] }` in `payloadFor` (apps/bot/src/outbox.ts). That is
// existing, verified bot behaviour, and this change touches none of it, so there
// is deliberately no test for it here and none added under apps/bot.

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  /** Every table the action asked for, in order, so a round trip can be counted. */
  touched: [] as string[],
  /** The audit entries the action wrote, in full. */
  audit: [] as Row[],
  actor: { id: 'aaaaaaaa-0000-4000-8000-000000000001' } as Row,
}));

const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    store.touched.push(table);
    const filters: Array<[string, unknown]> = [];
    let inserted: Row | null = null;

    const matching = () =>
      (store.db[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));

    const run = (): { data: Row[]; error: null } =>
      inserted ? { data: [inserted], error: null } : { data: matching(), error: null };

    const api = {
      select() { return api; },
      insert(row: Row) {
        // The two columns the table fills in for itself, which the action reads
        // straight back out of `.select('id, created_at').single()`.
        const stored = {
          id: `0117b0c0-0000-4000-8000-00000000000${(store.db[table] ?? []).length + 1}`,
          created_at: '2026-09-10T18:00:00.000Z',
          ...row,
        };
        store.db[table] = [...(store.db[table] ?? []), stored];
        inserted = stored;
        return api;
      },
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      order() { return api; },
      async single() {
        const res = run();
        return { data: res.data[0] ?? null, error: res.error };
      },
      async maybeSingle() {
        const res = run();
        return { data: res.data[0] ?? null, error: res.error };
      },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(run()).then(resolve); },
    };
    return api;
  }
  return { from: (table: string) => query(table) };
});

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('../supabase-server', () => ({ createAdminClient: makeClient }));
vi.mock('../actions/_shared', () => ({ requireCapability: async () => store.actor }));
vi.mock('../audit', () => ({
  logAdminAudit: async (_client: unknown, entry: Row) => {
    store.audit.push(entry);
  },
}));

import { queueDiscordMessage } from '../actions/discord-message';

const GUILD = '900000000000000001';
const ANNOUNCEMENTS = '800000000000000001';
const RESULTS = '800000000000000002';
const INTERNAL_ROLE = '111111111111111111';
const INTERNAL = `<@&${INTERNAL_ROLE}>`;

const outbox = () => store.db.discord_outbox ?? [];

beforeEach(() => {
  store.touched = [];
  store.audit = [];
  store.db = {
    discord_guilds: [{ guild_id: GUILD }],
    discord_settings: [
      { key: 'announcement_channel_id', value: ANNOUNCEMENTS },
      { key: 'match_results_channel_id', value: RESULTS },
    ],
    discord_guild_roles: [
      { guild_id: GUILD, role_name: 'internal', role_id: INTERNAL_ROLE },
      { guild_id: GUILD, role_name: 'session_staff', role_id: '222222222222222222' },
    ],
    discord_outbox: [],
  };
});

describe('queueDiscordMessage: where it goes', () => {
  it('sends to the channel that was picked', async () => {
    // A channel chosen from the picker arrives as an id, exactly as a pasted one
    // does, and there is no second parameter deciding between them.
    await queueDiscordMessage({ content: 'Results are up', channelId: RESULTS });

    expect(outbox()).toHaveLength(1);
    expect(outbox()[0]!.channel_id).toBe(RESULTS);
  });

  it('falls back to the configured announcements channel when none was picked', async () => {
    await queueDiscordMessage({ content: 'Gym is closed tonight' });

    expect(outbox()[0]!.channel_id).toBe(ANNOUNCEMENTS);
  });

  it('refuses anything that is not a snowflake', async () => {
    await expect(
      queueDiscordMessage({ content: 'Gym is closed', channelId: '#general' }),
    ).rejects.toThrow(/Developer Mode/);

    expect(outbox()).toHaveLength(0);
  });
});

describe('queueDiscordMessage: role mentions', () => {
  it('stores a real mention where a role name was typed', async () => {
    await queueDiscordMessage({ content: 'Reminder for @internal about fees' });

    expect(outbox()[0]!.content).toBe(`Reminder for ${INTERNAL} about fees`);
  });

  it('rewrites the same way whether or not the ping switch is on', async () => {
    await queueDiscordMessage({ content: 'Reminder for @internal', ping: false });
    await queueDiscordMessage({ content: 'Reminder for @internal', ping: true });

    // Byte-identical. Whether a phone buzzes is `ping` and nothing else, so the
    // rewrite cannot be a back door into notifying the club.
    expect(outbox()[0]!.content).toBe(outbox()[1]!.content);
    expect(outbox()[0]!.ping).toBe(false);
    expect(outbox()[1]!.ping).toBe(true);
  });

  it('coerces the ping flag rather than trusting what arrived', async () => {
    // A server action is an HTTP endpoint and nothing stops a caller sending a
    // truthy string where a boolean belongs.
    await queueDiscordMessage({ content: 'Quiet one', ping: 'yes' as unknown as boolean });

    expect(outbox()[0]!.ping).toBe(false);
  });

  it('refuses a message that only goes over the limit once the mention expands', async () => {
    // 1995 typed characters, which the first length check lets through. The role
    // name is 9 of them and the id it becomes is 22, so what would be inserted
    // is 2008 and the table's CHECK would reject it as a raw Postgres string.
    const content = `${'x'.repeat(1985)} @internal`;
    expect(content).toHaveLength(1995);

    await expect(queueDiscordMessage({ content })).rejects.toThrow(/2008 characters/);
    await expect(queueDiscordMessage({ content })).rejects.toThrow(/real mentions/);

    expect(outbox()).toHaveLength(0);
  });

  it('spends no round trip on the role map when there is no @ in the message', async () => {
    await queueDiscordMessage({ content: 'Gym is closed tonight' });

    expect(store.touched).not.toContain('discord_guild_roles');
  });
});

describe('queueDiscordMessage: embeds are left alone', () => {
  it('stores an embed body exactly as typed and never reads the role map', async () => {
    // Discord does not notify anybody from embed text, so a mention chip in
    // there could never be a ping. A name is the honest thing to store.
    await queueDiscordMessage({
      embed: { title: 'Fees are due', body: 'This one is for @internal', type: 'info' },
    });

    expect(outbox()[0]!.embed_body).toBe('This one is for @internal');
    expect(store.touched).not.toContain('discord_guild_roles');
  });
});

describe('queueDiscordMessage: the audit entry', () => {
  it('quotes what was queued, not what was typed, and names the role', async () => {
    await queueDiscordMessage({ content: 'Reminder for @internal', ping: true });

    // `target_id` is the outbox row, so an entry quoting anything other than
    // that row's content would disagree with the thing it points at.
    expect(store.audit).toHaveLength(1);
    expect(store.audit[0]!.target_id).toBe(outbox()[0]!.id);
    expect(store.audit[0]!.new_value).toMatchObject({
      channel_id: ANNOUNCEMENTS,
      ping: true,
      content: `Reminder for ${INTERNAL}`,
      mentioned_roles: ['internal'],
    });
  });

  it('says nothing about roles when none was mentioned', async () => {
    await queueDiscordMessage({ content: 'Gym is closed tonight' });

    expect(store.audit[0]!.new_value).not.toHaveProperty('mentioned_roles');
  });
});
