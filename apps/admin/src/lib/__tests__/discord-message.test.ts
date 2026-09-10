import { describe, it, expect, beforeEach, vi } from 'vitest';

// WHAT THE CONSOLE ACTUALLY QUEUES FOR DISCORD.
//
// Two halves of one property live in two repositories' worth of code, and only
// one of them is testable from here. The admin half, asserted below, is that
// turning `@internal` into `<@&1111...>` produces the SAME bytes whether or not
// the ping switch is on, and that the row's `ping` is exactly what the roles
// picked imply. Rewriting text can therefore never smuggle in a notification.
//
// The other half is that `ping = false` renders a mention and notifies nobody,
// which is `{ parse: [] }` in `payloadFor` (apps/bot/src/outbox.ts), along with
// the ping line that a combined row posts above its embed. Those are asserted
// in apps/bot/src/__tests__/outbox.test.ts, where that code lives.

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  /** Every table the action asked for, in order, so a round trip can be counted. */
  touched: [] as string[],
  /** The audit entries the action wrote, in full. */
  audit: [] as Row[],
  actor: { id: 'aaaaaaaa-0000-4000-8000-000000000001' } as Row,
  /** A capability the viewer does NOT hold, so a gate can be driven. */
  withheld: null as string | null,
}));

const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    store.touched.push(table);
    // Predicates rather than column/value pairs, because `is` and `or` do not
    // fit a pair: the first has to read a missing column as NULL, and the
    // second is a set of alternatives over the same row.
    const filters: Array<(r: Row) => boolean> = [];
    let inserted: Row | null = null;
    let updates: Row | null = null;
    let sort: { column: string; ascending: boolean } | null = null;
    let take: number | null = null;

    const matching = () => (store.db[table] ?? []).filter((r) => filters.every((f) => f(r)));

    /** One term of a PostgREST `or`, which is `column.op` and then a value. */
    const term = (text: string): ((r: Row) => boolean) => {
      const [column, ...rest] = text.split('.');
      // Rejoined, because an ISO timestamp has dots of its own in it.
      const op = rest.join('.');
      return (r: Row) => {
        const value = r[column!] ?? null;
        if (op === 'is.null') return value === null;
        if (op === 'not.is.null') return value !== null;
        if (op.startsWith('lt.')) return value !== null && String(value) < op.slice(3);
        throw new Error(`the fake client does not understand "${text}"`);
      };
    };

    const run = (): { data: Row[]; error: null } => {
      if (inserted) return { data: [inserted], error: null };
      let rows = matching();
      // Written through to the row the store holds, so a later read sees the
      // change the way Postgres would.
      if (updates) rows = rows.map((r) => Object.assign(r, updates));
      if (sort) {
        const { column, ascending } = sort;
        rows = [...rows].sort(
          (a, b) => String(a[column] ?? '').localeCompare(String(b[column] ?? '')) * (ascending ? 1 : -1),
        );
      }
      if (take !== null) rows = rows.slice(0, take);
      return { data: rows, error: null };
    };

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
      update(row: Row) { updates = row; return api; },
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return api; },
      is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return api; },
      or(expr: string) {
        const terms = expr.split(',').map(term);
        filters.push((r) => terms.some((t) => t(r)));
        return api;
      },
      order(column?: string, opts?: { ascending?: boolean }) {
        if (column) sort = { column, ascending: opts?.ascending !== false };
        return api;
      },
      limit(n: number) { take = n; return api; },
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
vi.mock('../actions/_shared', () => ({
  requireCapability: async (capability: string) => {
    if (store.withheld === capability) throw new Error('That is not part of your access.');
    return store.actor;
  },
}));
vi.mock('../audit', () => ({
  logAdminAudit: async (_client: unknown, entry: Row) => {
    store.audit.push(entry);
  },
}));

import {
  editDiscordMessage,
  loadDiscordMessage,
  queueDiscordMessage,
  readDiscordOutbox,
} from '../actions/discord-message';
import { shouldPollOutbox, type OutboxRow } from '../discord-outbox';

const GUILD = '900000000000000001';
const ANNOUNCEMENTS = '800000000000000001';
const RESULTS = '800000000000000002';
const INTERNAL_ROLE = '111111111111111111';
const INTERNAL = `<@&${INTERNAL_ROLE}>`;
const POSTED_ID = '0117b0c0-0000-4000-8000-0000000000aa';
const DISCORD_MESSAGE = '999000111222333444';

const outbox = () => store.db.discord_outbox ?? [];

/** A row the bot has already posted, claim left behind and all. */
const postedRow = (over: Row = {}): Row => ({
  id: POSTED_ID,
  guild_id: GUILD,
  channel_id: ANNOUNCEMENTS,
  created_at: '2026-09-10T17:00:00.000Z',
  content: null,
  embed_title: 'Fees are due',
  embed_body: 'Pay before Friday.',
  embed_type: 'info',
  ping: false,
  attempts: 1,
  // THE SEND DOES NOT CLEAR THE CLAIM. The outbox route writes `sent_at` and
  // the message id and leaves `claimed_at` where it was, so every sent row on
  // production carries one. A fence of "claimed_at IS NULL" would therefore
  // refuse to edit anything at all, which is why this fixture keeps it.
  claimed_at: '2026-09-10T17:04:00.000Z',
  sent_at: '2026-09-10T17:05:00.000Z',
  failed_at: null,
  last_error: null,
  discord_message_id: DISCORD_MESSAGE,
  requested_by: store.actor.id,
  ...over,
});

beforeEach(() => {
  store.touched = [];
  store.audit = [];
  store.withheld = null;
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

// PHASE 1: an embed body resolves too, and unconditionally.
//
// This block replaces one that asserted the opposite. The old reasoning was
// that a chip inside an embed can never ring a phone, so a name is the honest
// thing to store; the answer to that is the ping line above the embed, which is
// where notifying now happens. Inside the embed a chip is what a reader can
// hover to see who is meant, and grey text is not.
describe('queueDiscordMessage: mentions inside an embed', () => {
  it('turns a role name in the body into a real mention', async () => {
    await queueDiscordMessage({
      embed: { title: 'Fees are due', body: 'This one is for @internal', type: 'info' },
    });

    expect(outbox()[0]!.embed_body).toBe(`This one is for ${INTERNAL}`);
    expect(store.touched).toContain('discord_guild_roles');
  });

  it('still spends no round trip when neither field has an @ in it', async () => {
    await queueDiscordMessage({
      embed: { title: 'Courts closed', body: 'The gym is booked.', type: 'urgent' },
    });

    expect(store.touched).not.toContain('discord_guild_roles');
  });

  it('resolves the body the same way whether or not anything is being pinged', async () => {
    await queueDiscordMessage({
      embed: { title: 'Fees are due', body: 'This one is for @internal', type: 'info' },
    });
    await queueDiscordMessage({
      embed: { title: 'Fees are due', body: 'This one is for @internal', type: 'info' },
      pingRoles: ['internal'],
    });

    // The body does not depend on the ping setting. What notifies is the line
    // above the embed, and that is a separate field.
    expect(outbox()[0]!.embed_body).toBe(outbox()[1]!.embed_body);
    expect(outbox()[0]!.ping).toBe(false);
    expect(outbox()[1]!.ping).toBe(true);
  });

  it('leaves a body that already holds a mention exactly as it is', async () => {
    // The property that makes editing and re-sending safe: the resolver
    // re-emits an existing `<@&id>` whole, so running it on its own output
    // moves nothing.
    await queueDiscordMessage({
      embed: { title: 'Fees are due', body: `This one is for ${INTERNAL}`, type: 'info' },
    });

    expect(outbox()[0]!.embed_body).toBe(`This one is for ${INTERNAL}`);
    // AND THE AUDIT SAYS NOTHING ABOUT ROLES, because nothing was substituted
    // this time round. `matched` names what this call rewrote, not what the
    // text already contained, and the entry written when those characters were
    // first put there is the one that names the role.
    expect(store.audit[0]!.new_value).not.toHaveProperty('mentioned_roles');
  });

  it('leaves ordinary prose alone', async () => {
    // The real payload here is a Code of Conduct, which will contain an email
    // address and a sentence about where to meet.
    const body = 'Email wkc10@sfu.ca, or meet @ the gym at seven.';
    await queueDiscordMessage({ embed: { title: 'Code of Conduct', body, type: 'info' } });

    expect(outbox()[0]!.embed_body).toBe(body);
  });

  it('refuses a body that only goes over the limit once the mention expands', async () => {
    // 4090 typed characters, which the first check lets through; the id costs
    // 13 more than the name, and the table's CHECK stops at 4096.
    const body = `${'x'.repeat(4080)} @internal`;
    expect(body).toHaveLength(4090);

    await expect(
      queueDiscordMessage({ embed: { title: 'Long one', body, type: 'info' } }),
    ).rejects.toThrow(/4103 characters/);
    await expect(
      queueDiscordMessage({ embed: { title: 'Long one', body, type: 'info' } }),
    ).rejects.toThrow(/4096/);

    expect(outbox()).toHaveLength(0);
  });

  it('audits the body it stored, not the body that was typed', async () => {
    await queueDiscordMessage({
      embed: { title: 'Fees are due', body: 'This one is for @internal', type: 'info' },
    });

    expect(store.audit[0]!.new_value).toMatchObject({
      embed_title: 'Fees are due',
      embed_body: `This one is for ${INTERNAL}`,
      mentioned_roles: ['internal'],
    });
  });
});

// PHASE 2: the line above the embed, which is the only thing that notifies.
describe('queueDiscordMessage: the ping line', () => {
  it('posts one row that is both a ping line and an embed', async () => {
    await queueDiscordMessage({
      embed: { title: 'Fees are due', body: 'Pay before Friday.', type: 'info' },
      pingRoles: ['internal'],
    });

    expect(outbox()).toHaveLength(1);
    const row = outbox()[0]!;
    // The trap this test exists for: `embed_body` and `embed_type` used to key
    // off `content`, which is now always set in this shape, and left that way
    // they would post a bare mention with no embed under it.
    expect(row.content).toBe(INTERNAL);
    expect(row.embed_title).toBe('Fees are due');
    expect(row.embed_body).toBe('Pay before Friday.');
    expect(row.embed_type).toBe('info');
  });

  it('derives the ping rather than believing what arrived', async () => {
    await queueDiscordMessage({
      embed: { title: 'Quiet notice', body: 'No ping here.', type: 'info' },
      pingRoles: [],
      ping: 'yes' as unknown as boolean,
    });
    await queueDiscordMessage({
      embed: { title: 'Loud notice', body: 'This one rings.', type: 'info' },
      pingRoles: ['internal'],
    });

    expect(outbox()[0]!.ping).toBe(false);
    expect(outbox()[1]!.ping).toBe(true);
  });

  it('writes no ping line when nothing was picked, which is the default', async () => {
    await queueDiscordMessage({
      embed: { title: 'Fees are due', body: 'Pay before Friday.', type: 'info' },
    });

    // NULL content is what keeps every row that existed before this feature a
    // legal shape, and it is what the bot's embed-only branch keys off.
    expect(outbox()[0]!.content).toBeNull();
    expect(outbox()[0]!.ping).toBe(false);
  });

  it('refuses a role the club does not manage, and queues nothing', async () => {
    await expect(
      queueDiscordMessage({
        embed: { title: 'Fees are due', body: 'Pay up.', type: 'info' },
        pingRoles: ['everyone'],
      }),
    ).rejects.toThrow(/not one of the roles the club manages/);

    // A dropped role would be a message that looks like it pings and rings
    // nobody, which is the failure this feature exists to remove.
    expect(outbox()).toHaveLength(0);
  });

  it('names the roles it aimed at in the audit entry', async () => {
    await queueDiscordMessage({
      embed: { title: 'Fees are due', body: 'Pay before Friday.', type: 'info' },
      pingRoles: ['Session Staff', 'internal'],
    });

    // The picker's spelling and the database's are the same role: `roleKey`
    // reads `Session Staff` and `session_staff` as one name.
    expect(store.audit[0]!.new_value).toMatchObject({
      ping: true,
      mentioned_roles: ['internal', 'session_staff'],
    });
  });

  it('refuses a ping line on a plain message rather than dropping it', async () => {
    // The composer never offers this combination, and a server action is an
    // HTTP endpoint that will be sent one anyway. A plain message already
    // notifies the roles named in its own text.
    await expect(
      queueDiscordMessage({ content: 'Fees are due', pingRoles: ['internal'] }),
    ).rejects.toThrow(/ping line/);

    expect(outbox()).toHaveLength(0);
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

// PHASE 3: changing a message Discord already has.
describe('editDiscordMessage', () => {
  it('puts a sent row back in the queue with the new words', async () => {
    store.db.discord_outbox = [postedRow()];

    await editDiscordMessage({
      id: POSTED_ID,
      embed: { title: 'Fees are due', body: 'Pay before Monday.', type: 'warning' },
    });

    const row = outbox()[0]!;
    expect(row.embed_body).toBe('Pay before Monday.');
    expect(row.embed_type).toBe('warning');
    // Back into the pending state, which is what makes the bot look again.
    expect(row.sent_at).toBeNull();
    expect(row.claimed_at).toBeNull();
    expect(row.failed_at).toBeNull();
    expect(row.last_error).toBeNull();
    expect(row.attempts).toBe(0);
    // And the two things that must survive: the message it edits, and where.
    expect(row.discord_message_id).toBe(DISCORD_MESSAGE);
    expect(row.channel_id).toBe(ANNOUNCEMENTS);
  });

  it('refuses a row Discord has never seen, and changes nothing', async () => {
    store.db.discord_outbox = [
      postedRow({ sent_at: null, claimed_at: null, discord_message_id: null }),
    ];

    await expect(
      editDiscordMessage({
        id: POSTED_ID,
        embed: { title: 'Fees are due', body: 'Pay before Monday.', type: 'info' },
      }),
    ).rejects.toThrow(/has not gone out yet/);

    expect(outbox()[0]!.embed_body).toBe('Pay before Friday.');
  });

  it('still edits a row that is waiting to go out again', async () => {
    // THE POINT OF GATING ON THE MESSAGE ID RATHER THAN ON `sent_at`. Saving an
    // edit clears `sent_at`, so this is what a row looks like for the five
    // minutes after the first correction. Refusing it here would strand
    // somebody who spotted a second typo.
    store.db.discord_outbox = [postedRow({ sent_at: null, claimed_at: null, attempts: 0 })];

    await editDiscordMessage({
      id: POSTED_ID,
      embed: { title: 'Fees are due', body: 'Pay before Tuesday.', type: 'info' },
    });

    expect(outbox()[0]!.embed_body).toBe('Pay before Tuesday.');
  });

  it('refuses while the bot is holding the row, rather than racing it', async () => {
    // Claimed a moment ago and not yet sent: the tick is mid-post. Writing the
    // new text now would have `sent_at` written over it by a process that
    // posted the old words, and the correction would vanish with nothing on
    // screen to say so.
    store.db.discord_outbox = [
      postedRow({ sent_at: null, claimed_at: new Date().toISOString() }),
    ];

    await expect(
      editDiscordMessage({
        id: POSTED_ID,
        embed: { title: 'Fees are due', body: 'Pay before Monday.', type: 'info' },
      }),
    ).rejects.toThrow(/being posted in Discord right now/);

    expect(outbox()[0]!.embed_body).toBe('Pay before Friday.');
  });

  it('will not turn a posted embed into a plain message', async () => {
    store.db.discord_outbox = [postedRow()];

    await expect(
      editDiscordMessage({ id: POSTED_ID, content: 'Fees are due on Monday.' }),
    ).rejects.toThrow(/cannot change between/);

    expect(outbox()[0]!.embed_title).toBe('Fees are due');
  });

  it('resolves role names in an edited body, which is how the chips arrive', async () => {
    // THE TEST THIS PHASE EXISTS FOR. A notice already in the channel gains its
    // chips in place, keeping its position and its permalink, and nobody is
    // notified again because a Discord edit never re-notifies.
    store.db.discord_outbox = [postedRow()];

    await editDiscordMessage({
      id: POSTED_ID,
      embed: { title: 'Fees are due', body: 'Ask @internal about fees.', type: 'info' },
    });

    expect(outbox()[0]!.embed_body).toBe(`Ask ${INTERNAL} about fees.`);
  });

  it('leaves the ping line alone', async () => {
    // The mentions above an embed are its `content`, and an edit that cleared
    // it would take the ping line off a message people can already read.
    store.db.discord_outbox = [postedRow({ content: INTERNAL, ping: true })];

    await editDiscordMessage({
      id: POSTED_ID,
      embed: { title: 'Fees are due', body: 'Pay before Monday.', type: 'info' },
    });

    expect(outbox()[0]!.content).toBe(INTERNAL);
    expect(outbox()[0]!.ping).toBe(true);
  });

  it('writes its own audit entry and leaves the first one standing', async () => {
    await queueDiscordMessage({
      embed: { title: 'Fees are due', body: 'Pay before Friday.', type: 'info' },
    });
    const queued = outbox()[0]!;
    // What the bot's write-back does to the row once Discord has it.
    Object.assign(queued, {
      sent_at: '2026-09-10T18:05:00.000Z',
      claimed_at: '2026-09-10T18:04:00.000Z',
      discord_message_id: DISCORD_MESSAGE,
    });

    await editDiscordMessage({
      id: queued.id as string,
      embed: { title: 'Fees are due', body: 'Pay before Monday.', type: 'info' },
    });

    expect(store.audit).toHaveLength(2);
    // The log is a history of what the club said and when it changed, so the
    // first entry still quotes the sentence that was in the channel.
    expect(store.audit[0]!.action_type).toBe('discord_message_queued');
    expect(store.audit[0]!.new_value).toMatchObject({ embed_body: 'Pay before Friday.' });
    expect(store.audit[1]!.action_type).toBe('discord_message_edited');
    expect(store.audit[1]!.target_id).toBe(queued.id);
    expect(store.audit[1]!.new_value).toMatchObject({
      embed_body: 'Pay before Monday.',
      discord_message_id: DISCORD_MESSAGE,
    });
  });

  it('refuses an id that is not one at all', async () => {
    await expect(
      editDiscordMessage({ id: 'o1', embed: { title: 'x', body: 'y', type: 'info' } }),
    ).rejects.toThrow(/record of/);
  });
});

describe('loadDiscordMessage', () => {
  it('hands back the resolved text, which is what the row actually holds', async () => {
    store.db.discord_outbox = [postedRow({ embed_body: `Ask ${INTERNAL} about fees.` })];

    const message = await loadDiscordMessage(POSTED_ID);

    // The exec sees an id where they typed a name. That is accepted for now,
    // and it is safe: saving it again re-emits the mention whole.
    expect(message.embedBody).toBe(`Ask ${INTERNAL} about fees.`);
    expect(message.embedTitle).toBe('Fees are due');
    expect(message.discordMessageId).toBe(DISCORD_MESSAGE);
  });

  it('needs the same key the composer does', async () => {
    store.withheld = 'announcements.discord.write';
    await expect(loadDiscordMessage(POSTED_ID)).rejects.toThrow(/access/);
  });
});

// PHASE 4: the list asks again by itself while something is queued.
describe('readDiscordOutbox', () => {
  it('returns the five newest rows in the shape the list renders', async () => {
    store.db.discord_outbox = [
      postedRow(),
      postedRow({
        id: '0117b0c0-0000-4000-8000-0000000000bb',
        created_at: '2026-09-10T18:00:00.000Z',
        embed_title: 'Courts closed',
        sent_at: null,
        claimed_at: null,
        discord_message_id: null,
      }),
    ];

    const rows = await readDiscordOutbox();

    expect(rows).toHaveLength(2);
    // Newest first, and the badge each row will draw.
    expect(rows[0]!.preview).toBe('Courts closed');
    expect(rows[0]!.state).toBe('queued');
    expect(rows[0]!.discordMessageId).toBeNull();
    expect(rows[1]!.state).toBe('sent');
    expect(rows[1]!.discordMessageId).toBe(DISCORD_MESSAGE);
  });

  it('shows the headline of a combined row, not its ping line', async () => {
    store.db.discord_outbox = [postedRow({ content: INTERNAL, ping: true })];

    const rows = await readDiscordOutbox();

    // A raw snowflake where the notice's own words belong would be worse than
    // the literal text this feature replaced.
    expect(rows[0]!.preview).toBe('Fees are due');
  });

  it('refuses a viewer without the Discord key', async () => {
    // The same gate the page puts around the read, because these are the same
    // rows: an action that answered here would be the way around that gate.
    store.withheld = 'announcements.discord.write';
    await expect(readDiscordOutbox()).rejects.toThrow(/access/);
  });
});

describe('shouldPollOutbox', () => {
  const row = (state: OutboxRow['state']): OutboxRow => ({
    id: `row-${state}`,
    createdAt: '2026-09-10T18:00:00.000Z',
    channelId: ANNOUNCEMENTS,
    preview: 'Fees are due',
    ping: false,
    state,
    error: null,
    discordMessageId: null,
  });

  it('asks again while a row is queued', () => {
    expect(shouldPollOutbox([row('sent'), row('queued')])).toBe(true);
  });

  it('runs no timer at all when everything has gone out', () => {
    // The normal state of this page, and it must cost nothing.
    expect(shouldPollOutbox([row('sent'), row('sent')])).toBe(false);
    expect(shouldPollOutbox([])).toBe(false);
  });

  it('stops once the last queued row turns sent', () => {
    const before = [row('queued'), row('sent')];
    expect(shouldPollOutbox(before)).toBe(true);

    const after = before.map((r) => ({ ...r, state: 'sent' as const }));
    expect(shouldPollOutbox(after)).toBe(false);
  });

  it('does not keep asking about a row that failed', () => {
    // A failed row changes only when somebody acts on it, so there is nothing
    // a poll could learn.
    expect(shouldPollOutbox([row('failed')])).toBe(false);
  });
});
