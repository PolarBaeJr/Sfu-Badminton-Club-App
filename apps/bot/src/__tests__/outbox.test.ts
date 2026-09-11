import { describe, it, expect, vi, beforeEach } from 'vitest';

// The console's half of /say (00222). Four properties:
//
//  1. POST FIRST, RECORD SECOND — a crash between them is a duplicate somebody
//     mentions, not a club message that silently never went out.
//  2. THE DEFAULT IS SILENCE. A message with ping off must reach Discord with
//     an empty allowed_mentions.parse, so an @everyone typed into the text
//     reads as a mention and buzzes nobody.
//  3. A REFUSAL IS RECORDED, not swallowed. The reason is the only thing that
//     will get a missing permission fixed.
//  4. A FAILURE IN ONE MESSAGE DOES NOT ABORT THE REST.
//  5. EVERY SEND IS AUDITED, naming who asked. This is the property the whole
//     feature turns on: /say writes an audit entry because a bot that speaks
//     for the club with no record of who moved its mouth is the thing worth
//     not building, and a console that could do it silently would be the back
//     door around that. The console panel TELLS the sender this happens, so a
//     regression here also makes the UI lie.

const claimOutboxMessages = vi.fn();
const recordOutboxResult = vi.fn();
const postMessage = vi.fn();
const postMessageResult = vi.fn();
const editMessage = vi.fn();
const createMessage = vi.fn();
const loadConfig = vi.fn();

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  claimOutboxMessages,
  recordOutboxResult,
}));
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  loadConfig,
}));
vi.mock('../discord-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../discord-api.js')>()),
  DiscordApi: class {
    postMessage = postMessage;
    // The one method that tells a 4xx from a maybe, which is what decides
    // whether the buttons fallback is allowed to retry at all.
    postMessageResult = postMessageResult;
    editMessage = editMessage;
    createMessage = createMessage;
  },
}));

const MESSAGE = {
  id: 'o1',
  channelId: 'c1',
  content: 'Doors open at seven tonight.',
  embed: null,
  ping: false,
  attempts: 0,
  // Null is every message that has never been posted, which is every message
  // this file tested before editing existed.
  discordMessageId: null as string | null,
  requestedBy: 'Priya Raman',
  // Null is every row written before 00227, and every row written since that
  // did not ask for the buttons.
  buttonSet: null as string | null,
};

/** The embed the console queues, and the colour the club pins for `urgent`. */
const EMBED = { title: 'Courts closed', body: 'Gym booked.', type: 'urgent' };
const INTERNAL = '<@&111111111111111111>';

/** The audit embed the run wrote, or undefined. */
function auditEmbed(): { title: string; description: string; footer?: { text: string } } | undefined {
  const call = createMessage.mock.calls[0] as
    | [string, { embeds: { title: string; description: string; footer?: { text: string } }[] }]
    | undefined;
  return call?.[1].embeds[0];
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.DISCORD_BOT_TOKEN = 'bot-token';
  loadConfig.mockResolvedValue({ registry: new Map([['g1', {}]]), auditChannelId: 'audit-1' });
  createMessage.mockResolvedValue(true);
  claimOutboxMessages.mockResolvedValue({ messages: [MESSAGE] });
  postMessage.mockResolvedValue('m1');
  // `vi.resetAllMocks()` above clears return values as well as calls, so every
  // mock needs its default here or an edit resolves undefined and reads as a
  // refusal.
  postMessageResult.mockResolvedValue({ id: 'm1' });
  editMessage.mockResolvedValue('ok');
  recordOutboxResult.mockResolvedValue({ ok: true });
});

describe('runOutbox', () => {
  it('posts, then records the message id Discord gave back', async () => {
    const { runOutbox } = await import('../outbox.js');
    const result = await runOutbox();

    expect(postMessage).toHaveBeenCalledWith('c1', expect.objectContaining({ content: MESSAGE.content }));
    expect(recordOutboxResult).toHaveBeenCalledWith({ id: 'o1', discordMessageId: 'm1' });
    expect(result).toEqual({ sent: 1, failed: 0 });

    // The order is the whole property: a record before the post would mark a
    // message sent that nobody ever saw.
    expect(postMessage.mock.invocationCallOrder[0]).toBeLessThan(
      recordOutboxResult.mock.invocationCallOrder[0] as number,
    );
  });

  it('MENTIONS NOBODY unless the sender asked', async () => {
    const { runOutbox } = await import('../outbox.js');
    await runOutbox();
    expect((postMessage.mock.calls[0]?.[1] as { allowed_mentions: { parse: string[] } })
      .allowed_mentions.parse).toEqual([]);

    postMessage.mockClear();
    claimOutboxMessages.mockResolvedValue({ messages: [{ ...MESSAGE, ping: true }] });
    await runOutbox();
    expect((postMessage.mock.calls[0]?.[1] as { allowed_mentions: { parse: string[] } })
      .allowed_mentions.parse).toEqual(['users', 'roles', 'everyone']);
  });

  it('sends an embed with no content field at all', async () => {
    // Belt and braces with allowed_mentions: with no content, there is nothing
    // for Discord to parse a mention out of in the first place.
    claimOutboxMessages.mockResolvedValue({
      messages: [
        {
          ...MESSAGE,
          content: null,
          embed: { title: 'Courts closed', body: 'Gym booked.', type: 'urgent' },
        },
      ],
    });
    const { runOutbox } = await import('../outbox.js');
    await runOutbox();

    const payload = postMessage.mock.calls[0]?.[1] as {
      content?: string;
      embeds: { title: string; color: number }[];
    };
    expect(payload.content).toBeUndefined();
    expect(payload.embeds[0]?.title).toBe('Courts closed');
    // The same literal the shared module and the announcement relay pin.
    expect(payload.embeds[0]?.color).toBe(0xe74c3c);
  });

  it('sends an embed with NOTHING added to it, byte for byte', async () => {
    // THE REGRESSION GUARD THAT MATTERS MOST, and it is `toEqual` rather than
    // `objectContaining` on purpose: the property being protected is that no
    // key was ADDED, and a partial match cannot see an extra `roles` beside
    // `parse`. Every embed the club has ever queued goes down this branch.
    claimOutboxMessages.mockResolvedValue({
      messages: [{ ...MESSAGE, content: null, embed: EMBED }],
    });
    const { runOutbox } = await import('../outbox.js');
    await runOutbox();

    expect(postMessage.mock.calls[0]?.[1]).toEqual({
      embeds: [{ title: 'Courts closed', description: 'Gym booked.', color: 0xe74c3c }],
      allowed_mentions: { parse: [] },
    });
  });

  it('puts the ping line above the embed, in one message', async () => {
    // The only shape that both looks like a notice and reaches a phone:
    // `content` renders ABOVE the embed, and it is the only field Discord will
    // notify from. There is no second message and nothing posts below.
    claimOutboxMessages.mockResolvedValue({
      messages: [{ ...MESSAGE, content: INTERNAL, embed: EMBED, ping: true }],
    });
    const { runOutbox } = await import('../outbox.js');
    await runOutbox();

    expect(postMessage).toHaveBeenCalledTimes(1);
    const payload = postMessage.mock.calls[0]?.[1] as {
      content: string;
      embeds: { title: string }[];
      allowed_mentions: { parse: string[]; roles?: string[] };
    };
    expect(payload.content).toBe(INTERNAL);
    expect(payload.embeds[0]?.title).toBe('Courts closed');
    // Named roles and nothing else. An explicit `roles` array beside a
    // non-empty `parse` is a Discord API error.
    expect(payload.allowed_mentions).toEqual({ parse: [], roles: ['111111111111111111'] });
  });

  it('CANNOT REACH @everyone through the ping line', async () => {
    // Typed into the line by hand, on a row whose ping is on. It renders as a
    // mention and rings nobody, because `parse` stays empty and only the ids
    // the console resolved are ever named.
    claimOutboxMessages.mockResolvedValue({
      messages: [
        { ...MESSAGE, content: `@everyone ${INTERNAL}`, embed: EMBED, ping: true },
      ],
    });
    const { runOutbox } = await import('../outbox.js');
    await runOutbox();

    expect(
      (postMessage.mock.calls[0]?.[1] as { allowed_mentions: unknown }).allowed_mentions,
    ).toEqual({ parse: [], roles: ['111111111111111111'] });
  });

  it('names no roles at all on a combined row whose ping is off', async () => {
    claimOutboxMessages.mockResolvedValue({
      messages: [{ ...MESSAGE, content: INTERNAL, embed: EMBED, ping: false }],
    });
    const { runOutbox } = await import('../outbox.js');
    await runOutbox();

    expect(
      (postMessage.mock.calls[0]?.[1] as { allowed_mentions: unknown }).allowed_mentions,
    ).toEqual({ parse: [] });
  });

  it('posts a message Discord has never seen, and never edits it', async () => {
    // The regression guard for every row that exists today: no message id
    // means no edit, whatever else is on the row.
    const { runOutbox } = await import('../outbox.js');
    await runOutbox();

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(editMessage).not.toHaveBeenCalled();
  });

  it('edits the message a re-queued row already is', async () => {
    // An edit keeps the message's place in the channel, its permalink and its
    // replies, and notifies nobody again. Posting here would leave the club
    // saying the same thing twice, the wrong version first.
    claimOutboxMessages.mockResolvedValue({
      messages: [{ ...MESSAGE, content: 'Doors open at eight.', discordMessageId: 'm1' }],
    });
    const { runOutbox } = await import('../outbox.js');
    expect(await runOutbox()).toEqual({ sent: 1, failed: 0 });

    expect(editMessage).toHaveBeenCalledWith(
      'c1',
      'm1',
      expect.objectContaining({ content: 'Doors open at eight.' }),
    );
    expect(postMessage).not.toHaveBeenCalled();
    // The row still has to be closed, or the next tick edits it all over again
    // every five minutes for as long as it exists.
    expect(recordOutboxResult).toHaveBeenCalledWith({ id: 'o1', discordMessageId: 'm1' });
  });

  it('REFUSES to repost a message somebody deleted', async () => {
    // The dangerous path. A 404 on the PATCH means an exec removed the message
    // on purpose, and quietly putting it back is the worst thing this file
    // could do.
    editMessage.mockResolvedValue('gone');
    claimOutboxMessages.mockResolvedValue({
      messages: [{ ...MESSAGE, discordMessageId: 'm1' }],
    });
    const { runOutbox } = await import('../outbox.js');
    expect(await runOutbox()).toEqual({ sent: 0, failed: 1 });

    // Asserted explicitly, because the absence is the property.
    expect(postMessage).not.toHaveBeenCalled();
    const [call] = recordOutboxResult.mock.calls as [[{ id: string; error: string }]];
    expect(call[0].error).toMatch(/gone from Discord/);
    expect(call[0]).not.toHaveProperty('discordMessageId');
    // Nothing was said, so there is nothing to attribute.
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('records a refused edit with a reason and spends an attempt', async () => {
    editMessage.mockResolvedValue('failed');
    claimOutboxMessages.mockResolvedValue({
      messages: [{ ...MESSAGE, discordMessageId: 'm1' }],
    });
    const { runOutbox } = await import('../outbox.js');
    expect(await runOutbox()).toEqual({ sent: 0, failed: 1 });

    const [call] = recordOutboxResult.mock.calls as [[{ id: string; error: string }]];
    expect(call[0].error).toMatch(/channel/i);
  });

  it('records a refusal with a reason rather than dropping it', async () => {
    postMessage.mockResolvedValue(null);
    const { runOutbox } = await import('../outbox.js');
    const result = await runOutbox();

    expect(result).toEqual({ sent: 0, failed: 1 });
    const [call] = recordOutboxResult.mock.calls as [[{ id: string; error: string }]];
    expect(call[0].id).toBe('o1');
    // Names the channel as the thing to check — the reason a person can act on.
    expect(call[0].error).toMatch(/channel/i);
    // NEVER recorded as sent.
    expect(call[0]).not.toHaveProperty('discordMessageId');
  });

  it('carries on with the rest when one message is refused', async () => {
    claimOutboxMessages.mockResolvedValue({
      messages: [MESSAGE, { ...MESSAGE, id: 'o2' }],
    });
    postMessage.mockResolvedValueOnce(null).mockResolvedValueOnce('m2');

    const { runOutbox } = await import('../outbox.js');
    expect(await runOutbox()).toEqual({ sent: 1, failed: 1 });
  });

  it('does not abort a guild because the claim failed', async () => {
    claimOutboxMessages.mockRejectedValue(new Error('503'));
    const { runOutbox } = await import('../outbox.js');
    // Counted, not thrown: a claim that never happened costs nothing, and the
    // rows are still pending for the next tick.
    expect(await runOutbox()).toEqual({ sent: 0, failed: 1 });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('posts nothing at all without a token', async () => {
    delete process.env.DISCORD_BOT_TOKEN;
    const { runOutbox } = await import('../outbox.js');
    expect(await runOutbox()).toEqual({ sent: 0, failed: 0 });
    expect(claimOutboxMessages).not.toHaveBeenCalled();
  });

  it('writes an audit entry naming who asked and quoting what was said', async () => {
    const { runOutbox } = await import('../outbox.js');
    await runOutbox();

    expect(createMessage).toHaveBeenCalledWith('audit-1', expect.anything());
    const embed = auditEmbed();
    expect(embed?.title).toBe('Message posted as the club');
    expect(embed?.description).toContain('Priya Raman');
    expect(embed?.description).toContain('Doors open at seven tonight.');
    // Which door, because "who asked" and "how" are different questions.
    expect(embed?.footer?.text).toMatch(/console/i);
  });

  it('still writes an entry when the app could not name the requester', async () => {
    // A deleted exec sets requested_by to NULL (00222, ON DELETE SET NULL). An
    // entry that says "someone" is still an entry; skipping it would mean the
    // one case where attribution is already lost also loses the record.
    claimOutboxMessages.mockResolvedValue({ messages: [{ ...MESSAGE, requestedBy: null }] });
    const { runOutbox } = await import('../outbox.js');
    await runOutbox();
    expect(auditEmbed()?.description).toMatch(/someone/i);
  });

  it('quotes an embed message as its title and body, not as an empty line', async () => {
    claimOutboxMessages.mockResolvedValue({
      messages: [
        {
          ...MESSAGE,
          content: null,
          embed: { title: 'Courts closed', body: 'Gym booked.', type: 'urgent' },
        },
      ],
    });
    const { runOutbox } = await import('../outbox.js');
    await runOutbox();

    const description = auditEmbed()?.description ?? '';
    expect(description).toContain('Courts closed');
    expect(description).toContain('Gym booked.');
  });

  it('does not audit a message Discord refused', async () => {
    // Nothing was said, so there is nothing to attribute. An entry here would
    // put a message in the audit channel that no member ever saw.
    postMessage.mockResolvedValue(null);
    const { runOutbox } = await import('../outbox.js');
    await runOutbox();
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('counts the send even when the audit entry cannot be written', async () => {
    // The message is in the channel. Failing to record it must not report the
    // send as failed and hand the row back for a second post.
    createMessage.mockRejectedValue(new Error('missing access'));
    const { runOutbox } = await import('../outbox.js');
    expect(await runOutbox()).toEqual({ sent: 1, failed: 0 });
    expect(recordOutboxResult).toHaveBeenCalledWith({ id: 'o1', discordMessageId: 'm1' });
  });
});

// THE MEMBER BUTTONS ON A CONSOLE MESSAGE (00227). Three properties, and the
// first is the one every existing row depends on:
//
//   1. A ROW WITH NO SET IS UNCHANGED, with no `components` key at all. Every
//      message the club has ever queued goes down that path.
//   2. THE BUTTONS ARE CLICKABLE ONES. custom_id buttons, never style 5: a
//      style 5 button carries a url instead, which on this path would mean
//      publishing a minted single-use token to a channel every member reads.
//      guide.test.ts pins the same property for the interaction path.
//   3. THE WORDS SURVIVE A DISCORD THAT REFUSES THE BUTTONS, and a message is
//      never posted twice to find that out. Nothing has ever proved in
//      production that a bot-posted message here is accepted with components.
describe('runOutbox: the member buttons', () => {
  /** The row an exec queued with the buttons switch on. */
  const WITH_BUTTONS = { ...MESSAGE, buttonSet: 'guide' };

  /** Every button in one payload, flattened out of its action rows. */
  function buttonsIn(payload: unknown) {
    const rows = (payload as { components?: { type: number; components: unknown[] }[] }).components;
    return (rows ?? []).flatMap((row) => row.components) as {
      type: number;
      style: number;
      label: string;
      custom_id?: string;
      url?: string;
    }[];
  }

  it('posts one action row of three clickable buttons', async () => {
    claimOutboxMessages.mockResolvedValue({ messages: [WITH_BUTTONS] });
    const { runOutbox } = await import('../outbox.js');
    expect(await runOutbox()).toEqual({ sent: 1, failed: 0 });

    const payload = postMessageResult.mock.calls[0]?.[1];
    const rows = (payload as { components: unknown[] }).components;
    expect(rows).toHaveLength(1);

    const buttons = buttonsIn(payload);
    expect(buttons.map((b) => b.custom_id)).toEqual([
      'guide:link',
      'guide:bug',
      'guide:feedback',
    ]);
    for (const button of buttons) {
      // A style 5 button renders happily, emits no interaction and needs a url.
      expect(button.style).not.toBe(5);
      expect(button.url).toBeUndefined();
      expect(typeof button.custom_id).toBe('string');
    }
  });

  it('adds NO components key at all to a row that asked for none', async () => {
    // THE REGRESSION GUARD FOR THE EXISTING PATH, and `toEqual` is the point:
    // `objectContaining` cannot see a key that was added.
    const { runOutbox } = await import('../outbox.js');
    await runOutbox();

    expect(postMessage.mock.calls[0]?.[1]).toEqual({
      content: MESSAGE.content,
      allowed_mentions: { parse: [] },
    });
    // And it never went near the method the fallback needs.
    expect(postMessageResult).not.toHaveBeenCalled();
  });

  it('posts the words without the buttons when Discord refuses them', async () => {
    // 'refused' is a 4xx, so nothing was created and one retry is safe.
    postMessageResult.mockResolvedValueOnce('refused').mockResolvedValueOnce({ id: 'm1' });
    claimOutboxMessages.mockResolvedValue({ messages: [WITH_BUTTONS] });
    const { runOutbox } = await import('../outbox.js');
    expect(await runOutbox()).toEqual({ sent: 1, failed: 0 });

    expect(postMessageResult).toHaveBeenCalledTimes(2);
    expect(buttonsIn(postMessageResult.mock.calls[0]?.[1])).toHaveLength(3);
    expect(postMessageResult.mock.calls[1]?.[1]).not.toHaveProperty('components');

    // Recorded as SENT, because it was, with the note that says what is missing.
    const recorded = recordOutboxResult.mock.calls[0]?.[0] as {
      discordMessageId?: string;
      note?: string;
    };
    expect(recorded.discordMessageId).toBe('m1');
    expect(recorded.note).toMatch(/without them/);
  });

  it('NEVER retries an unknown outcome, whatever it costs', async () => {
    // THE ONE THAT MATTERS. A 5xx or a thrown fetch may already have landed the
    // message, and retrying it is how the club says the same thing twice in a
    // channel every member reads. So it is recorded as a failure and the next
    // tick is where it is tried again, with an attempt spent.
    postMessageResult.mockResolvedValue('unknown');
    claimOutboxMessages.mockResolvedValue({ messages: [WITH_BUTTONS] });
    const { runOutbox } = await import('../outbox.js');
    expect(await runOutbox()).toEqual({ sent: 0, failed: 1 });

    expect(postMessageResult).toHaveBeenCalledTimes(1);
    expect(postMessage).not.toHaveBeenCalled();
    const [call] = recordOutboxResult.mock.calls as [[{ error: string }]];
    expect(call[0].error).toMatch(/channel/i);
    expect(call[0]).not.toHaveProperty('discordMessageId');
    // Nothing is known to have been said, so nothing is attributed.
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('sends the buttons on the PATCH that adds them to a posted message', async () => {
    // How the six guide messages already in the channel gain their buttons:
    // an edit in place, keeping their position, permalink and replies.
    claimOutboxMessages.mockResolvedValue({
      messages: [{ ...WITH_BUTTONS, discordMessageId: 'm1' }],
    });
    const { runOutbox } = await import('../outbox.js');
    expect(await runOutbox()).toEqual({ sent: 1, failed: 0 });

    expect(buttonsIn(editMessage.mock.calls[0]?.[2])).toHaveLength(3);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('retries a refused edit without the buttons, because a PATCH cannot duplicate', async () => {
    editMessage.mockResolvedValueOnce('failed').mockResolvedValueOnce('ok');
    claimOutboxMessages.mockResolvedValue({
      messages: [{ ...WITH_BUTTONS, discordMessageId: 'm1' }],
    });
    const { runOutbox } = await import('../outbox.js');
    expect(await runOutbox()).toEqual({ sent: 1, failed: 0 });

    expect(editMessage).toHaveBeenCalledTimes(2);
    expect(editMessage.mock.calls[1]?.[2]).not.toHaveProperty('components');
    const recorded = recordOutboxResult.mock.calls[0]?.[0] as {
      discordMessageId?: string;
      note?: string;
    };
    expect(recorded.discordMessageId).toBe('m1');
    expect(recorded.note).toMatch(/without them/);
  });

  it('still refuses to repost a message somebody deleted', async () => {
    // 'gone' is a 404, which means an exec removed the message on purpose. The
    // buttons fallback must not turn that into a second attempt of any kind.
    editMessage.mockResolvedValue('gone');
    claimOutboxMessages.mockResolvedValue({
      messages: [{ ...WITH_BUTTONS, discordMessageId: 'm1' }],
    });
    const { runOutbox } = await import('../outbox.js');
    expect(await runOutbox()).toEqual({ sent: 0, failed: 1 });

    expect(editMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).not.toHaveBeenCalled();
    expect(postMessageResult).not.toHaveBeenCalled();
    const [call] = recordOutboxResult.mock.calls as [[{ error: string }]];
    expect(call[0].error).toMatch(/gone from Discord/);
  });

  it('posts one button for a set that names one task', async () => {
    // EACH CLUB GUIDE IS ABOUT ONE TASK (00228), so the message about connecting
    // an account carries that button and not the bug form. It is the SAME button
    // the three-button row holds, ids included, which is why no handler had to
    // be added for it.
    claimOutboxMessages.mockResolvedValue({ messages: [{ ...MESSAGE, buttonSet: 'link' }] });
    const { runOutbox } = await import('../outbox.js');
    expect(await runOutbox()).toEqual({ sent: 1, failed: 0 });

    const payload = postMessageResult.mock.calls[0]?.[1];
    expect((payload as { components: unknown[] }).components).toHaveLength(1);

    const buttons = buttonsIn(payload);
    expect(buttons.map((b) => b.custom_id)).toEqual(['guide:link']);
    expect(buttons[0]!.style).not.toBe(5);
    expect(buttons[0]!.url).toBeUndefined();
  });

  it('posts a set name it has never heard of with no buttons, rather than failing', async () => {
    // OLD IMAGE, NEW ROW. A console that learns a second set name before the
    // bot image does must not cost the club a message: the row loses its buttons
    // and still posts its words, down the unchanged path.
    claimOutboxMessages.mockResolvedValue({
      messages: [{ ...MESSAGE, buttonSet: 'rolepicker' }],
    });
    const { runOutbox } = await import('../outbox.js');
    expect(await runOutbox()).toEqual({ sent: 1, failed: 0 });

    expect(postMessage.mock.calls[0]?.[1]).not.toHaveProperty('components');
    expect(recordOutboxResult).toHaveBeenCalledWith({ id: 'o1', discordMessageId: 'm1' });
  });
});
